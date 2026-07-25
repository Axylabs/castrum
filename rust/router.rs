use crate::util::{should_parallelize, total_bytes, unpack};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;

struct ByteNode {
    static_children: Vec<(Vec<u8>, ByteNode)>,
    param_child: Option<Box<ByteNode>>,
    wildcard_child: Option<Box<ByteNode>>,
    route: Option<u32>,
}

impl ByteNode {
    fn new() -> Self {
        Self {
            static_children: Vec::new(),
            param_child: None,
            wildcard_child: None,
            route: None,
        }
    }
}

/// Byte-oriented HTTP router.
///
/// Unlike `matchit`, this router matches raw bytes and does not require
/// UTF-8 validation on the lookup hot path.
#[napi]
pub struct HttpRouter {
    root: ByteNode,
}

fn insert_route(root: &mut ByteNode, route: &[u8], index: u32) -> Result<()> {
    let path = route.strip_prefix(&b"/"[..]).unwrap_or(route);

    let mut node = root;

    if path.is_empty() {
        if node.route.is_some() {
            return Err(Error::from_reason(format!(
                "duplicate route: {}",
                String::from_utf8_lossy(route)
            )));
        }

        node.route = Some(index);
        return Ok(());
    }

    for segment in path.split(|&b| b == b'/') {
        if segment.is_empty() {
            continue;
        }

        if segment.starts_with(b":") {
            node = node
                .param_child
                .get_or_insert_with(|| Box::new(ByteNode::new()))
                .as_mut();
        } else if segment.starts_with(b"*") {
            node = node
                .wildcard_child
                .get_or_insert_with(|| Box::new(ByteNode::new()))
                .as_mut();
        } else {
            if let Some(pos) = node
                .static_children
                .iter()
                .position(|(s, _)| s.as_slice() == segment)
            {
                node = &mut node.static_children[pos].1;
            } else {
                node.static_children
                    .push((segment.to_vec(), ByteNode::new()));
                let idx = node.static_children.len() - 1;
                node = &mut node.static_children[idx].1;
            }
        }
    }

    if node.route.is_some() {
        return Err(Error::from_reason(format!(
            "duplicate route: {}",
            String::from_utf8_lossy(route)
        )));
    }

    node.route = Some(index);

    Ok(())
}

fn match_node<'a>(node: &'a ByteNode, path: &[u8]) -> Option<u32> {
    let path = path.strip_prefix(&b"/"[..]).unwrap_or(path);

    if path.is_empty() {
        return node.route;
    }

    let seg_end = memchr::memchr(b'/', path).unwrap_or(path.len());

    let segment = &path[..seg_end];

    let rest = if seg_end == path.len() {
        &[]
    } else {
        &path[seg_end + 1..]
    };

    if segment.is_empty() {
        return match_node(node, rest);
    }

    // Static routes have priority over param routes.
    for (static_segment, child) in &node.static_children {
        if static_segment.as_slice() == segment {
            if let Some(route) = match_node(child, rest) {
                return Some(route);
            }
        }
    }

    if let Some(child) = &node.param_child {
        if let Some(route) = match_node(child, rest) {
            return Some(route);
        }
    }

    if let Some(child) = &node.wildcard_child {
        if let Some(route) = child.route {
            return Some(route);
        }
    }

    None
}

#[napi]
impl HttpRouter {
    #[napi(constructor)]
    pub fn new(routes: Vec<String>) -> Result<Self> {
        let mut root = ByteNode::new();

        for (i, route) in routes.iter().enumerate() {
            insert_route(&mut root, route.as_bytes(), i as u32)?;
        }

        Ok(Self { root })
    }

    #[inline]
    fn match_bytes(&self, path: &[u8]) -> i32 {
        match match_node(&self.root, path) {
            Some(idx) => idx as i32,
            None => -1,
        }
    }

    /// Accepts either a JS string or raw bytes.
    ///
    /// In Bun HTTP handlers, prefer passing the pathname string directly:
    ///
    ///   const path = new URL(req.url).pathname
    ///   const idx = router.matchRoute(path)
    ///
    /// This avoids `Buffer.from(path)`.
    #[napi]
    pub fn match_route(&self, path: Either<String, Uint8Array>) -> i32 {
        match path {
            Either::A(s) => self.match_bytes(s.as_bytes()),
            Either::B(b) => self.match_bytes(b.as_ref()),
        }
    }

    /// Packed batch route matching.
    ///
    /// Input format:
    ///   [u32 count]
    ///   repeated:
    ///     [u32 path_len]
    ///     [path bytes]
    ///
    /// Output format:
    ///   [u32 count]
    ///   repeated:
    ///     [i32 route_index_or_-1]
    #[napi]
    pub fn match_route_batch_packed(&self, packed: Uint8Array) -> Result<Buffer> {
        let items = unpack(packed.as_ref())?;

        let matches: Vec<i32> = if should_parallelize(items.len(), total_bytes(&items)) {
            items
                .par_iter()
                .map(|path_bytes| self.match_bytes(path_bytes))
                .collect()
        } else {
            items
                .iter()
                .map(|path_bytes| self.match_bytes(path_bytes))
                .collect()
        };

        let mut out = Vec::with_capacity(4 + matches.len() * 4);

        out.extend_from_slice(&(matches.len() as u32).to_le_bytes());

        for m in matches {
            out.extend_from_slice(&m.to_le_bytes());
        }

        Ok(Buffer::from(out))
    }
}
