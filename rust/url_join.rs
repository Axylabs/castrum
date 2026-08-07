// rust/url_join.rs — URL building: RFC 3986 reference resolution + query builder.
//
// `url_resolve(base, reference)` resolves a relative/absolute reference against
// a base URI (merge paths + remove dot segments). `url_encode_query` builds a
// percent-encoded query string (deterministic sorted-key order). The
// `UrlBuilder` higher-order instance parses the base once and reuses it.

use std::collections::BTreeMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// A parsed URI reference (RFC 3986 §4.2 components).
#[derive(Debug, Clone)]
struct Ref {
    scheme: Option<String>,
    authority: Option<String>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

fn parse_ref(input: &str) -> Ref {
    let (rest, fragment) = match input.find('#') {
        Some(i) => (&input[..i], Some(input[i + 1..].to_string())),
        None => (input, None),
    };

    let (rest, scheme) = if let Some(i) = rest.find(':') {
        let candidate = &rest[..i];
        if !candidate.is_empty()
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        {
            (&rest[i + 1..], Some(candidate.to_string()))
        } else {
            (rest, None)
        }
    } else {
        (rest, None)
    };

    let (rest, authority) = if rest.starts_with("//") {
        let rest2 = &rest[2..];
        let end = rest2.find('/').unwrap_or(rest2.len());
        (&rest2[end..], Some(rest2[..end].to_string()))
    } else {
        (rest, None)
    };

    let (path, query) = match rest.find('?') {
        Some(i) => (rest[..i].to_string(), Some(rest[i + 1..].to_string())),
        None => (rest.to_string(), None),
    };

    Ref {
        scheme,
        authority,
        path,
        query,
        fragment,
    }
}

/// RFC 3986 §5.2.4 remove_dot_segments (normalize `.` / `..`).
fn remove_dot_segments(path: &str) -> String {
    let leading = path.starts_with('/');
    let parts: Vec<&str> = path.split('/').collect();
    let mut segments: Vec<&str> = Vec::new();
    let mut i = 0usize;
    if parts.first() == Some(&"") {
        i = 1;
    }
    while i < parts.len() {
        match parts[i] {
            "." => {}
            ".." => {
                segments.pop();
            }
            seg => segments.push(seg),
        }
        i += 1;
    }
    let body = segments.join("/");
    if leading {
        format!("/{body}")
    } else {
        body
    }
}

/// RFC 3986 §5.3.3 merge paths.
fn merge_paths(base_path: &str, ref_path: &str) -> String {
    match base_path.rfind('/') {
        Some(i) => format!("{}{}", &base_path[..=i], ref_path),
        None => ref_path.to_string(),
    }
}

fn resolve_target(base: &Ref, r: &Ref) -> Ref {
    if r.scheme.is_some() {
        let mut t = r.clone();
        t.path = remove_dot_segments(&r.path);
        return t;
    }
    let mut t = Ref {
        scheme: base.scheme.clone(),
        authority: base.authority.clone(),
        path: String::new(),
        query: None,
        fragment: r.fragment.clone(),
    };
    if r.authority.is_some() {
        t.authority = r.authority.clone();
        t.path = remove_dot_segments(&r.path);
        t.query = r.query.clone();
        return t;
    }
    if r.path.is_empty() {
        t.path = base.path.clone();
        t.query = r.query.clone().or_else(|| base.query.clone());
        return t;
    }
    if r.path.starts_with('/') {
        t.path = remove_dot_segments(&r.path);
    } else {
        t.path = remove_dot_segments(&merge_paths(&base.path, &r.path));
    }
    t.query = r.query.clone();
    t
}

fn recompose(r: &Ref) -> String {
    let mut s = String::new();
    if let Some(sch) = &r.scheme {
        s.push_str(sch);
        s.push(':');
    }
    if let Some(auth) = &r.authority {
        s.push_str("//");
        s.push_str(auth);
    }
    s.push_str(&r.path);
    if let Some(q) = &r.query {
        s.push('?');
        s.push_str(q);
    }
    if let Some(f) = &r.fragment {
        s.push('#');
        s.push_str(f);
    }
    s
}

#[napi]
pub fn url_resolve(base: Uint8Array, reference: Uint8Array) -> Result<Buffer> {
    let b = std::str::from_utf8(base.as_ref())
        .map_err(|_| Error::from_reason("base must be UTF-8"))?;
    let r = std::str::from_utf8(reference.as_ref())
        .map_err(|_| Error::from_reason("reference must be UTF-8"))?;
    let target = resolve_target(&parse_ref(b), &parse_ref(r));
    Ok(Buffer::from(recompose(&target).into_bytes()))
}

fn encode_query_component(input: &[u8], out: &mut Vec<u8>) -> Result<()> {
    let mut buf = vec![0u8; input.len() * 3];
    let written = crate::url_codec::url_encode_into_slice(input, &mut buf)?;
    out.extend_from_slice(&buf[..written]);
    Ok(())
}

#[napi]
pub fn url_encode_query(params: BTreeMap<String, String>) -> Result<Buffer> {
    let mut out = Vec::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push(b'&');
        }
        encode_query_component(k.as_bytes(), &mut out)?;
        out.push(b'=');
        encode_query_component(v.as_bytes(), &mut out)?;
    }
    Ok(Buffer::from(out))
}

/// Higher-order instance: base parsed once, reused across resolves.
#[napi]
pub struct UrlBuilder {
    base: Ref,
}

#[napi]
impl UrlBuilder {
    #[napi(constructor)]
    pub fn new(base: Uint8Array) -> Result<Self> {
        let b = std::str::from_utf8(base.as_ref())
            .map_err(|_| Error::from_reason("base must be UTF-8"))?;
        Ok(Self { base: parse_ref(b) })
    }

    #[napi]
    pub fn resolve(&self, reference: Uint8Array) -> Result<Buffer> {
        let r = std::str::from_utf8(reference.as_ref())
            .map_err(|_| Error::from_reason("reference must be UTF-8"))?;
        let target = resolve_target(&self.base, &parse_ref(r));
        Ok(Buffer::from(recompose(&target).into_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(base: &str, reference: &str) -> String {
        recompose(&resolve_target(&parse_ref(base), &parse_ref(reference)))
    }

    #[test]
    fn absolute_reference() {
        assert_eq!(
            resolve("http://a/b/c/d;p?q", "http://x/y/z"),
            "http://x/y/z"
        );
    }

    #[test]
    fn authority_reference() {
        assert_eq!(resolve("http://a/b/c/d;p?q", "//other/path"), "http://other/path");
    }

    #[test]
    fn dot_segment_removal() {
        assert_eq!(resolve("http://a/b/c/d;p?q", "../../../g"), "http://a/g");
        assert_eq!(resolve("http://a/b/c/d;p?q", "../../../../g"), "http://a/g");
        assert_eq!(resolve("http://a/b/c/d;p?q", "./g"), "http://a/b/c/g");
        assert_eq!(resolve("http://a/b/c/d;p?q", "g/./h"), "http://a/b/c/g/h");
        assert_eq!(resolve("http://a/b/c/d;p?q", "g/../h"), "http://a/b/c/h");
    }

    #[test]
    fn query_and_fragment() {
        assert_eq!(resolve("http://a/b/c/d;p?q", "g?y#f"), "http://a/b/c/g?y#f");
        assert_eq!(resolve("http://a/b/c/d;p?q", "#frag"), "http://a/b/c/d;p?q#frag");
        assert_eq!(resolve("http://a/b/c/d;p?q", "?y"), "http://a/b/c/d;p?y");
    }

    #[test]
    fn empty_path_reference_keeps_base_query() {
        assert_eq!(resolve("http://a/b/c/d;p?q", ""), "http://a/b/c/d;p?q");
    }

    #[test]
    fn query_builder_sorted_and_encoded() {
        let mut params = BTreeMap::new();
        params.insert("b".to_string(), "x y".to_string());
        params.insert("a".to_string(), "1".to_string());
        let out = url_encode_query(params).unwrap();
        assert_eq!(out.as_ref(), b"a=1&b=x%20y");
    }
}
