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
                        let vs = pos + 1;
                        let mut ve = vs;
                        while ve < bytes.len() && bytes[ve] != b'"' {
                            ve += 1;
                        }
                        id = Some(bytes[vs..ve].to_vec());
                        pos = ve + 1;
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
