// rust/json/fast_schema/capture.rs — One-pass derive: capture scalar values at
// JSON-pointer paths DURING the same validation walk (no second pass, no DOM).
//
// The `SchemaValidator.derive` napi entry (json_schema.rs) uses this to power
// "validate + extract" routes: the response is derived from a handful of body
// fields (e.g. `/api/orders` needs `lineItems.length` + `totalCents`), so
// Rust validates the schema AND captures those values in a single zero-DOM
// pass — replacing `JSON.parse` (DOM build + GC) + Ajv entirely on the happy
// path, and rejecting invalid bodies in microseconds.
//
// Capture is OFF by default (`Ctx::capture == None`): the bool/detailed hot
// paths are byte-for-byte unchanged. When active, `Capture` records, per
// target path, either the raw byte range of a scalar value (`Value`) or the
// element count of an array (`Length`, path terminal `/-`).
//
// Safety: capture fires only on the ROOT walk. Combinator / pattern / enum
// re-scans create fresh Cursors over sub-slices, and `Ctx` compares the
// cursor's data pointer against the root input pointer, so sub-scan offsets
// (which are relative to a sub-slice, not the input) can never corrupt
// captured ranges. `with_suppressed` branch checks are also excluded.

use std::collections::HashMap;

/// What to capture at a target path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaptureKind {
    /// The raw scalar value at the path (string / number / bool / null).
    Value,
    /// The element count of the ARRAY at the path (path terminal `/-`).
    Length,
}

/// A single target: an object-key path (no array-index steps) + a capture kind.
#[derive(Clone, Debug)]
pub struct TargetPath {
    pub steps: Vec<Vec<u8>>,
    pub kind: CaptureKind,
}

/// Parse an RFC 6901 JSON pointer into a `TargetPath`.
///
/// `"/totalCents"` → `Value` at steps `["totalCents"]`.
/// `"/lineItems/-"` → `Length` at steps `["lineItems"]`.
/// `"/"` (root) or a pointer with array-index steps → `None`.
pub fn parse_target(pointer: &str) -> Option<TargetPath> {
    if pointer.is_empty() || !pointer.starts_with('/') {
        return None;
    }
    let raw_tokens: Vec<&str> = pointer[1..].split('/').collect();
    if raw_tokens.is_empty() || raw_tokens[0].is_empty() {
        // "/" root or "//" empty first key — unsupported.
        return None;
    }
    let last = raw_tokens[raw_tokens.len() - 1];
    let (kind, body) = if last == "-" {
        (CaptureKind::Length, &raw_tokens[..raw_tokens.len() - 1])
    } else {
        (CaptureKind::Value, &raw_tokens[..])
    };
    if body.is_empty() {
        // A bare "-" ("/-") or a root-length target — unsupported.
        return None;
    }
    let mut steps = Vec::with_capacity(body.len());
    for tok in body {
        // Array-index steps are unsupported: a token that is `-` or all ASCII
        // digits is treated as an array index (JSON-pointer convention) and
        // rejected. (A rare all-digit OBJECT key is thereby excluded too.)
        let is_index = !tok.is_empty() && (*tok == "-" || tok.bytes().all(|b| b.is_ascii_digit()));
        if is_index {
            return None;
        }
        // Decode JSON-pointer escapes: ~1 -> '/', ~0 -> '~'.
        let mut step = Vec::with_capacity(tok.len());
        let bytes = tok.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'~' && i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'1' => step.push(b'/'),
                    b'0' => step.push(b'~'),
                    _ => step.push(bytes[i]),
                }
                i += 2;
            } else {
                step.push(bytes[i]);
                i += 1;
            }
        }
        steps.push(step);
    }
    Some(TargetPath { steps, kind })
}

/// One trie node. `children` maps an object key to the next node; `value_target`
/// / `length_target` are set when this node is the terminal of a `Value` /
/// `Length` target.
struct TrieNode {
    children: HashMap<Box<[u8]>, usize>,
    value_target: Option<usize>,
    length_target: Option<usize>,
}

impl TrieNode {
    fn new() -> Self {
        Self {
            children: HashMap::new(),
            value_target: None,
            length_target: None,
        }
    }
}

/// In-progress capture state, threaded through `Ctx` during one validation walk.
///
/// Targets are compiled into a trie once per call; during the walk the active
/// node is tracked by `(node, alive)` pairs pushed/popped per OBJECT nesting
/// level — NO per-member key cloning (the detailed-error path stack is
/// untouched), so capture overhead on a valid 5000-item document is a few hash
/// lookups per member, not allocations. Dead subtrees (no remaining target
/// key) cost nothing.
pub struct Capture {
    arena: Vec<TrieNode>,
    /// Active trie-node stack: `(node_idx, alive)` per object nesting level.
    stack: Vec<(usize, bool)>,
    matched: Vec<bool>,
    /// per-target captured raw value byte ranges (Value targets only)
    ranges: Vec<(usize, usize)>,
    /// per-target array lengths (Length targets only)
    lengths: Vec<usize>,
}

impl Capture {
    pub fn new(targets: Vec<TargetPath>) -> Self {
        let n = targets.len();
        let mut arena = vec![TrieNode::new()]; // node 0 = root
        for (ti, t) in targets.iter().enumerate() {
            let mut node = 0usize;
            for step in &t.steps {
                let key: Box<[u8]> = step.clone().into_boxed_slice();
                let next = match arena[node].children.get(&key) {
                    Some(&idx) => idx,
                    None => {
                        let idx = arena.len();
                        arena.push(TrieNode::new());
                        arena[node].children.insert(key, idx);
                        idx
                    }
                };
                node = next;
            }
            match t.kind {
                CaptureKind::Value => arena[node].value_target = Some(ti),
                CaptureKind::Length => arena[node].length_target = Some(ti),
            }
        }
        Self {
            arena,
            stack: vec![(0, true)],
            matched: vec![false; n],
            ranges: vec![(0, 0); n],
            lengths: vec![0; n],
        }
    }

    /// Descend the trie for an object member key. Returns false when the
    /// subtree is dead (no target can match below).
    #[inline]
    pub fn enter_key(&mut self, key: &[u8]) -> bool {
        let (node, alive) = *self.stack.last().unwrap_or(&(0, true));
        if !alive {
            self.stack.push((node, false));
            return false;
        }
        match self.arena[node].children.get(key) {
            Some(&next) => {
                self.stack.push((next, true));
                true
            }
            None => {
                self.stack.push((node, false));
                false
            }
        }
    }

    /// Leave the current object nesting level.
    #[inline]
    pub fn exit_key(&mut self) {
        if self.stack.len() > 1 {
            self.stack.pop();
        }
    }

    /// Record a captured scalar value at the current node (Value leaf).
    #[inline]
    pub fn record_value(&mut self, start: usize, end: usize) {
        let (node, alive) = *self.stack.last().unwrap_or(&(0, false));
        if !alive {
            return;
        }
        if let Some(ti) = self.arena[node].value_target {
            if !self.matched[ti] {
                self.matched[ti] = true;
                self.ranges[ti] = (start, end);
            }
        }
    }

    /// Record a captured array length at the current node (Length leaf).
    #[inline]
    pub fn record_length(&mut self, count: usize) {
        let (node, alive) = *self.stack.last().unwrap_or(&(0, false));
        if !alive {
            return;
        }
        if let Some(ti) = self.arena[node].length_target {
            if !self.matched[ti] {
                self.matched[ti] = true;
                self.lengths[ti] = count;
            }
        }
    }

    pub fn target_count(&self) -> usize {
        self.matched.len()
    }

    /// Captured raw value byte range for target `i` (valid body, path present).
    pub fn value_range(&self, i: usize) -> Option<(usize, usize)> {
        if self.matched.get(i) == Some(&true) {
            Some(self.ranges[i])
        } else {
            None
        }
    }

    /// Captured array length for target `i` (valid body, path present).
    pub fn length(&self, i: usize) -> Option<usize> {
        if self.matched.get(i) == Some(&true) {
            Some(self.lengths[i])
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_value_pointer() {
        let t = parse_target("/totalCents").unwrap();
        assert_eq!(t.kind, CaptureKind::Value);
        assert_eq!(t.steps, vec![b"totalCents".to_vec()]);
    }

    #[test]
    fn parse_length_pointer() {
        let t = parse_target("/lineItems/-").unwrap();
        assert_eq!(t.kind, CaptureKind::Length);
        assert_eq!(t.steps, vec![b"lineItems".to_vec()]);
    }

    #[test]
    fn parse_nested() {
        let t = parse_target("/customer/email").unwrap();
        assert_eq!(t.kind, CaptureKind::Value);
        assert_eq!(t.steps, vec![b"customer".to_vec(), b"email".to_vec()]);
    }

    #[test]
    fn parse_escapes() {
        let t = parse_target("/a~1b/c~0d").unwrap();
        assert_eq!(t.steps, vec![b"a/b".to_vec(), b"c~d".to_vec()]);
    }

    #[test]
    fn parse_rejects_root_and_indexes() {
        assert!(parse_target("").is_none());
        assert!(parse_target("/").is_none());
        assert!(parse_target("/lineItems/0").is_none());
        assert!(parse_target("lineItems").is_none());
        assert!(parse_target("/-").is_none());
    }

    #[test]
    fn trie_matches_object_and_length() {
        let mut cap = Capture::new(vec![
            parse_target("/lineItems/-").unwrap(),
            parse_target("/totalCents").unwrap(),
        ]);
        // root object member "lineItems" (array): descend, then array close.
        cap.enter_key(b"lineItems");
        cap.record_length(5000);
        cap.exit_key();
        // root object member "totalCents": descend, then record scalar value.
        cap.enter_key(b"totalCents");
        cap.record_value(100, 110);
        cap.exit_key();
        assert_eq!(cap.length(0), Some(5000));
        assert_eq!(cap.value_range(1), Some((100, 110)));
        // a non-target key goes dead and records nothing
        cap.enter_key(b"other");
        cap.record_length(9);
        cap.record_value(1, 2);
        cap.exit_key();
        assert_eq!(cap.length(0), Some(5000));
        assert_eq!(cap.value_range(1), Some((100, 110)));
    }

    #[test]
    fn trie_dead_subtree_is_free() {
        let mut cap = Capture::new(vec![parse_target("/totalCents").unwrap()]);
        // entering a non-target object key kills the subtree
        cap.enter_key(b"lineItems");
        let alive = cap.enter_key(b"sku"); // inside a dead subtree
        assert!(!alive);
        cap.record_value(1, 2); // no-op
        cap.exit_key();
        cap.exit_key();
        assert!(cap.value_range(0).is_none());
    }

    #[test]
    fn trie_nested_value() {
        let mut cap = Capture::new(vec![parse_target("/customer/email").unwrap()]);
        cap.enter_key(b"customer");
        cap.enter_key(b"email");
        cap.record_value(50, 60);
        cap.exit_key();
        cap.exit_key();
        assert_eq!(cap.value_range(0), Some((50, 60)));
    }
}
