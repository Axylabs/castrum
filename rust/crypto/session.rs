// rust/crypto/session.rs — fused session-envelope seal/open.
//
// The framework's session plugin per-request path was:
//   seal:  JSON.stringify(envelope)          → signCookie(json, secret)
//   open:  verifyCookie(token, secret)       → JSON.parse(unsigned)
// i.e. two FFI crossings + a full envelope stringify/parse. Both steps here
// build/extract the envelope NATIVELY (id/data/exp), so the caller crosses
// ONCE and only `data` (the arbitrary user object) is stringified/parsed in
// JS — the id and exp never round-trip through JSC.

use crate::crypto::cookie_sign::{sign_cookie_bytes, verify_cookie_bytes};
use aws_lc_rs::hmac;

/// Build the envelope JSON for `id` / `dataJson` / `exp` and sign it with
/// HMAC-SHA256 (same wire format as signCookie: `payload.<64-hex>`).
/// `data_json` must be a valid JSON object/value — embedded verbatim.
pub fn seal_core(id: &[u8], data_json: &[u8], exp_secs: i64, secret: &[u8]) -> Option<Vec<u8>> {
    if id.is_empty() || secret.is_empty() {
        return None;
    }
    // Envelope size: {"id":"","data":<data>,"exp":0} + escapes on id only
    // (data is already valid JSON; exp is an integer literal).
    let id_esc_len = crate::json::json_ser::json_escaped_len(id);
    let mut json = Vec::with_capacity(id_esc_len + data_json.len() + 32);
    json.push(b'{');
    json.extend_from_slice(b"\"id\":\"");
    let mut wpos = json.len();
    json.resize(json.len() + id_esc_len, 0);
    crate::json::json_ser::write_json_escaped(&mut json, &mut wpos, id);
    json.truncate(wpos);
    json.extend_from_slice(b"\",\"data\":");
    json.extend_from_slice(data_json);
    json.extend_from_slice(b",\"exp\":");
    json.extend_from_slice(exp_secs.to_string().as_bytes());
    json.push(b'}');

    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    Some(sign_cookie_bytes(&json, &key))
}

/// Verify a sealed token and extract the envelope fields into the packed
/// layout: `[u8 ok=1][i64 exp][u32 idLen][id][u32 dataLen][dataJson]`.
/// Returns `None` on bad signature / malformed envelope.
///
/// The returned `exp` is **advisory**: this function does NOT compare it to the
/// current time, so a correctly signed but expired envelope still opens. The
/// caller MUST reject it (`exp != 0 && now >= exp`). (Enforcing it here was
/// considered and rejected: the wire contract is signature + extraction, and
/// the bind-time self-test seals with fixed historical timestamps.)
pub fn open_core(token: &[u8], secret: &[u8]) -> Option<(i64, Vec<u8>, Vec<u8>)> {
    if secret.is_empty() {
        return None;
    }
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    let json = verify_cookie_bytes(token, &key)?;
    // Minimal extraction over the known shape {"id":"…","data":…,"exp":N}.
    // The id/data values were written by `seal` (or an equivalent signer), so
    // a targeted scan of the top-level keys is sufficient — no DOM needed.
    let mut id: Option<Vec<u8>> = None;
    let mut data: Option<Vec<u8>> = None;
    let mut exp: Option<i64> = None;

    let mut pos = 1usize; // skip '{'
    let bytes = &json[..];
    while pos < bytes.len() {
        match bytes[pos] {
            b',' | b'{' | b'}' => pos += 1,
            b'"' => {
                // key string
                let kstart = pos + 1;
                let mut kend = kstart;
                while kend < bytes.len() && bytes[kend] != b'"' {
                    kend += 1;
                }
                if kend >= bytes.len() {
                    return None;
                }
                let key = &bytes[kstart..kend];
                pos = kend + 1;
                if bytes.get(pos) != Some(&b':') {
                    return None;
                }
                pos += 1;
                while matches!(bytes.get(pos), Some(b' ')) {
                    pos += 1;
                }
                match key {
                    b"id" => {
                        if bytes.get(pos) != Some(&b'"') {
                            return None;
                        }
                        let body = pos + 1;
                        let end = scan_json_string_end(bytes, body)?;
                        id = Some(unescape_json_id(&bytes[body..end]));
                        pos = end + 1;
                    }
                    b"exp" => {
                        let vs = pos;
                        while matches!(bytes.get(pos), Some(c) if c.is_ascii_digit() || *c == b'-')
                        {
                            pos += 1;
                        }
                        exp = std::str::from_utf8(&bytes[vs..pos])
                            .ok()
                            .and_then(|s| s.parse::<i64>().ok());
                    }
                    b"data" => {
                        // Capture the raw JSON value: object/array/string/num.
                        let vs = pos;
                        let ve = skip_json_value(bytes, vs)?;
                        data = Some(bytes[vs..ve].to_vec());
                        pos = ve;
                    }
                    _ => {
                        // Unknown key: skip its value generically.
                        pos = skip_json_value(bytes, pos)?;
                    }
                }
            }
            _ => pos += 1,
        }
    }

    let id = id?;
    if id.is_empty() {
        return None;
    }
    Some((exp.unwrap_or(0), id, data.unwrap_or_else(|| b"{}".to_vec())))
}

/// Skip one JSON value starting at `pos`; returns the end offset.
fn skip_json_value(bytes: &[u8], pos: usize) -> Option<usize> {
    match bytes.get(pos)? {
        b'"' => {
            let mut e = pos + 1;
            while e < bytes.len() {
                if bytes[e] == b'\\' {
                    e += 2;
                    continue;
                }
                if bytes[e] == b'"' {
                    return Some(e + 1);
                }
                e += 1;
            }
            None
        }
        b'{' | b'[' => {
            let open = bytes[pos];
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut e = pos;
            while e < bytes.len() {
                match bytes[e] {
                    b'"' => e = skip_json_value(bytes, e)? - 1, // string inside
                    c if c == open => depth += 1,
                    c if c == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(e + 1);
                        }
                    }
                    _ => {}
                }
                e += 1;
            }
            None
        }
        _ => {
            // number / true / false / null → until delimiter
            let mut e = pos;
            while e < bytes.len() && !matches!(bytes[e], b',' | b'}' | b']') {
                e += 1;
            }
            Some(e)
        }
    }
}

/// Index of the `"` that TERMINATES a JSON string whose body starts at `start`
/// (just past the opening quote).
///
/// Escape-aware: the id used to be captured by scanning for the next `"`, which
/// stops at the quote inside an escaped `\"` — truncating the id AND leaving
/// `pos` in the middle of the string, so the rest of the envelope was then read
/// as structure (a quote-carrying id could make `open` fail outright).
fn scan_json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// Decode 4 hex digits at `at` (the `\uXXXX` payload).
fn hex4(bytes: &[u8], at: usize) -> Option<u32> {
    let mut v = 0u32;
    for k in 0..4 {
        v = (v << 4) | (*bytes.get(at + k)? as char).to_digit(16)?;
    }
    Some(v)
}

/// Inverse of `json_ser::write_json_escaped` for the id: decodes `\"`, `\\`,
/// `\/`, `\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX`.
///
/// `\u00XX` maps back to the single BYTE `XX`. That is deliberate and load
/// bearing: the escaper emits that form for control characters AND — in its
/// invalid-UTF-8 mode — for every byte of binary input, so routing it through a
/// code point and re-encoding as UTF-8 would expand bytes >= 0x80 into two
/// bytes and destroy the byte-exact round trip the id is supposed to have.
/// (A valid-UTF-8 id is written RAW by the escaper, so `\u00XX` cannot be its
/// origin.)
///
/// `\uXXXX` above 0xFF can only come from a different producer (e.g. JS
/// `JSON.stringify` of a non-ASCII id), so it is decoded as a code point with
/// surrogate-pair combining. Unknown escapes and a trailing backslash are kept
/// verbatim — never silently dropped.
fn unescape_json_id(escaped: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(escaped.len());
    let mut i = 0usize;
    while i < escaped.len() {
        if escaped[i] != b'\\' {
            out.push(escaped[i]);
            i += 1;
            continue;
        }
        let Some(&e) = escaped.get(i + 1) else {
            out.push(b'\\');
            break;
        };
        i += 2;
        match e {
            b'"' => out.push(b'"'),
            b'\\' => out.push(b'\\'),
            b'/' => out.push(b'/'),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0c),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'u' => {
                let Some(cp) = hex4(escaped, i) else {
                    out.push(b'\\');
                    out.push(b'u');
                    continue;
                };
                i += 4;
                if cp <= 0xFF {
                    out.push(cp as u8);
                    continue;
                }
                let mut code = cp;
                if (0xD800..=0xDBFF).contains(&cp)
                    && escaped.get(i) == Some(&b'\\')
                    && escaped.get(i + 1) == Some(&b'u')
                {
                    if let Some(lo) = hex4(escaped, i + 2) {
                        if (0xDC00..=0xDFFF).contains(&lo) {
                            code = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            i += 6;
                        }
                    }
                }
                let mut buf = [0u8; 4];
                let ch = char::from_u32(code).unwrap_or('\u{FFFD}');
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            other => {
                out.push(b'\\');
                out.push(other);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret";

    #[test]
    fn seal_open_round_trip() {
        let token =
            seal_core(b"sess-123", br#"{"cart":["a","b"]}"#, 1_700_000_000, SECRET).expect("seal");
        let (exp, id, data) = open_core(&token, SECRET).expect("open");
        assert_eq!(id, b"sess-123");
        assert_eq!(exp, 1_700_000_000);
        assert_eq!(data, br#"{"cart":["a","b"]}"#);
    }

    #[test]
    fn tampered_token_rejected() {
        let mut token = seal_core(b"id1", b"{}", 0, SECRET).expect("seal");
        let last = token.len() - 1;
        token[last] ^= 0xff;
        assert!(open_core(&token, SECRET).is_none());
    }

    #[test]
    fn wrong_secret_rejected() {
        let token = seal_core(b"id1", b"{}", 0, SECRET).expect("seal");
        assert!(open_core(&token, b"other").is_none());
    }

    #[test]
    fn empty_id_rejected() {
        assert!(seal_core(b"", b"{}", 0, SECRET).is_none());
    }

    #[test]
    fn id_round_trips_byte_exactly_through_escapes() {
        // A `"` used to terminate the id scan early, and the id came back
        // escaped. Both are the same root cause: an escape-unaware scan with no
        // decode. Every id here must survive the envelope byte-for-byte.
        for id in [
            &b"plain-id"[..],
            &b"sess\"quote"[..],
            &b"back\\slash"[..],
            &b"new\nline"[..],
            &b"tab\there"[..],
            &b"cr\rhere"[..],
            &b"nul\0byte"[..],
            &b"binary\xff\xfe"[..],
            &b"trailing\\"[..],
        ] {
            let token = seal_core(id, br#"{"a":1}"#, 42, SECRET).expect("seal");
            let (exp, got, data) = open_core(&token, SECRET).expect("open");
            assert_eq!(got, id, "id must round-trip byte-exactly");
            assert_eq!(exp, 42);
            assert_eq!(data, br#"{"a":1}"#);
        }
    }

    #[test]
    fn unescape_json_id_matches_the_escaper() {
        assert_eq!(unescape_json_id(br#"a\"b"#), b"a\"b");
        assert_eq!(unescape_json_id(br#"a\\b"#), b"a\\b");
        assert_eq!(unescape_json_id(br#"a\/b"#), b"a/b");
        assert_eq!(unescape_json_id(br#"a\nb"#), b"a\nb");
        assert_eq!(unescape_json_id(br#"a\rb"#), b"a\rb");
        assert_eq!(unescape_json_id(br#"a\tb"#), b"a\tb");
        assert_eq!(unescape_json_id(br#"a\bb"#), b"a\x08b");
        assert_eq!(unescape_json_id(br#"a\fb"#), b"a\x0cb");
        // `\u00XX` is a BYTE (the escaper's binary mode), not a code point.
        assert_eq!(unescape_json_id(br#"a\u00e9b"#), b"a\xe9b");
        // Above 0xFF is a real code point → UTF-8.
        assert_eq!(unescape_json_id(br#"a\u20acb"#), "a\u{20ac}b".as_bytes());
        // A surrogate pair combines into one code point.
        assert_eq!(unescape_json_id(br#"\ud83d\ude00"#), "\u{1f600}".as_bytes());
        // Unknown escapes and a trailing backslash stay verbatim.
        assert_eq!(unescape_json_id(br#"a\qb"#), br#"a\qb"#);
        assert_eq!(unescape_json_id(b"a\\"), b"a\\");
    }

    #[test]
    fn scan_json_string_end_skips_escaped_quotes() {
        // `a\"b"` (a, \, ", b, ") — the escaped quote does NOT terminate; the
        // plain quote at index 4 does.
        assert_eq!(scan_json_string_end(b"a\\\"b\"", 0), Some(4));
        // No escape at all: the first quote terminates.
        assert_eq!(scan_json_string_end(b"ab\"cd", 0), Some(2));
        // Unterminated: the trailing backslash swallows the rest.
        assert_eq!(scan_json_string_end(b"ab\\\"", 0), None);
        // Escaped BACKSLASH then a terminator: `a\\"` = a, \, \, " → Some(3).
        assert_eq!(scan_json_string_end(b"a\\\\\"", 0), Some(3));
    }

    #[test]
    fn wire_format_matches_sign_cookie() {
        // The sealed token must be verifiable by the EXISTING cookie verify
        // core (same "payload.<hex>" wire format) so old readers stay valid.
        let token = seal_core(b"sid", br#"{"n":1}"#, 5, SECRET).expect("seal");
        let key = hmac::Key::new(hmac::HMAC_SHA256, SECRET);
        let unsigned = verify_cookie_bytes(&token, &key).expect("verify via cookie core");
        let s = String::from_utf8(unsigned).expect("utf8");
        assert!(s.starts_with("{\"id\":\"sid\",\"data\":{\"n\":1},\"exp\":5}"));
    }
}
