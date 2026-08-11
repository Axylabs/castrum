// rust/http/media_type.rs — Content-Type / media type parser.
//
// Parses `type/subtype; param=value; ...` per RFC 7231 §3.1.1.1: lowercased
// type/subtype, token + quoted-string params (charset, boundary). Pure-Rust
// core (`parse_media_type_core`) stays napi-free for testability; only the
// entry points use napi types.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::bytes::trim_ascii_whitespace;

/// RFC 7230 `tchar` (tokens used in media-type names/params).
#[inline]
fn is_token_char(b: u8) -> bool {
    matches!(
        b,
        b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    )
}

/// A parsed media type (pure-Rust core type).
pub struct ParsedMediaType {
    pub ty: String,
    pub subtype: String,
    pub params: Vec<(String, String)>,
}

/// Decode a quoted-string param value (`"..."`, backslash escapes).
fn parse_quoted(raw: &[u8]) -> std::result::Result<String, &'static str> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 1;
    while i < raw.len() {
        match raw[i] {
            b'"' => return String::from_utf8(out).map_err(|_| "invalid UTF-8 in quoted string"),
            b'\\' if i + 1 < raw.len() => {
                out.push(raw[i + 1]);
                i += 2;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Err("unterminated quoted string")
}

/// Parse `type/subtype; param=value` (params may be quoted or token values).
pub fn parse_media_type_core(input: &[u8]) -> std::result::Result<ParsedMediaType, &'static str> {
    let semi = input.iter().position(|&b| b == b';');
    let (main, rest) = match semi {
        Some(i) => (&input[..i], &input[i + 1..]),
        None => (input, &[][..]),
    };

    let main = trim_ascii_whitespace(main);
    let slash = main
        .iter()
        .position(|&b| b == b'/')
        .ok_or("missing '/' in media type")?;
    // Single-pass lowercase: `to_ascii_lowercase()` into a Vec, then
    // `String::from_utf8` wraps it without a second copy (the old
    // `from_utf8_lossy(...).into_owned()` copied twice). Input is
    // token-validated below, so invalid UTF-8 is rejected either way.
    let ty = String::from_utf8(main[..slash].to_ascii_lowercase())
        .map_err(|_| "invalid UTF-8 in media type")?;
    let subtype = String::from_utf8(main[slash + 1..].to_ascii_lowercase())
        .map_err(|_| "invalid UTF-8 in media type")?;
    if ty.is_empty() || subtype.is_empty() {
        return Err("empty type or subtype");
    }
    if !ty.bytes().all(is_token_char) || !subtype.bytes().all(is_token_char) {
        return Err("invalid type/subtype token");
    }

    let mut params = Vec::new();
    for param in rest.split(|&b| b == b';') {
        let param = trim_ascii_whitespace(param);
        if param.is_empty() {
            continue;
        }
        let eq = param
            .iter()
            .position(|&b| b == b'=')
            .ok_or("media-type param missing '='")?;
        let name = String::from_utf8_lossy(&param[..eq])
            .trim()
            .to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let raw_val = trim_ascii_whitespace(&param[eq + 1..]);
        let value = if raw_val.first() == Some(&b'"') {
            parse_quoted(raw_val)?
        } else {
            let v = trim_ascii_whitespace(raw_val);
            if v.is_empty() {
                return Err("empty media-type param value");
            }
            String::from_utf8_lossy(v).into_owned()
        };
        params.push((name, value));
    }

    Ok(ParsedMediaType {
        ty,
        subtype,
        params,
    })
}

/// napi-projected structured result (snake_case → camelCase in JS).
#[napi(object)]
pub struct MediaTypeResult {
    /// Lowercased `type/subtype`.
    pub media_type: String,
    pub charset: Option<String>,
    pub boundary: Option<String>,
    pub params: HashMap<String, String>,
}

#[napi]
pub fn parse_media_type(input: Uint8Array) -> Result<MediaTypeResult> {
    let parsed =
        parse_media_type_core(input.as_ref()).map_err(|e| Error::from_reason(e.to_string()))?;
    let mut params = HashMap::with_capacity(parsed.params.len());
    for (k, v) in parsed.params {
        params.insert(k, v);
    }
    Ok(MediaTypeResult {
        charset: params.get("charset").cloned(),
        boundary: params.get("boundary").cloned(),
        media_type: format!("{}/{}", parsed.ty, parsed.subtype),
        params,
    })
}

/// Zero-alloc media-type split: returns the `(type, subtype)` byte slices from
/// `input`, replicating `parse_media_type_core`'s type/subtype acceptance
/// rules (parameters stripped, whitespace-trimmed, non-empty, RFC 7230 token
/// chars) WITHOUT building the lowercase `String`s or the params `Vec`. The
/// caller compares case-insensitively against a precompiled lowercase expected
/// side. Any non-token byte (including non-ASCII / invalid UTF-8) is rejected,
/// exactly like the parser.
#[inline]
fn split_type_subtype(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let semi = input.iter().position(|&b| b == b';');
    let main = match semi {
        Some(i) => &input[..i],
        None => input,
    };
    let main = trim_ascii_whitespace(main);
    let slash = main.iter().position(|&b| b == b'/')?;
    let ty = &main[..slash];
    let subtype = &main[slash + 1..];
    if ty.is_empty() || subtype.is_empty() {
        return None;
    }
    if !ty.iter().all(|&b| is_token_char(b)) || !subtype.iter().all(|&b| is_token_char(b)) {
        return None;
    }
    Some((ty, subtype))
}

/// Higher-order instance: provides a reusable `matches` (wildcard negotiation)
/// helper and a consistent instance-based API for content-type handling.
#[napi]
pub struct MediaTypeParser;

impl Default for MediaTypeParser {
    fn default() -> Self {
        Self
    }
}

#[napi]
impl MediaTypeParser {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self
    }

    #[napi]
    pub fn parse(&self, input: Uint8Array) -> Result<MediaTypeResult> {
        parse_media_type(input)
    }

    /// Wildcard match: `expected` may be `*/*`, `type/*`, or exact `type/subtype`.
    /// Zero-alloc: both sides are split into byte slices and compared
    /// case-insensitively (no String / params-Vec allocation per call).
    #[napi]
    pub fn matches(&self, actual: Uint8Array, expected: Uint8Array) -> bool {
        let (Some((aty, ast)), Some((ety, est))) = (
            split_type_subtype(actual.as_ref()),
            split_type_subtype(expected.as_ref()),
        ) else {
            return false;
        };
        let ty_ok =
            crate::util::bytes::ascii_eq_ignore_case(ety, b"*")
                || crate::util::bytes::ascii_eq_ignore_case(ety, aty);
        let st_ok =
            crate::util::bytes::ascii_eq_ignore_case(est, b"*")
                || crate::util::bytes::ascii_eq_ignore_case(est, ast);
        ty_ok && st_ok
    }
}

/// Higher-order instance: precompiles the EXPECTED media type once at
/// construction (type/subtype lowercased), so every `matches` call only parses
/// the ACTUAL header — the expected side never re-parses.
#[napi]
pub struct MediaTypeMatcher {
    expected_ty: String,
    expected_subtype: String,
}

#[napi]
impl MediaTypeMatcher {
    /// Precompile `expected` (`*/*`, `type/*`, or `type/subtype`).
    #[napi(constructor)]
    pub fn new(expected: Uint8Array) -> Result<Self> {
        let parsed = parse_media_type_core(expected.as_ref())
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self {
            expected_ty: parsed.ty,
            expected_subtype: parsed.subtype,
        })
    }

    /// Wildcard match against the precompiled expected type. Only `actual` is
    /// inspected per call — `expected` was normalized once at construction, and
    /// the actual side is split into byte slices (no String / params-Vec alloc).
    #[napi]
    pub fn matches(&self, actual: Uint8Array) -> bool {
        let Some((ty, subtype)) = split_type_subtype(actual.as_ref()) else {
            return false;
        };
        let ty_ok = self.expected_ty == "*"
            || crate::util::bytes::ascii_eq_ignore_case(ty, self.expected_ty.as_bytes());
        let st_ok = self.expected_subtype == "*"
            || crate::util::bytes::ascii_eq_ignore_case(subtype, self.expected_subtype.as_bytes());
        ty_ok && st_ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> ParsedMediaType {
        parse_media_type_core(s.as_bytes()).unwrap()
    }

    #[test]
    fn parses_basic_json() {
        let m = parse("application/json; charset=utf-8");
        assert_eq!(m.ty, "application");
        assert_eq!(m.subtype, "json");
        assert_eq!(m.params, vec![("charset".to_string(), "utf-8".to_string())]);
    }

    #[test]
    fn parses_multipart_boundary() {
        let m = parse("multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW");
        assert_eq!(m.ty, "multipart");
        assert_eq!(m.subtype, "form-data");
        assert_eq!(m.params[0].0, "boundary");
        assert_eq!(m.params[0].1, "----WebKitFormBoundary7MA4YWxkTrZu0gW");
    }

    #[test]
    fn lowercases_type_and_subtype() {
        let m = parse("Application/JSON; Charset=UTF-8");
        assert_eq!(m.ty, "application");
        assert_eq!(m.subtype, "json");
        assert_eq!(m.params[0], ("charset".to_string(), "UTF-8".to_string()));
    }

    #[test]
    fn parses_quoted_param_with_escape() {
        let m = parse("text/plain; filename=\"a\\\"b.txt\"");
        assert_eq!(
            m.params[0],
            ("filename".to_string(), "a\"b.txt".to_string())
        );
    }

    #[test]
    fn trims_whitespace_and_skips_empty() {
        let m = parse("  text/html ; charset=utf-8 ;;  q=1 ");
        assert_eq!(m.ty, "text");
        assert_eq!(m.subtype, "html");
        assert_eq!(m.params.len(), 2);
    }

    #[test]
    fn wildcard_matches() {
        let parser = MediaTypeParser;
        assert!(parser.matches(
            Uint8Array::new(b"application/json".to_vec()),
            Uint8Array::new(b"*/*".to_vec())
        ));
        assert!(parser.matches(
            Uint8Array::new(b"application/json".to_vec()),
            Uint8Array::new(b"application/*".to_vec())
        ));
        assert!(!parser.matches(
            Uint8Array::new(b"application/json".to_vec()),
            Uint8Array::new(b"text/*".to_vec())
        ));
        assert!(!parser.matches(
            Uint8Array::new(b"application/json".to_vec()),
            Uint8Array::new(b"application/xml".to_vec())
        ));
    }

    #[test]
    fn matcher_precompiles_expected() {
        // The precompiled instance only parses `actual` per call — expected is
        // normalized once at construction. Behavior must match MediaTypeParser.
        let m = MediaTypeMatcher::new(Uint8Array::new(b"Application/JSON".to_vec())).unwrap();
        assert!(m.matches(Uint8Array::new(b"application/json".to_vec())));
        assert!(!m.matches(Uint8Array::new(b"text/html".to_vec())));

        let any = MediaTypeMatcher::new(Uint8Array::new(b"*/*".to_vec())).unwrap();
        assert!(any.matches(Uint8Array::new(b"text/html".to_vec())));
        assert!(any.matches(Uint8Array::new(b"application/json".to_vec())));

        let subtype = MediaTypeMatcher::new(Uint8Array::new(b"application/*".to_vec())).unwrap();
        assert!(subtype.matches(Uint8Array::new(b"application/xml".to_vec())));
        assert!(!subtype.matches(Uint8Array::new(b"text/xml".to_vec())));

        // Malformed actual → false (never panics).
        assert!(!m.matches(Uint8Array::new(b"no-slash".to_vec())));

        // Malformed expected → construction error.
        assert!(MediaTypeMatcher::new(Uint8Array::new(b"no-slash".to_vec())).is_err());
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse_media_type_core(b"application").is_err());
        assert!(parse_media_type_core(b"application/").is_err());
        assert!(parse_media_type_core(b"a/b; x=\"unterminated").is_err());
        assert!(parse_media_type_core(b"a b/c").is_err());
    }
}
