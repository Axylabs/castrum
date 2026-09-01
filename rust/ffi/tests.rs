// rust/ffi/tests.rs — C-ABI unit tests.
//
// Exercises every `castrum_*` export against the pure cores (parity with the
// napi/scalar paths), the packed-wire layouts (needed-size convention), the
// cstring-returning writers, and the opaque-handle fast paths. Moved out of
// the former `ffi.rs` so the export surface is navigable; `use super::*` picks
// up every symbol via the module-root re-exports in `mod.rs`.

use super::*;
use aws_lc_rs::hmac;

#[test]
fn crc32_c_abi_matches_core() {
    let bytes = b"123456789";
    let out = unsafe { castrum_crc32(bytes.as_ptr(), bytes.len()) };
    assert_eq!(out, crate::crypto::hashing::crc32_bytes(b"123456789"));
}

// ── Per-route stack C-ABI (castrum_route_*) ────────────────────

/// Minimal route descriptor wire (magic + version 3 + parseQuery +
/// parseCookies stages).
fn route_desc_parse_both() -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(&crate::ingress::native_route::ROUTE_DESC_MAGIC.to_le_bytes());
    d.extend_from_slice(&crate::ingress::native_route::ROUTE_DESC_VERSION.to_le_bytes());
    d.extend_from_slice(&(2 * 1024 * 1024u32).to_le_bytes());
    d.extend_from_slice(&8192u32.to_le_bytes());
    d.extend_from_slice(&8192u32.to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes());
    d.extend_from_slice(&2u32.to_le_bytes()); // stageCount
    d.push(crate::ingress::native_route::STAGE_PARSE_QUERY);
    d.push(crate::ingress::native_route::STAGE_PARSE_COOKIES);
    d.extend_from_slice(&0u32.to_le_bytes()); // schemaCount
    d
}

/// Request frame: `[flags u32][qLen][query][cLen][cookie]`.
fn route_frame(query: &[u8], cookie: &[u8]) -> Vec<u8> {
    let mut f = Vec::new();
    f.extend_from_slice(&0u32.to_le_bytes());
    f.extend_from_slice(&(query.len() as u32).to_le_bytes());
    f.extend_from_slice(query);
    f.extend_from_slice(&(cookie.len() as u32).to_le_bytes());
    f.extend_from_slice(cookie);
    f
}

#[test]
fn route_compile_run_destroy_c_abi() {
    let desc = route_desc_parse_both();
    let handle = unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
    assert_ne!(handle, 0, "route compile must produce a live handle");

    let f = route_frame(b"a=1&b=hello%20world", b"s=v");
    let mut out = vec![0u8; 256];
    let w = unsafe { castrum_route_run(handle, f.as_ptr(), f.len(), out.as_mut_ptr(), out.len()) };
    // 8 header + query section [count 4 + (a=1: 4+1+4+1=10) + (b=hello world:
    // 4+1+4+11=20) = 34] + cookie section [count 4 + (s=v: 4+1+4+1=10) = 14].
    assert_eq!(w, 8 + 34 + 14, "exact result size (query+cookie sections)");

    let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
    assert_ne!(
        flags & crate::ingress::native_route::ROUTE_RESULT_FLAG_OK,
        0
    );
    assert_ne!(
        flags & crate::ingress::native_route::ROUTE_RESULT_FLAG_QUERY_VALID,
        0
    );

    unsafe { castrum_route_destroy(handle) };
}

#[test]
fn route_compile_rejects_bad_magic() {
    let mut desc = route_desc_parse_both();
    desc[0] = 0;
    let handle = unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
    assert_eq!(handle, 0, "bad magic must fail compilation");
}

#[test]
fn route_run_needed_size_convention() {
    let desc = route_desc_parse_both();
    let handle = unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
    assert_ne!(handle, 0);
    let f = route_frame(b"a=1&bb=22&ccc=333", b"");
    // A too-small buffer reports the EXACT required size without writing.
    let mut small = [0u8; 8];
    let needed =
        unsafe { castrum_route_run(handle, f.as_ptr(), f.len(), small.as_mut_ptr(), small.len()) };
    assert!(needed > 8);
    let mut big = vec![0u8; needed];
    let w = unsafe { castrum_route_run(handle, f.as_ptr(), f.len(), big.as_mut_ptr(), big.len()) };
    assert_eq!(w, needed);
    assert_eq!(
        &small[..],
        &[0u8; 8],
        "nothing written to the too-small buffer"
    );
    unsafe { castrum_route_destroy(handle) };
}

/// The C-ABI ingress layout blob must never drift from the single numeric
/// source (`output.rs`). If a layout constant changes in `output.rs` (or the
/// struct field order here) without updating this test, it fails.
#[test]
fn ingress_layout_c_abi_matches_output_source() {
    use crate::ingress::output;
    let mut buf = [0u8; core::mem::size_of::<IngressLayout>()];
    let written = unsafe { castrum_ingress_layout(buf.as_mut_ptr(), buf.len()) };
    assert_eq!(written, buf.len(), "layout blob must fill the full struct");
    let ptr = buf.as_ptr() as *const IngressLayout;
    let l = unsafe { &*ptr };
    assert_eq!(l.out_verdict, output::OUT_VERDICT as u32);
    assert_eq!(l.out_error_code, output::OUT_ERROR_CODE as u32);
    assert_eq!(l.out_status, output::OUT_STATUS as u32);
    assert_eq!(l.out_flags, output::OUT_FLAGS as u32);
    assert_eq!(l.out_rate_limit, output::OUT_RATE_LIMIT as u32);
    assert_eq!(l.out_rate_remaining, output::OUT_RATE_REMAINING as u32);
    assert_eq!(l.out_rate_reset, output::OUT_RATE_RESET as u32);
    assert_eq!(l.out_retry_after, output::OUT_RETRY_AFTER as u32);
    assert_eq!(l.out_cookies_json_len, output::OUT_COOKIES_JSON_LEN as u32);
    assert_eq!(l.out_query_json_len, output::OUT_QUERY_JSON_LEN as u32);
    assert_eq!(l.out_header_variant, output::OUT_HEADER_VARIANT as u32);
    assert_eq!(l.out_body_json_len, output::OUT_BODY_JSON_LEN as u32);
    assert_eq!(l.out_data_start, output::OUT_DATA_START as u32);
    assert_eq!(l.flag_has_cookies, output::FLAG_HAS_COOKIES);
    assert_eq!(l.flag_has_query, output::FLAG_HAS_QUERY);
    assert_eq!(l.flag_body_valid_json, output::FLAG_BODY_VALID_JSON);
    assert_eq!(l.flag_schema_valid, output::FLAG_SCHEMA_VALID);
    assert_eq!(l.flag_cors_allowed, output::FLAG_CORS_ALLOWED);
    assert_eq!(l.flag_is_preflight, output::FLAG_IS_PREFLIGHT);
    assert_eq!(l.flag_rate_limited, output::FLAG_RATE_LIMITED);
    assert_eq!(l.flag_https, output::FLAG_HTTPS);
    assert_eq!(l.flag_trusted_proxy, output::FLAG_TRUSTED_PROXY);
    assert_eq!(l.flag_body_truncated, output::FLAG_BODY_TRUNCATED);
    assert_eq!(l.hv_json, output::HV_JSON as u32);
    assert_eq!(l.hv_cors_simple, output::HV_CORS_SIMPLE as u32);
    assert_eq!(l.hv_cors_preflight, output::HV_CORS_PREFLIGHT as u32);
    assert_eq!(l.hv_rate_active, output::HV_RATE_ACTIVE as u32);
    assert_eq!(l.hv_rate_limited, output::HV_RATE_LIMITED as u32);
    assert_eq!(l.hv_count, output::HV_COUNT as u32);
    assert_eq!(l.err_none, output::ERR_CODE_NONE as u32);
    assert_eq!(l.err_cors_preflight, output::ERR_CODE_CORS_PREFLIGHT as u32);
    assert_eq!(l.err_rate_limited, output::ERR_CODE_RATE_LIMITED as u32);
    assert_eq!(l.err_body_too_large, output::ERR_CODE_BODY_TOO_LARGE as u32);
    assert_eq!(l.err_invalid_json, output::ERR_CODE_INVALID_JSON as u32);
    assert_eq!(
        l.err_schema_validation,
        output::ERR_CODE_SCHEMA_VALIDATION as u32
    );
    assert_eq!(l.err_bad_request, output::ERR_CODE_BAD_REQUEST as u32);
    assert_eq!(
        l.err_request_too_large,
        output::ERR_CODE_REQUEST_TOO_LARGE as u32
    );
    assert_eq!(l.err_internal, output::ERR_CODE_INTERNAL as u32);
}

#[test]
fn fnv_c_abi_matches_core() {
    let bytes = b"foobar";
    let out = unsafe { castrum_fnv1a64(bytes.as_ptr(), bytes.len()) };
    assert_eq!(out, crate::crypto::hashing::fnv1a64_bytes(b"foobar"));
}

#[test]
fn json_valid_c_abi() {
    let good = b"{\"a\":1}";
    assert_eq!(unsafe { castrum_json_valid(good.as_ptr(), good.len()) }, 1);
    let bad = b"{not json";
    assert_eq!(unsafe { castrum_json_valid(bad.as_ptr(), bad.len()) }, 0);
}

#[test]
fn utf8_valid_c_abi() {
    assert_eq!(unsafe { castrum_utf8_valid(b"hello".as_ptr(), 5) }, 1);
    assert_eq!(
        unsafe { castrum_utf8_valid("héllo 🚀".as_bytes().as_ptr(), "héllo 🚀".len()) },
        1
    );
    assert_eq!(unsafe { castrum_utf8_valid(b"\xff\xfe".as_ptr(), 2) }, 0);
    // A lone 0xC3 (incomplete 2-byte sequence) is invalid.
    assert_eq!(unsafe { castrum_utf8_valid(b"\xc3".as_ptr(), 1) }, 0);
    // Null pointer / zero-length → 0 / empty is valid.
    assert_eq!(unsafe { castrum_utf8_valid(std::ptr::null(), 0) }, 0);
    assert_eq!(unsafe { castrum_utf8_valid(b"".as_ptr(), 0) }, 1);
}

#[test]
fn hmac_key_cache_reuses_compiled_key() {
    // Same-secret calls must hit the cache (the whole point of the LRU):
    // repeated calls reuse the precomputed key schedule instead of
    // re-deriving it via `hmac::Key::new`.
    HMAC_KEY_CACHE.with(|c| c.borrow_mut().clear());
    HMAC_CACHE_HITS.with(|h| h.set(0));
    let secret = b"same-secret";
    let _ = hmac_key_cached(secret);
    let _ = hmac_key_cached(secret);
    let _ = hmac_key_cached(secret);
    let hits = HMAC_CACHE_HITS.with(|h| h.get());
    assert!(
        hits >= 2,
        "same-secret calls must reuse the cached key (hits={hits})"
    );
}

#[test]
fn hmac_key_cache_matches_fresh_key() {
    // The cached key must be byte-identical in behavior to a freshly
    // derived key for every secret.
    for secret in [b"a".as_slice(), b"secret-key", b"x".repeat(300).as_slice()] {
        let cached = hmac_key_cached(secret);
        let fresh = hmac_key(secret);
        let data = b"hello world";
        let a = hmac::sign(&cached, data);
        let b = hmac::sign(&fresh, data);
        assert_eq!(a.as_ref(), b.as_ref(), "cached key differs from fresh key");
    }
}

#[test]
fn hmac_key_cache_survives_eviction_thrash() {
    // Exceed the LRU capacity with distinct secrets: eviction must not
    // corrupt the surviving entries (every secret still verifies).
    for i in 0..(HMAC_KEY_CACHE_CAP * 4) {
        let secret = format!("secret-{i}").into_bytes();
        let key = hmac_key_cached(&secret);
        let data = b"payload";
        let tag = hmac::sign(&key, data);
        assert!(
            hmac::verify(&key, data, tag.as_ref()).is_ok(),
            "secret-{i} failed after cache eviction"
        );
    }
}

#[test]
fn hex_encode_c_abi_roundtrip() {
    let input = b"hello";
    let mut out = [0u8; 16];
    let written =
        unsafe { castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(written, 10);
    assert_eq!(&out[..10], b"68656c6c6f");
}

#[test]
fn hex_encode_c_abi_undersized_returns_zero() {
    let input = b"hello";
    let mut out = [0u8; 4];
    let written =
        unsafe { castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(written, 0);
}

#[test]
fn hex_decode_c_abi_roundtrip() {
    let input = b"68656c6c6f";
    let mut out = [0u8; 8];
    let written =
        unsafe { castrum_hex_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(written, 5);
    assert_eq!(&out[..5], b"hello");
}

#[test]
fn hex_decode_c_abi_rejects_invalid() {
    let bad = b"6x";
    let mut out = [0u8; 4];
    let written =
        unsafe { castrum_hex_decode(bad.as_ptr(), bad.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(written, 0);
}

#[test]
fn url_encode_c_abi() {
    let input = b"a b/c";
    let mut out = [0u8; 16];
    let written =
        unsafe { castrum_url_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(&out[..written], b"a%20b%2Fc");
}

#[test]
fn url_decode_c_abi() {
    let input = b"a%20b%2Fc";
    let mut out = [0u8; 8];
    let written =
        unsafe { castrum_url_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(&out[..written], b"a b/c");
}

#[test]
fn validators_c_abi() {
    // Values mirror the core `#[cfg(test)]` vectors in rust/util/validation.rs.
    assert_eq!(unsafe { castrum_validate_email(c"a@b.com".as_ptr()) }, 1);
    assert_eq!(
        unsafe { castrum_validate_email(c"not-an-email".as_ptr()) },
        0
    );
    assert_eq!(
        unsafe { castrum_validate_uuid(c"550e8400-e29b-41d4-a716-446655440000".as_ptr()) },
        1
    );
    assert_eq!(unsafe { castrum_validate_uuid(c"not-a-uuid".as_ptr()) }, 0);
    assert_eq!(unsafe { castrum_validate_ipv4(c"192.168.0.1".as_ptr()) }, 1);
    assert_eq!(unsafe { castrum_validate_ipv4(c"999.1.1.1".as_ptr()) }, 0);
    assert_eq!(unsafe { castrum_validate_ipv6(c"2001:db8::1".as_ptr()) }, 1);
    assert_eq!(unsafe { castrum_validate_ipv6(c"2001:::1".as_ptr()) }, 0);
}

#[test]
fn json_sum_ids_c_abi_packed_output() {
    let doc = b"[{\"id\":1},{\"id\":2},{\"id\":3}]";
    let mut out = [0u8; 9];
    let w = unsafe { castrum_json_sum_ids(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 9);
    assert_eq!(out[0], 1);
    assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 6);

    // A legit zero-sum array is still "ok" (the old scalar i64 conflated
    // this with invalid input).
    let zero = b"[{\"id\":0},{\"id\":0}]";
    let w = unsafe { castrum_json_sum_ids(zero.as_ptr(), zero.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 9);
    assert_eq!(out[0], 1);
    assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 0);

    // Invalid (non-array) input → ok=0, 1 byte.
    let w = unsafe { castrum_json_sum_ids(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 1);
    assert_eq!(out[0], 0);

    // Too-small output → exact required size (9/1), no write past cap.
    let w = unsafe { castrum_json_sum_ids(doc.as_ptr(), doc.len(), out.as_mut_ptr(), 1) };
    assert_eq!(w, 9);
    let w = unsafe { castrum_json_sum_ids(b"nope".as_ptr(), 4, out.as_mut_ptr(), 0) };
    assert_eq!(w, 1);
}

/// Test-side decoder for the packed token stream → `serde_json::Value`,
/// so the C-ABI layout is verified end-to-end without the JS side.
fn decode_packed(bytes: &[u8]) -> serde_json::Value {
    fn read_u32(p: &mut usize, b: &[u8]) -> u32 {
        let v = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
        *p += 4;
        v
    }
    fn value(p: &mut usize, b: &[u8], strings: &[&str]) -> serde_json::Value {
        let tag = b[*p];
        *p += 1;
        match tag {
            0 => serde_json::Value::Null,
            1 => serde_json::Value::Bool(false),
            2 => serde_json::Value::Bool(true),
            3 => {
                let f = f64::from_le_bytes(b[*p..*p + 8].try_into().unwrap());
                *p += 8;
                serde_json::Value::from(f)
            }
            4 => serde_json::Value::String(strings[read_u32(p, b) as usize].to_string()),
            5 => {
                // array start … array end (7)
                let mut arr = Vec::new();
                while b[*p] != 7 {
                    arr.push(value(p, b, strings));
                }
                *p += 1;
                serde_json::Value::Array(arr)
            }
            6 => {
                // object start: (9, keyIdx, value)* … object end (8)
                let mut obj = serde_json::Map::new();
                while b[*p] != 8 {
                    assert_eq!(b[*p], 9, "expected object key tag");
                    *p += 1;
                    let k = strings[read_u32(p, b) as usize];
                    obj.insert(k.to_string(), value(p, b, strings));
                }
                *p += 1;
                serde_json::Value::Object(obj)
            }
            _ => panic!("bad packed tag {tag}"),
        }
    }
    let mut p = 0usize;
    let str_count = read_u32(&mut p, bytes) as usize;
    let mut strings = Vec::with_capacity(str_count);
    for _ in 0..str_count {
        let n = read_u32(&mut p, bytes) as usize;
        strings.push(std::str::from_utf8(&bytes[p..p + n]).unwrap());
        p += n;
    }
    let tree_len = read_u32(&mut p, bytes) as usize;
    let end = p + tree_len;
    let top = value(&mut p, bytes, &strings);
    assert_eq!(p, end, "tree length must consume exactly the tree");
    assert_eq!(end, bytes.len(), "stream must end at the tree");
    top
}

/// Normalize every JSON number to f64 so int/float representations compare
/// equal — JS numbers are all doubles (`1 === 1.0`), and serde_json's
/// `Number` deliberately distinguishes them.
fn json_f64_normalize(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Number(n) => serde_json::Value::from(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(json_f64_normalize).collect())
        }
        serde_json::Value::Object(m) => serde_json::Value::Object(
            m.into_iter()
                .map(|(k, v)| (k, json_f64_normalize(v)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn json_parse_packed_c_abi() {
    // Valid JSON → packed token stream that round-trips exactly.
    let doc = br#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#;
    let mut out = [0u8; 512];
    let w =
        unsafe { castrum_json_parse_packed(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len()) };
    assert!(w > 0 && w <= out.len());
    let parsed = json_f64_normalize(decode_packed(&out[..w]));
    let expected: serde_json::Value =
        serde_json::from_str(r#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#).unwrap();
    assert_eq!(parsed, json_f64_normalize(expected));

    // Too-small output → exact required size, no write past cap.
    let mut tiny = [0u8; 4];
    let w2 = unsafe {
        castrum_json_parse_packed(doc.as_ptr(), doc.len(), tiny.as_mut_ptr(), tiny.len())
    };
    assert!(w2 > 4);

    // Invalid JSON → 0 (real error, JS growExact throws).
    let w3 = unsafe { castrum_json_parse_packed(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
    assert_eq!(w3, 0);
    // Null pointers → 0, never UB.
    let w4 = unsafe { castrum_json_parse_packed(std::ptr::null(), 0, out.as_mut_ptr(), out.len()) };
    assert_eq!(w4, 0);
}

#[test]
fn json_parse_packed_dedup_strings() {
    // Repeated keys/values must be interned ONCE into the string table so
    // the JS side decodes each unique string a single time.
    let doc = br#"[{"k":"v","n":"v"},{"k":"w","n":"v"}]"#;
    let mut out = [0u8; 512];
    let w =
        unsafe { castrum_json_parse_packed(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len()) };
    assert!(w > 0 && w <= out.len());
    // keys k,n + values v,w = 4 unique strings (not 10 raw occurrences).
    let str_count = u32::from_le_bytes(out[..4].try_into().unwrap());
    assert_eq!(str_count, 4);
    let parsed = decode_packed(&out[..w]);
    let expected: serde_json::Value =
        serde_json::from_str(r#"[{"k":"v","n":"v"},{"k":"w","n":"v"}]"#).unwrap();
    assert_eq!(parsed, expected);
}

#[test]
fn parse_media_type_c_abi_packed() {
    let ct = b"application/json; charset=utf-8; foo=bar";
    let mut out = [0u8; 256];
    let w = unsafe { castrum_parse_media_type(ct.as_ptr(), ct.len(), out.as_mut_ptr(), out.len()) };
    assert!(w > 0 && w <= out.len());

    let mut off = 0usize;
    let mt_len = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
    off += 4;
    assert_eq!(
        String::from_utf8(out[off..off + mt_len].to_vec()).unwrap(),
        "application/json"
    );
    off += mt_len;

    // charset present.
    let cs_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
    assert_ne!(cs_len, u32::MAX as usize);
    off += 4;
    assert_eq!(
        String::from_utf8(out[off..off + cs_len].to_vec()).unwrap(),
        "utf-8"
    );
    off += cs_len;

    // boundary absent → u32::MAX.
    let b_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap());
    assert_eq!(b_len, u32::MAX);
    off += 4;

    // params = charset + foo (2).
    let count = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
    assert_eq!(count, 2);
    off += 4;
    for _ in 0..count {
        let klen = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        off += klen;
        let vlen = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        off += vlen;
    }
    assert_eq!(off, w);

    // Invalid media type → 0 (real error → JS throws).
    let w = unsafe {
        castrum_parse_media_type(b"not-a-type".as_ptr(), 10, out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 0);

    // Too-small output → exact required size.
    let small_cap = 1usize;
    let w = unsafe { castrum_parse_media_type(ct.as_ptr(), ct.len(), out.as_mut_ptr(), small_cap) };
    assert!(w > small_cap);
}

#[test]
fn parse_http_date_c_abi_packed() {
    let date = b"Sun, 06 Nov 1994 08:49:37 GMT";
    let mut out = [0u8; 9];
    let w =
        unsafe { castrum_parse_http_date(date.as_ptr(), date.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 9);
    assert_eq!(out[0], 1);
    assert_eq!(
        i64::from_le_bytes(out[1..9].try_into().unwrap()),
        784_111_777
    );

    // Malformed → ok=0, 1 byte.
    let w = unsafe { castrum_parse_http_date(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 1);
    assert_eq!(out[0], 0);

    // Too-small output → exact required size (9 / 1).
    let w = unsafe { castrum_parse_http_date(date.as_ptr(), date.len(), out.as_mut_ptr(), 0) };
    assert_eq!(w, 9);
}

#[test]
fn parse_accept_encoding_c_abi_packed() {
    let header = b"gzip, deflate;q=0.5, identity;q=0.2";
    let mut out = [0u8; 256];
    let w = unsafe {
        castrum_parse_accept_encoding(header.as_ptr(), header.len(), out.as_mut_ptr(), out.len())
    };
    assert!(w > 0 && w <= out.len());

    let count = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
    assert_eq!(count, 3);
    let mut off = 4usize;
    let enc_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    assert_eq!(
        String::from_utf8(out[off..off + enc_len].to_vec()).unwrap(),
        "gzip"
    );
    off += enc_len;
    let q = f32::from_le_bytes(out[off..off + 4].try_into().unwrap());
    assert_eq!(q, 1.0);
    off += 4;
    let order = u32::from_le_bytes(out[off..off + 4].try_into().unwrap());
    assert_eq!(order, 0);

    // Empty header → count 0 (4 bytes), never an error.
    let w = unsafe { castrum_parse_accept_encoding(b"".as_ptr(), 0, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 4);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0);
}

#[test]
fn url_encode_query_c_abi() {
    // Packed [u32 count]{[u32 keyLen][key][u32 valLen][val]} — unsorted.
    let mut packed: Vec<u8> = Vec::new();
    packed.extend_from_slice(&2u32.to_le_bytes());
    for (k, v) in [("b", "2"), ("a", "1")] {
        packed.extend_from_slice(&(k.len() as u32).to_le_bytes());
        packed.extend_from_slice(k.as_bytes());
        packed.extend_from_slice(&(v.len() as u32).to_le_bytes());
        packed.extend_from_slice(v.as_bytes());
    }
    let s = unsafe { castrum_url_encode_query(packed.as_ptr(), packed.len()) };
    assert!(!s.is_null());
    assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"a=1&b=2");

    // Malformed packed input (truncated) → null.
    let malformed = [1u8, 0, 0, 0];
    let s = unsafe { castrum_url_encode_query(malformed.as_ptr(), malformed.len()) };
    assert!(s.is_null());
}

#[test]
fn url_resolve_c_abi() {
    // RFC 3986 §5.4.1: base "http://a/b/c/d;p?q" + "g" → "http://a/b/c/g".
    let base = b"http://a/b/c/d;p?q";
    let s = unsafe { castrum_url_resolve(base.as_ptr(), base.len(), b"g".as_ptr(), 1) };
    assert!(!s.is_null());
    assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"http://a/b/c/g");

    // Non-UTF-8 → null (napi parity: throws).
    let bad = [0xffu8, 0xfe, 0xfd];
    let s = unsafe { castrum_url_resolve(base.as_ptr(), base.len(), bad.as_ptr(), bad.len()) };
    assert!(s.is_null());
}

#[test]
fn url_builder_resolve_c_abi() {
    use napi::bindgen_prelude::Uint8Array;
    let b = crate::http::url_join::UrlBuilder::new(Uint8Array::new(b"http://a/b/c/d;p?q".to_vec()))
        .unwrap();
    let inner = b.inner_ptr() as usize;
    let mut out = [0u8; 256];
    // Precompiled base + "g" → "http://a/b/c/g" (RFC 3986 §5.4.1).
    let w = unsafe {
        castrum_url_builder_resolve(inner, b"g".as_ptr(), 1, out.as_mut_ptr(), out.len())
    };
    assert!(w > 0 && w <= out.len());
    assert_eq!(&out[..w], b"http://a/b/c/g");
    // Null handle → 0 (never dereferences freed state).
    let w =
        unsafe { castrum_url_builder_resolve(0, b"g".as_ptr(), 1, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 0);
    // Non-UTF-8 reference → 0 (napi parity: throws).
    let bad = [0xffu8, 0xfe];
    let w = unsafe {
        castrum_url_builder_resolve(inner, bad.as_ptr(), bad.len(), out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 0);
    // Too-small buffer → exact needed size.
    let w = unsafe { castrum_url_builder_resolve(inner, b"g".as_ptr(), 1, out.as_mut_ptr(), 1) };
    assert!(w > 1);
}

#[test]
fn media_type_matcher_matches_c_abi() {
    use napi::bindgen_prelude::Uint8Array;
    let m =
        crate::http::media_type::MediaTypeMatcher::new(Uint8Array::new(b"application/*".to_vec()))
            .unwrap();
    let inner = m.inner_ptr() as usize;
    let f = |a: &[u8]| unsafe { castrum_media_type_matcher_matches(inner, a.as_ptr(), a.len()) };
    assert_eq!(f(b"application/json"), 1);
    assert_eq!(f(b"Application/JSON"), 1); // case-insensitive
    assert_eq!(f(b"text/html"), 0);
    assert_eq!(
        unsafe { castrum_media_type_matcher_matches(0, b"a".as_ptr(), 1) },
        0
    ); // null handle
}

#[test]
fn accept_negotiator_negotiate_c_abi() {
    let n = crate::http::accept::AcceptNegotiator::new(vec!["gzip".to_string()]);
    let inner = n.inner_ptr() as usize;
    let f = |h: &[u8]| -> Option<Vec<u8>> {
        let s = unsafe { castrum_accept_negotiator_negotiate(inner, h.as_ptr(), h.len()) };
        if s.is_null() {
            None
        } else {
            unsafe { cstr_bytes(s) }
        }
    };
    assert_eq!(f(b"gzip, deflate;q=0.5"), Some(b"gzip".to_vec()));
    assert_eq!(f(b"identity;q=0.9"), None); // no supported match → identity
    assert!(unsafe { castrum_accept_negotiator_negotiate(0, b"gzip".as_ptr(), 4) }.is_null());
}

#[test]
fn accept_negotiator_negotiate_server_c_abi() {
    use crate::http::accept::AcceptNegotiator;
    let n = AcceptNegotiator::new(vec!["br".to_string(), "gzip".to_string()]);
    let inner = n.inner_ptr() as usize;
    let f = |h: &std::ffi::CStr| -> Option<Vec<u8>> {
        let s = unsafe { castrum_accept_negotiator_negotiate_server(inner, h.as_ptr()) };
        if s.is_null() {
            None
        } else {
            unsafe { cstr_bytes(s) }
        }
    };
    // Server-preference: tie → first supported (br), NOT client order.
    assert_eq!(f(c"gzip, br"), Some(b"br".to_vec()));
    assert_eq!(f(c"br;q=0.8, gzip;q=0.9"), Some(b"gzip".to_vec()));
    assert_eq!(f(c"*"), Some(b"br".to_vec()));
    assert_eq!(f(c"gzip;q=0"), None); // q=0 excluded, no wildcard
    assert_eq!(f(c""), None); // empty → identity (server-pref differs from client-order)
    assert!(unsafe { castrum_accept_negotiator_negotiate_server(0, c"gzip".as_ptr()) }.is_null());
}

#[test]
fn jwt_signer_sign_verify_c_abi() {
    use napi::bindgen_prelude::Uint8Array;
    let s = crate::crypto::jwt::JwtSigner::new(Uint8Array::new(b"my-secret".to_vec()), Some(0));
    let inner = s.inner_ptr() as usize;
    let claims = b"{\"sub\":\"user-1\"}";
    let mut out = [0u8; 512];
    let mut vout = [0u8; 512];
    let w = unsafe {
        castrum_jwt_signer_sign(
            inner,
            claims.as_ptr(),
            claims.len(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(w > 0 && w <= out.len());
    let token = &out[..w];
    assert_eq!(token.iter().filter(|&&b| b == b'.').count(), 2);
    // Verify round-trip → claims JSON.
    let vw = unsafe {
        castrum_jwt_signer_verify(
            inner,
            token.as_ptr(),
            token.len(),
            0,
            vout.as_mut_ptr(),
            vout.len(),
        )
    };
    assert!(vw > 0);
    assert!(String::from_utf8(vout[..vw].to_vec())
        .unwrap()
        .contains("\"sub\":\"user-1\""));
    // Tampered → 0 (invalid).
    let mut bad = token.to_vec();
    let last = bad.len() - 1;
    bad[last] ^= 0x01;
    let bw = unsafe {
        castrum_jwt_signer_verify(
            inner,
            bad.as_ptr(),
            bad.len(),
            0,
            vout.as_mut_ptr(),
            vout.len(),
        )
    };
    assert_eq!(bw, 0);
    // Invalid claims JSON → 0; null handle → 0.
    let w = unsafe {
        castrum_jwt_signer_sign(inner, b"nope".as_ptr(), 4, 0, out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 0);
    let w = unsafe {
        castrum_jwt_signer_sign(
            0,
            claims.as_ptr(),
            claims.len(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(w, 0);
}

#[test]
fn template_render_c_abi() {
    let t =
        crate::payload::template::TemplateRenderer::new("Hello {{ name }}!".to_string()).unwrap();
    let inner = t.inner_ptr() as usize;
    let ctx = b"{\"name\":\"world\"}";
    let mut out = [0u8; 128];
    let w = unsafe {
        castrum_template_render(inner, ctx.as_ptr(), ctx.len(), out.as_mut_ptr(), out.len())
    };
    assert!(w > 0);
    assert_eq!(&out[..w], b"Hello world!");
    // Invalid context JSON → 0; null handle → 0.
    let w =
        unsafe { castrum_template_render(inner, b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 0);
    let w =
        unsafe { castrum_template_render(0, ctx.as_ptr(), ctx.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 0);
}

#[test]
fn schema_validator_validate_c_abi() {
    use napi::bindgen_prelude::Uint8Array;
    let schema =
        b"{\"type\":\"object\",\"required\":[\"a\"],\"properties\":{\"a\":{\"type\":\"number\"}}}";
    let v =
        crate::json::json_schema::SchemaValidator::new(Uint8Array::new(schema.to_vec())).unwrap();
    let inner = v.inner_ptr() as usize;
    let f = |d: &[u8]| unsafe { castrum_schema_validator_validate(inner, d.as_ptr(), d.len()) };
    assert_eq!(f(b"{\"a\":1}"), 1);
    assert_eq!(f(b"{}"), 0); // missing required "a"
    assert_eq!(f(b"not-json"), 0);
    assert_eq!(
        unsafe { castrum_schema_validator_validate(0, b"{}".as_ptr(), 2) },
        0
    );
}

#[test]
fn rate_limiter_check_c_abi() {
    let r = crate::ingress::rate_limit::RateLimiter::new(2, 60_000, Some(1024));
    let inner = r.inner_ptr() as usize;
    let now = 1_700_000_000_000i64;
    let key = c"user-42";
    let mut out = [0u8; 13];
    let w = unsafe {
        castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 13);
    assert_eq!(out[0], 1); // allowed (1/2)
    unsafe { castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len()) };
    let w = unsafe {
        castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 13);
    assert_eq!(out[0], 0); // blocked (3/2)
                           // Pre-hashed check_key shares the SAME budget.
    let hashed = crate::crypto::hashing::fast_hash_bytes(key.to_bytes());
    let w = unsafe {
        castrum_rate_limiter_check_key(inner, hashed as i64, now, out.as_mut_ptr(), out.len())
    };
    assert_eq!(w, 13);
    assert_eq!(out[0], 0);
    // Null handle → 0; too-small → exact needed size.
    let w =
        unsafe { castrum_rate_limiter_check(0, key.as_ptr(), now, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 0);
    let w = unsafe { castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), 1) };
    assert_eq!(w, 13);
}

#[test]
fn mime_from_extension_c_abi() {
    let s = unsafe { castrum_mime_from_extension(c".js".as_ptr()) };
    assert!(!s.is_null());
    assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"text/javascript");

    // Unknown extension → application/octet-stream (never null).
    let s = unsafe { castrum_mime_from_extension(c"nope".as_ptr()) };
    assert!(!s.is_null());
    assert_eq!(
        unsafe { cstr_bytes(s) }.unwrap(),
        b"application/octet-stream"
    );
}

#[test]
fn conditional_is_not_modified_c_abi() {
    use napi::bindgen_prelude::Uint8Array;
    let c = crate::http::etag::ConditionalRequest::new(
        Uint8Array::new(b"\"abc123\"".to_vec()),
        Some(784_111_777f64),
    );
    let inner = c.inner_ptr() as usize;
    let f = |flags: u8, inm: Option<&[u8]>, ims: Option<&[u8]>| -> u8 {
        let (ip, il) = inm.map_or((std::ptr::null(), 0usize), |s| (s.as_ptr(), s.len()));
        let (sp, sl) = ims.map_or((std::ptr::null(), 0usize), |s| (s.as_ptr(), s.len()));
        unsafe { castrum_conditional_is_not_modified(inner, ip, il, sp, sl, flags) }
    };
    // If-None-Match "*" → 304.
    assert_eq!(f(1, Some(b"*"), None), 1);
    // Exact etag → 304; weak compare W/"abc123" → 304.
    assert_eq!(f(1, Some(b"\"abc123\""), None), 1);
    assert_eq!(f(1, Some(b"W/\"abc123\""), None), 1);
    // Non-matching list → not 304.
    assert_eq!(f(1, Some(b"\"xyz\", \"other\""), None), 0);
    // If-Modified-Since == lastModified → 304; 1s before → not 304.
    assert_eq!(f(2, None, Some(b"Sun, 06 Nov 1994 08:49:37 GMT")), 1);
    assert_eq!(f(2, None, Some(b"Sun, 06 Nov 1994 08:49:36 GMT")), 0);
    // Absent flags → not 304 (nothing to match).
    assert_eq!(f(0, None, None), 0);
    // Null handle → 0 (never dereferences freed state).
    assert_eq!(
        unsafe {
            castrum_conditional_is_not_modified(0, std::ptr::null(), 0, std::ptr::null(), 0, 0)
        },
        0
    );
}

#[test]
fn ws_accept_key_c_abi_rfc6455() {
    // RFC 6455 Sec-WebSocket-Accept test vector.
    let key = c"dGhlIHNhbXBsZSBub25jZQ==";
    let accept = unsafe { castrum_ws_accept_key(key.as_ptr()) };
    assert!(!accept.is_null());
    let bytes = unsafe { cstr_bytes(accept) }.unwrap();
    assert_eq!(bytes, b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

#[test]
fn etag_c_abi() {
    let data = b"hello";
    let strong = unsafe { castrum_etag(data.as_ptr(), data.len(), 0) };
    assert!(!strong.is_null());
    let strong_bytes = unsafe { cstr_bytes(strong) }.unwrap();
    let crc = crc32fast::hash(b"hello");
    let expected = format!("\"{crc:08x}\"");
    assert_eq!(strong_bytes, expected.as_bytes());

    let weak = unsafe { castrum_etag(data.as_ptr(), data.len(), 1) };
    assert!(!weak.is_null());
    let weak_bytes = unsafe { cstr_bytes(weak) }.unwrap();
    assert_eq!(&weak_bytes[..2], b"W/");
}

#[test]
fn random_token_c_abi() {
    let t = unsafe { castrum_random_token(16) };
    assert!(!t.is_null());
    let bytes = unsafe { cstr_bytes(t) }.unwrap();
    assert_eq!(bytes.len(), 32);
    assert!(bytes.iter().all(u8::is_ascii_hexdigit));
    // byte_len 0 → valid empty string, not null.
    assert!(!unsafe { castrum_random_token(0) }.is_null());
    // Huge len → null (real error).
    assert!(unsafe { castrum_random_token(u32::MAX) }.is_null());
}

#[test]
fn random_token_into_c_abi() {
    let mut out = [0u8; 64];
    let w = unsafe { castrum_random_token_into(16, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 32);
    assert!(out[..32].iter().all(u8::is_ascii_hexdigit));
    // Too-small buffer → exact needed size (not a partial write).
    let mut small = [0u8; 16];
    let w2 = unsafe { castrum_random_token_into(16, small.as_mut_ptr(), small.len()) };
    assert_eq!(w2, 32);
    assert_eq!(&small[..], &[0u8; 16]);
    // byte_len 0 → writes 0 bytes.
    let mut zero = [0u8; 4];
    let w3 = unsafe { castrum_random_token_into(0, zero.as_mut_ptr(), zero.len()) };
    assert_eq!(w3, 0);
    // Huge len → 0 (real error); null out → 0.
    assert_eq!(
        unsafe { castrum_random_token_into(u32::MAX, out.as_mut_ptr(), out.len()) },
        0
    );
    assert_eq!(
        unsafe { castrum_random_token_into(16, std::ptr::null_mut(), 0) },
        0
    );
}

#[test]
fn cstring_into_variants_match_cstring() {
    // ws_accept_key: into == cstring bytes. The `_into` sibling keeps the
    // `(ptr,len)` byte form; the cstring variant takes a NUL-terminated arg.
    let key = b"dGhlIHNhbXBsZSBub25jZQ==";
    let key_c = c"dGhlIHNhbXBsZSBub25jZQ==";
    let mut out = [0u8; 28];
    let w =
        unsafe { castrum_ws_accept_key_into(key.as_ptr(), key.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 28);
    let cstr_result = unsafe { cstr_bytes(castrum_ws_accept_key(key_c.as_ptr())) }.unwrap();
    assert_eq!(&out[..], &cstr_result[..]);
    // Too-small → 28.
    let mut small = [0u8; 8];
    assert_eq!(
        unsafe {
            castrum_ws_accept_key_into(key.as_ptr(), key.len(), small.as_mut_ptr(), small.len())
        },
        28
    );

    // etag strong/weak.
    let data = b"hello";
    for weak in [0u8, 1u8] {
        let mut eout = [0u8; 16];
        let ew = unsafe {
            castrum_etag_into(
                data.as_ptr(),
                data.len(),
                weak,
                eout.as_mut_ptr(),
                eout.len(),
            )
        };
        let expect = if weak != 0 { 12 } else { 10 };
        assert_eq!(ew, expect);
        let ecstr_result =
            unsafe { cstr_bytes(castrum_etag(data.as_ptr(), data.len(), weak)) }.unwrap();
        assert_eq!(&eout[..ew], &ecstr_result[..]);
    }

    // sign/verify cookie round-trip via into.
    let value = b"session=abc123";
    let secret = b"secret-key";
    let mut sout = [0u8; 256];
    let sw = unsafe {
        castrum_sign_cookie_into(
            value.as_ptr(),
            value.len(),
            secret.as_ptr(),
            secret.len(),
            sout.as_mut_ptr(),
            sout.len(),
        )
    };
    assert_eq!(sw, value.len() + 65);
    let signed = &sout[..sw];
    // Cross-check against the cstring path.
    let scstr_result = unsafe {
        cstr_bytes(castrum_sign_cookie(
            value.as_ptr(),
            value.len(),
            secret.as_ptr(),
            secret.len(),
        ))
    }
    .unwrap();
    assert_eq!(signed, &scstr_result[..]);
    // Verify via into.
    let mut vout = [0u8; 256];
    let vw = unsafe {
        castrum_verify_cookie_into(
            signed.as_ptr(),
            signed.len(),
            secret.as_ptr(),
            secret.len(),
            vout.as_mut_ptr(),
            vout.len(),
        )
    };
    assert_eq!(vw, value.len());
    assert_eq!(&vout[..vw], value);
    // Tampered → 0.
    let mut tampered = signed.to_vec();
    tampered[0] ^= 1;
    let vw0 = unsafe {
        castrum_verify_cookie_into(
            tampered.as_ptr(),
            tampered.len(),
            secret.as_ptr(),
            secret.len(),
            vout.as_mut_ptr(),
            vout.len(),
        )
    };
    assert_eq!(vw0, 0);

    // csrf_token into: 129 bytes, hex.hex.
    let mut cout = [0u8; 129];
    let cw = unsafe {
        castrum_csrf_token_into(secret.as_ptr(), secret.len(), cout.as_mut_ptr(), cout.len())
    };
    assert_eq!(cw, 129);
    assert_eq!(cout[64], b'.');
    assert!(cout[..64].iter().all(u8::is_ascii_hexdigit));
    assert!(cout[65..].iter().all(u8::is_ascii_hexdigit));
    // Too-small → 129.
    let mut csmall = [0u8; 8];
    assert_eq!(
        unsafe {
            castrum_csrf_token_into(
                secret.as_ptr(),
                secret.len(),
                csmall.as_mut_ptr(),
                csmall.len(),
            )
        },
        129
    );

    // jwt_sign_bytes into == cstring.
    let claims = b"{\"sub\":\"user-1\"}";
    let mut jout = [0u8; 512];
    let jw = unsafe {
        castrum_jwt_sign_bytes_into(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            0,
            0,
            jout.as_mut_ptr(),
            jout.len(),
        )
    };
    assert!(jw > 0);
    let jcstr = unsafe {
        cstr_bytes(castrum_jwt_sign_bytes(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            0,
            0,
        ))
    }
    .unwrap();
    assert_eq!(&jout[..jw], &jcstr[..]);
}

#[test]
fn base64_c_abi_roundtrip() {
    let data = b"hello world";
    let mut enc = [0u8; 32];
    let w = unsafe {
        castrum_base64_encode(data.as_ptr(), data.len(), enc.as_mut_ptr(), enc.len(), 0, 1)
    };
    assert_eq!(&enc[..w], b"aGVsbG8gd29ybGQ=");
    let mut dec = [0u8; 32];
    let d = unsafe { castrum_base64_decode(enc.as_ptr(), w, dec.as_mut_ptr(), dec.len(), 0, 1) };
    assert_eq!(&dec[..d], data);
    // Invalid input → 0.
    assert_eq!(
        unsafe { castrum_base64_decode(b"!!!".as_ptr(), 3, dec.as_mut_ptr(), dec.len(), 0, 1) },
        0
    );
}

#[test]
fn hmac_c_abi() {
    let key = b"key";
    let data = b"The quick brown fox jumps over the lazy dog";
    let mut out = [0u8; 64];
    let w = unsafe {
        castrum_hmac_sha256(
            key.as_ptr(),
            key.len(),
            data.as_ptr(),
            data.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(w, 64);
    assert_eq!(
        &out[..],
        b"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
    let ok = unsafe {
        castrum_hmac_sha256_verify(
            key.as_ptr(),
            key.len(),
            data.as_ptr(),
            data.len(),
            out.as_ptr(),
            out.len(),
        )
    };
    assert_eq!(ok, 1);
    out[0] ^= 1;
    let bad = unsafe {
        castrum_hmac_sha256_verify(
            key.as_ptr(),
            key.len(),
            data.as_ptr(),
            data.len(),
            out.as_ptr(),
            out.len(),
        )
    };
    assert_eq!(bad, 0);
}

#[test]
fn sign_verify_cookie_c_abi() {
    let value = b"session=abc";
    let secret = b"secret-key";
    let signed =
        unsafe { castrum_sign_cookie(value.as_ptr(), value.len(), secret.as_ptr(), secret.len()) };
    assert!(!signed.is_null());
    let signed_bytes = unsafe { cstr_bytes(signed) }.unwrap();
    assert!(signed_bytes.len() > value.len());

    let verified = unsafe {
        castrum_verify_cookie(
            signed_bytes.as_ptr(),
            signed_bytes.len(),
            secret.as_ptr(),
            secret.len(),
        )
    };
    assert!(!verified.is_null());
    let out = unsafe { cstr_bytes(verified) }.unwrap();
    assert_eq!(out, value);

    // Tampered signature → null.
    let mut tampered = signed_bytes.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    let bad = unsafe {
        castrum_verify_cookie(
            tampered.as_ptr(),
            tampered.len(),
            secret.as_ptr(),
            secret.len(),
        )
    };
    assert!(bad.is_null());
}

#[test]
fn csrf_c_abi() {
    let secret = b"csrf-secret";
    let token = unsafe { castrum_csrf_token(secret.as_ptr(), secret.len()) };
    assert!(!token.is_null());
    let token_bytes = unsafe { cstr_bytes(token) }.unwrap();
    assert_eq!(token_bytes.len(), 129);
    assert_eq!(token_bytes[64], b'.');
    let ok = unsafe {
        castrum_csrf_verify(
            token_bytes.as_ptr(),
            token_bytes.len(),
            secret.as_ptr(),
            secret.len(),
        )
    };
    assert_eq!(ok, 1);
    // Wrong secret → 0.
    let bad = unsafe {
        castrum_csrf_verify(
            token_bytes.as_ptr(),
            token_bytes.len(),
            b"other".as_ptr(),
            5,
        )
    };
    assert_eq!(bad, 0);
}

#[test]
fn password_hash_verify_c_abi() {
    let pw = b"hunter2";
    let salt = b"saltsalt";
    let mut phc = [0u8; 512];
    let w = unsafe {
        castrum_password_hash(
            pw.as_ptr(),
            pw.len(),
            salt.as_ptr(),
            salt.len(),
            19_456,
            2,
            1,
            32,
            phc.as_mut_ptr(),
            phc.len(),
        )
    };
    assert!(w > 0);
    let ok = unsafe { castrum_password_verify(pw.as_ptr(), pw.len(), phc.as_ptr(), w) };
    assert_eq!(ok, 1);
    let bad = unsafe { castrum_password_verify(b"wrong".as_ptr(), 5, phc.as_ptr(), w) };
    assert_eq!(bad, 0);
}

#[test]
fn bcrypt_c_abi() {
    let pw = b"hunter2";
    let mut phc = [0u8; 128];
    let w = unsafe {
        castrum_password_hash_bcrypt(pw.as_ptr(), pw.len(), 4, phc.as_mut_ptr(), phc.len())
    };
    assert!(w > 0);
    assert_eq!(&phc[..4], b"$2b$");
    // The hash crosses as a NUL-terminated C string (like the engine's
    // `cstring` arg transcode) — CString::new makes that explicit.
    let phc_c = std::ffi::CString::new(&phc[..w]).unwrap();
    let ok = unsafe { castrum_password_verify_bcrypt(pw.as_ptr(), pw.len(), phc_c.as_ptr()) };
    assert_eq!(ok, 1);
}

#[test]
fn pbkdf2_c_abi_matches_napi() {
    let pw = b"password";
    let salt = b"salt";
    let mut out = [0u8; 32];
    let w = unsafe {
        castrum_pbkdf2_sha256(
            pw.as_ptr(),
            pw.len(),
            salt.as_ptr(),
            salt.len(),
            1,
            32,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(w, 32);
    // Cross-check against the napi fn (which pins the RFC 7914 vector).
    let napi = crate::crypto::pbkdf2::pbkdf2_sha256(
        napi::bindgen_prelude::Uint8Array::new(pw.to_vec()),
        napi::bindgen_prelude::Uint8Array::new(salt.to_vec()),
        1,
        32,
    )
    .unwrap();
    assert_eq!(&out[..], napi.as_ref());
    // Too-small buffer → 0.
    let mut tiny = [0u8; 4];
    assert_eq!(
        unsafe {
            castrum_pbkdf2_sha256(
                pw.as_ptr(),
                pw.len(),
                salt.as_ptr(),
                salt.len(),
                1,
                32,
                tiny.as_mut_ptr(),
                tiny.len(),
            )
        },
        0
    );
}

#[test]
fn aead_c_abi_roundtrip() {
    let key = b"0123456789abcdef0123456789abcdef"; // 32 bytes
    let nonce = b"123456789012"; // 12 bytes
    let plaintext = b"sensitive payload";
    let mut ct = [0u8; 128];
    let w = unsafe {
        castrum_aead_encrypt(
            key.as_ptr(),
            key.len(),
            nonce.as_ptr(),
            nonce.len(),
            plaintext.as_ptr(),
            plaintext.len(),
            0,
            ct.as_mut_ptr(),
            ct.len(),
        )
    };
    assert_eq!(w, plaintext.len() + 16);
    let mut pt = [0u8; 128];
    let d = unsafe {
        castrum_aead_decrypt(
            key.as_ptr(),
            key.len(),
            nonce.as_ptr(),
            nonce.len(),
            ct.as_ptr(),
            w,
            0,
            pt.as_mut_ptr(),
            pt.len(),
        )
    };
    assert_eq!(&pt[..d], plaintext);
    // Tampered ciphertext → auth failure → 0.
    ct[0] ^= 1;
    let bad = unsafe {
        castrum_aead_decrypt(
            key.as_ptr(),
            key.len(),
            nonce.as_ptr(),
            nonce.len(),
            ct.as_ptr(),
            w,
            0,
            pt.as_mut_ptr(),
            pt.len(),
        )
    };
    assert_eq!(bad, 0);
}

#[test]
fn ws_frame_encode_c_abi() {
    let payload = b"hello";
    let mut out = [0u8; 32];
    let w = unsafe {
        castrum_ws_frame_encode(
            1,
            payload.as_ptr(),
            payload.len(),
            1,
            1,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    // masked text frame, fin: 0x81, len 5 | 0x80, 4-byte mask + payload.
    assert_eq!(w, 2 + 4 + payload.len());
    assert_eq!(out[0], 0x81);
    assert_eq!(out[1], 0x80 | payload.len() as u8);
}

#[test]
fn json_patch_c_abi() {
    let doc = br#"{"a":1}"#;
    let patch = br#"[{"op":"add","path":"/b","value":2}]"#;
    let mut out = [0u8; 64];
    let w = unsafe {
        castrum_json_patch(
            doc.as_ptr(),
            doc.len(),
            patch.as_ptr(),
            patch.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };
    let patched: serde_json::Value = serde_json::from_slice(&out[..w]).unwrap();
    assert_eq!(patched["b"], 2);
}

#[test]
fn gzip_brotli_c_abi_roundtrip() {
    let data = b"the quick brown fox jumps over the lazy dog ".repeat(10);
    let mut comp = [0u8; 1024];
    let cw = unsafe {
        castrum_gzip_compress(data.as_ptr(), data.len(), 6, comp.as_mut_ptr(), comp.len())
    };
    assert!(cw > 0 && cw < data.len());
    let mut decomp = [0u8; 1024];
    let dw = unsafe {
        castrum_gzip_decompress(
            comp.as_ptr(),
            cw,
            1024 * 1024,
            decomp.as_mut_ptr(),
            decomp.len(),
        )
    };
    assert_eq!(&decomp[..dw], data);

    let mut bcomp = [0u8; 2048];
    let bw = unsafe {
        castrum_brotli_compress(
            data.as_ptr(),
            data.len(),
            5,
            bcomp.as_mut_ptr(),
            bcomp.len(),
        )
    };
    assert!(bw > 0);
    let mut bdecomp = [0u8; 1024];
    let bdw = unsafe {
        castrum_brotli_decompress(
            bcomp.as_ptr(),
            bw,
            1024 * 1024,
            bdecomp.as_mut_ptr(),
            bdecomp.len(),
        )
    };
    assert_eq!(&bdecomp[..bdw], data);
}

#[test]
fn gzip_isize_c_abi() {
    // ISIZE trailer of a standard gzip stream → exact uncompressed size.
    let data = b"the quick brown fox jumps over the lazy dog ".repeat(4);
    let mut comp = [0u8; 512];
    let cw = unsafe {
        castrum_gzip_compress(data.as_ptr(), data.len(), 6, comp.as_mut_ptr(), comp.len())
    };
    assert!(cw > 0);
    let isize = unsafe { castrum_gzip_isize(comp.as_ptr(), cw) };
    assert_eq!(isize as usize, data.len());
    // Not gzip magic → 0.
    assert_eq!(
        unsafe { castrum_gzip_isize(b"hello world, this is not gzip at all".as_ptr(), 40) },
        0
    );
    // Too short → 0.
    assert_eq!(unsafe { castrum_gzip_isize(b"\x1f\x8b".as_ptr(), 2) }, 0);
}

#[test]
fn needed_size_convention_c_abi() {
    // gzip compress into a too-small buffer returns the EXACT needed size
    // (> out_cap), NOT 0 — so the JS wrapper allocates once and retries
    // instead of re-running the whole compression in a grow loop.
    let data = b"compress me to prove the needed-size convention works".repeat(20);
    let mut tiny = [0u8; 4];
    let needed = unsafe {
        castrum_gzip_compress(data.as_ptr(), data.len(), 6, tiny.as_mut_ptr(), tiny.len())
    };
    assert!(needed > tiny.len());
    // Allocating exactly `needed` succeeds in one retry.
    let mut exact = vec![0u8; needed];
    let w = unsafe {
        castrum_gzip_compress(
            data.as_ptr(),
            data.len(),
            6,
            exact.as_mut_ptr(),
            exact.len(),
        )
    };
    assert_eq!(w, needed);
    // Invalid input → 0 (a REAL error, not "too small").
    let mut out = [0u8; 256];
    let err = unsafe {
        castrum_gzip_decompress(
            b"not-a-gzip-stream".as_ptr(),
            17,
            1024 * 1024,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(err, 0);

    // jsonPatch: too-small returns the exact needed size.
    let doc = br#"{"a":1,"b":2,"c":3}"#;
    let patch = br#"[{"op":"add","path":"/d","value":4}]"#;
    let mut ptiny = [0u8; 4];
    let pneed = unsafe {
        castrum_json_patch(
            doc.as_ptr(),
            doc.len(),
            patch.as_ptr(),
            patch.len(),
            ptiny.as_mut_ptr(),
            ptiny.len(),
        )
    };
    assert!(pneed > ptiny.len());
    let mut pexact = vec![0u8; pneed];
    let pw = unsafe {
        castrum_json_patch(
            doc.as_ptr(),
            doc.len(),
            patch.as_ptr(),
            patch.len(),
            pexact.as_mut_ptr(),
            pexact.len(),
        )
    };
    assert_eq!(pw, pneed);

    // jwtSignBytes: cstring return — the engine clones the token string.
    let claims = br#"{"sub":"user-1"}"#;
    let secret = b"my-secret";
    let jp = unsafe {
        castrum_jwt_sign_bytes(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            60,
            1_700_000_000,
        )
    };
    assert!(!jp.is_null());
    let jtoken = unsafe { cstr_bytes(jp) }.unwrap();
    assert!(!jtoken.is_empty());
    assert_eq!(jtoken.iter().filter(|&&b| b == b'.').count(), 2);

    // passwordHash (argon2) too-small returns the exact PHC length.
    let pw = b"hunter2";
    let salt = b"saltsalt";
    let mut tiny = [0u8; 8];
    let hneed = unsafe {
        castrum_password_hash(
            pw.as_ptr(),
            pw.len(),
            salt.as_ptr(),
            salt.len(),
            19_456,
            2,
            1,
            32,
            tiny.as_mut_ptr(),
            tiny.len(),
        )
    };
    assert!(hneed > tiny.len());
    let mut hexact = vec![0u8; hneed];
    let hw = unsafe {
        castrum_password_hash(
            pw.as_ptr(),
            pw.len(),
            salt.as_ptr(),
            salt.len(),
            19_456,
            2,
            1,
            32,
            hexact.as_mut_ptr(),
            hexact.len(),
        )
    };
    assert_eq!(hw, hneed);
}

#[test]
fn packed_parsers_c_abi() {
    // HTTP request line + headers → packed output.
    let req = b"GET /api/users?page=1 HTTP/1.1\r\nhost: example.com\r\n\r\n";
    let mut out = [0u8; 256];
    let w = unsafe {
        castrum_http_parse_request_packed(req.as_ptr(), req.len(), out.as_mut_ptr(), out.len())
    };
    assert!(w > 0);

    let query = b"a=1&b=hello%20world";
    let mut qout = [0u8; 256];
    let qw = unsafe {
        castrum_query_parse_packed(query.as_ptr(), query.len(), qout.as_mut_ptr(), qout.len())
    };
    assert!(qw > 0);

    let cookie = b"sid=abc123; theme=dark";
    let mut cout = [0u8; 256];
    let cw = unsafe {
        castrum_cookie_parse_packed(cookie.as_ptr(), cookie.len(), cout.as_mut_ptr(), cout.len())
    };
    assert!(cw > 0);
}

#[test]
fn packed_parsers_needed_size_c_abi() {
    // The packed pair writers + JSON-text writers report the EXACT needed
    // size on a too-small buffer (growExact), and 0 stays a real error
    // (malformed %XX). This removes the JS 9×/8× pre-size AND the re-run
    // loop — a miss allocates once and retries.
    let too_small = [0u8; 8];

    // query → packed pairs (strict writer; malformed %XX is a real error).
    let q = b"a=1&b=hello%20world&c=2";
    let qneed = unsafe {
        castrum_query_parse_packed(
            q.as_ptr(),
            q.len(),
            too_small.as_ptr() as *mut u8,
            too_small.len(),
        )
    };
    assert!(qneed > too_small.len());
    let mut qexact = vec![0u8; qneed];
    let qw = unsafe {
        castrum_query_parse_packed(q.as_ptr(), q.len(), qexact.as_mut_ptr(), qexact.len())
    };
    assert_eq!(qw, qneed);

    // cookie → packed pairs.
    let c = b"sid=abc123; theme=dark";
    let cneed = unsafe {
        castrum_cookie_parse_packed(
            c.as_ptr(),
            c.len(),
            too_small.as_ptr() as *mut u8,
            too_small.len(),
        )
    };
    assert!(cneed > too_small.len());
    let mut cexact = vec![0u8; cneed];
    let cw = unsafe {
        castrum_cookie_parse_packed(c.as_ptr(), c.len(), cexact.as_mut_ptr(), cexact.len())
    };
    assert_eq!(cw, cneed);
}

#[test]
fn form_parse_packed_c_abi_matches_query() {
    let input = b"a=1&b=hello%20world";
    let mut out = [0u8; 256];
    let w = unsafe {
        castrum_form_parse_packed(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
    };
    assert!(w > 0);
    // Two pairs, matching the query core.
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 2);
}

#[test]
fn multipart_parse_packed_c_abi() {
    let boundary = b"----boundary";
    let bstr = std::str::from_utf8(boundary).unwrap();
    let body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nvalue\r\n--{b}--",
        b = bstr
    );
    let mut out = [0u8; 256];
    let w = unsafe {
        castrum_multipart_parse_packed(
            body.as_ptr(),
            body.len(),
            boundary.as_ptr(),
            boundary.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(w > 0);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 1);
    // Malformed (wrong boundary) → empty parts → 4-byte count only.
    let w2 = unsafe {
        castrum_multipart_parse_packed(
            body.as_ptr(),
            body.len(),
            b"----nope".as_ptr(),
            9,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(w2 >= 4);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0);
}

#[test]
fn ws_frame_decode_packed_c_abi() {
    let payload = b"hello";
    let mut frame = [0u8; 32];
    let fw = unsafe {
        castrum_ws_frame_encode(
            1,
            payload.as_ptr(),
            payload.len(),
            1,
            1,
            frame.as_mut_ptr(),
            frame.len(),
        )
    };
    let mut out = [0u8; 64];
    let w =
        unsafe { castrum_ws_frame_decode_packed(frame.as_ptr(), fw, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 6 + payload.len());
    assert_eq!(out[0], 1); // fin
    assert_eq!(out[1], 1); // opcode text
    assert_eq!(u32::from_le_bytes(out[2..6].try_into().unwrap()), 5);
    assert_eq!(&out[6..w], payload);
    // Truncated frame → 0.
    let bad =
        unsafe { castrum_ws_frame_decode_packed(b"\x80".as_ptr(), 1, out.as_mut_ptr(), out.len()) };
    assert_eq!(bad, 0);
}

#[test]
fn jwt_sign_bytes_c_abi() {
    let claims = br#"{"sub":"user-1"}"#;
    let secret = b"my-secret";
    let signed = unsafe {
        castrum_jwt_sign_bytes(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            60,
            1_700_000_000,
        )
    };
    assert!(!signed.is_null());
    let token = unsafe { cstr_bytes(signed) }.unwrap();
    // Compact JWT: header.payload.sig → exactly two dots.
    assert_eq!(token.iter().filter(|&&b| b == b'.').count(), 2);
    assert!(crate::crypto::jwt::verify_signature_with_key(
        &token,
        &hmac_key(secret)
    ));

    // ttl <= 0 → no iat/exp injection (still signs).
    let s0 = unsafe {
        castrum_jwt_sign_bytes(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            0,
            1_700_000_000,
        )
    };
    assert!(!s0.is_null());
    // Invalid claims JSON → null.
    let bad = unsafe {
        castrum_jwt_sign_bytes(
            b"not-json".as_ptr(),
            8,
            secret.as_ptr(),
            secret.len(),
            60,
            1,
        )
    };
    assert!(bad.is_null());
}

#[test]
fn jwt_verify_c_abi() {
    let claims = br#"{"sub":"user-1"}"#;
    let secret = b"my-secret";
    let signed = unsafe {
        castrum_jwt_sign_bytes(
            claims.as_ptr(),
            claims.len(),
            secret.as_ptr(),
            secret.len(),
            60,
            1_700_000_000,
        )
    };
    assert!(!signed.is_null());
    let token = unsafe { cstr_bytes(signed) }.unwrap();

    // Valid within TTL → claims JSON.
    let verified = unsafe {
        castrum_jwt_verify(
            token.as_ptr(),
            token.len(),
            secret.as_ptr(),
            secret.len(),
            1_700_000_030,
        )
    };
    assert!(!verified.is_null());
    let claims_json = unsafe { cstr_bytes(verified) }.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&claims_json).unwrap();
    assert_eq!(parsed["sub"], "user-1");

    // Expired (now beyond exp) → null.
    let expired = unsafe {
        castrum_jwt_verify(
            token.as_ptr(),
            token.len(),
            secret.as_ptr(),
            secret.len(),
            1_700_000_100,
        )
    };
    assert!(expired.is_null());

    // Wrong secret → null.
    let wrong = unsafe {
        castrum_jwt_verify(
            token.as_ptr(),
            token.len(),
            b"other".as_ptr(),
            5,
            1_700_000_030,
        )
    };
    assert!(wrong.is_null());
}

#[test]
fn ingress_handle_packed_c_abi() {
    use crate::ingress::cors::CorsEngine;
    use crate::ingress::options::Limits;
    use crate::ingress::rate_limit::RateLimiterState;

    let inner = crate::ingress::IngressInner {
        https_fixed: None,
        max_body_bytes: 1_048_576,
        proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
        parse_cookies: false,
        parse_query: false,
        require_json_body: false,
        guard_enabled: true,
        emit_metadata_json: false,
        cors_enabled: false,
        cors: CorsEngine::disabled(),
        rate: RateLimiterState::Disabled,
        schema: None,
        limits: Limits::default(),
    };
    // Packed frame: [method 0 = GET][url][ip][rid] sections + empty headers.
    let mut input = Vec::new();
    input.push(0);
    for section in [
        b"/api/users".as_slice(),
        b"127.0.0.1".as_slice(),
        b"rid-1".as_slice(),
    ] {
        input.extend_from_slice(&(section.len() as u32).to_le_bytes());
        input.extend_from_slice(section);
    }
    input.extend_from_slice(&0u32.to_le_bytes());

    let mut out = [0u8; 512];
    let ptr = &inner as *const crate::ingress::IngressInner as usize;
    let w = unsafe {
        castrum_ingress_handle_packed(
            ptr,
            input.as_ptr(),
            input.len(),
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(w > 0);
    // OUT_VERDICT == 0 (ok) at the first output byte.
    assert_eq!(out[0], 0);
    // Invalid inner pointer → 0.
    let bad = unsafe {
        castrum_ingress_handle_packed(
            0,
            input.as_ptr(),
            input.len(),
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(bad, 0);
}

#[test]
fn ingress_handle_components_c_abi() {
    use crate::ingress::cors::CorsEngine;
    use crate::ingress::options::Limits;
    use crate::ingress::rate_limit::RateLimiterState;

    let inner = crate::ingress::IngressInner {
        https_fixed: None,
        max_body_bytes: 1_048_576,
        proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
        parse_cookies: false,
        parse_query: false,
        require_json_body: false,
        guard_enabled: true,
        emit_metadata_json: false,
        cors_enabled: false,
        cors: CorsEngine::disabled(),
        rate: RateLimiterState::Disabled,
        schema: None,
        limits: Limits::default(),
    };
    let ptr = &inner as *const crate::ingress::IngressInner as usize;
    // Empty packed header block: [u16 count = 0].
    let empty_headers = [0u8, 0];
    let rid = b"rid-1";
    let mut out = [0u8; 512];
    let w = unsafe {
        castrum_ingress_handle_components(
            ptr,
            0, // GET
            c"/api/users".as_ptr(),
            c"127.0.0.1".as_ptr(),
            rid.as_ptr(),
            rid.len(),
            empty_headers.as_ptr(),
            empty_headers.len(),
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(w > 0);
    // OUT_VERDICT == 0 (ok) at the first output byte — same as the packed
    // path for the same request components.
    assert_eq!(out[0], 0);

    // Null inner pointer → 0.
    let bad = unsafe {
        castrum_ingress_handle_components(
            0,
            0,
            c"/api/users".as_ptr(),
            c"127.0.0.1".as_ptr(),
            rid.as_ptr(),
            rid.len(),
            empty_headers.as_ptr(),
            empty_headers.len(),
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(bad, 0);
}

#[test]
fn panic_guard_returns_fallback_on_panic() {
    // Happy path: no panic, the closure's value comes through.
    assert_eq!(panic_guard(|| 42usize, 0), 42);
    // A panic is caught and replaced by the fallback (the FFI crash path:
    // without catch_unwind this would unwind through the C ABI and kill the
    // host process).
    assert_eq!(panic_guard(|| panic!("boom"), 0usize), 0);
    // Panic AFTER partial work is also contained.
    let mut seen = 0;
    assert_eq!(
        panic_guard(
            || {
                seen = 1;
                panic!("boom2");
            },
            7usize,
        ),
        7
    );
    assert_eq!(seen, 1);
}

#[test]
fn ingress_handle_packed_input_overlap_c_abi() {
    use crate::ingress::cors::CorsEngine;
    use crate::ingress::options::Limits;
    use crate::ingress::rate_limit::RateLimiterState;

    let inner = crate::ingress::IngressInner {
        https_fixed: None,
        max_body_bytes: 1_048_576,
        proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
        parse_cookies: false,
        parse_query: false,
        require_json_body: false,
        guard_enabled: true,
        emit_metadata_json: false,
        cors_enabled: false,
        cors: CorsEngine::disabled(),
        rate: RateLimiterState::Disabled,
        schema: None,
        limits: Limits::default(),
    };
    let mut input = Vec::new();
    input.push(0);
    for section in [
        b"/api/users".as_slice(),
        b"127.0.0.1".as_slice(),
        b"rid-1".as_slice(),
    ] {
        input.extend_from_slice(&(section.len() as u32).to_le_bytes());
        input.extend_from_slice(section);
    }
    input.extend_from_slice(&0u32.to_le_bytes());

    // Shared buffer: the packed input occupies the front and `out` points
    // INTO THE SAME BUFFER overlapping the input (offset 4) — the aliasing
    // case the FFI entry must handle by copying the input before writing
    // (aliased &[u8]/&mut [u8] would otherwise be instant UB).
    let mut buf = vec![0u8; input.len() + 256];
    buf[..input.len()].copy_from_slice(&input);
    let ptr = &inner as *const crate::ingress::IngressInner as usize;
    let input_ptr = buf.as_ptr();
    let out_ptr = unsafe { buf.as_mut_ptr().add(4) };
    let out_cap = buf.len() - 4;
    assert!(4 < input.len(), "test setup: out region must overlap input");

    let w = unsafe {
        castrum_ingress_handle_packed(
            ptr,
            input_ptr,
            input.len(),
            std::ptr::null(),
            0,
            out_ptr,
            out_cap,
        )
    };
    assert!(w > 0, "pipeline should succeed despite input/out overlap");
    assert_eq!(
        unsafe { *out_ptr },
        0,
        "verdict (ok) must land at out start"
    );
}

// ── Metrics registry C-ABI (castrum_metrics_*) ─────────────────

#[test]
fn metrics_registry_c_abi_counter_gauge_histogram() {
    let h = castrum_metrics_create();
    assert_ne!(h, 0);
    let counter = unsafe {
        castrum_metrics_counter(
            h,
            c"ct_requests_total".as_ptr(),
            c"route\x1fstatus".as_ptr(),
        )
    };
    assert_eq!(counter, 0, "first declared family gets id 0");
    let gauge = unsafe { castrum_metrics_gauge(h, c"ct_queue_depth".as_ptr(), c"q".as_ptr()) };
    assert_eq!(gauge, 1);
    let hist = unsafe {
        castrum_metrics_histogram(h, c"ct_latency".as_ptr(), c"".as_ptr(), c"0.1,0.5".as_ptr())
    };
    assert_eq!(hist, 2);

    // record: two counter hits + one gauge set + one histogram observe
    let vals = b"/a\x1f200";
    assert_eq!(
        unsafe { castrum_metrics_record(h, counter, vals.as_ptr(), vals.len(), 2.0) },
        1
    );
    let q = b"jobs";
    assert_eq!(
        unsafe { castrum_metrics_gauge_set(h, gauge, q.as_ptr(), q.len(), 4.5) },
        1
    );
    assert_eq!(
        unsafe { castrum_metrics_record(h, hist, b"".as_ptr(), 0, 0.25) },
        1
    );

    // render (needed-size convention: probe with a 1-byte buffer)
    let mut probe = [0u8; 1];
    let cap = unsafe { castrum_metrics_render(h, probe.as_mut_ptr(), 1) };
    assert!(cap > 1, "render must report its needed size");
    let mut out = vec![0u8; cap];
    let written = unsafe { castrum_metrics_render(h, out.as_mut_ptr(), out.len()) };
    assert_eq!(written, cap);
    let text = String::from_utf8(out[..written].to_vec()).expect("utf8");
    assert!(text.contains("ct_requests_total{route=\"/a\",status=\"200\"} 2\n"));
    assert!(text.contains("ct_queue_depth{q=\"jobs\"} 4.5\n"));
    assert!(text.contains("ct_latency_bucket{le=\"0.1\"} 0\n"));
    assert!(text.contains("ct_latency_bucket{le=\"0.5\"} 1\n"));
    assert!(text.contains("ct_latency_count 1\n"));

    // arity mismatch → record fails safely
    assert_eq!(
        unsafe { castrum_metrics_record(h, counter, b"/a".as_ptr(), 3, 1.0) },
        0
    );
    // unknown series → 0
    assert_eq!(
        unsafe { castrum_metrics_record(h, 999, b"".as_ptr(), 0, 1.0) },
        0
    );
    // declare error sentinel on an invalid name
    assert_eq!(
        unsafe { castrum_metrics_counter(h, c"9 bad".as_ptr(), c"".as_ptr()) },
        u32::MAX
    );

    unsafe { castrum_metrics_destroy(h) };
}

#[test]
fn metrics_c_abi_null_handle_is_safe() {
    assert_eq!(
        unsafe { castrum_metrics_record(0, 0, b"".as_ptr(), 0, 1.0) },
        0
    );
    assert_eq!(
        unsafe { castrum_metrics_gauge_set(0, 0, b"".as_ptr(), 0, 1.0) },
        0
    );
    assert_eq!(
        unsafe { castrum_metrics_render(0, std::ptr::null_mut(), 0) },
        0
    );
    assert_eq!(
        unsafe { castrum_metrics_counter(0, c"x".as_ptr(), c"".as_ptr()) },
        u32::MAX
    );
    unsafe { castrum_metrics_destroy(0) }; // no-op
}

// ── Batch hex validation C-ABI ─────────────────────────────────

#[test]
fn hex_validate_batch_c_abi_needed_size_convention() {
    let input = b"507f1f77bcf86cd799439011\nzz\n";
    // too-small buffer → exact required size
    let mut tiny = [0u8; 1];
    let needed = unsafe {
        castrum_hex_validate_batch(input.as_ptr(), input.len(), 24, tiny.as_mut_ptr(), 1)
    };
    assert_eq!(needed, 2);
    let mut out = [0u8; 2];
    let written =
        unsafe { castrum_hex_validate_batch(input.as_ptr(), input.len(), 24, out.as_mut_ptr(), 2) };
    assert_eq!(written, 2);
    assert_eq!(out, [1, 0]);
    // bad width → real error (0)
    assert_eq!(
        unsafe { castrum_hex_validate_batch(input.as_ptr(), input.len(), 0, out.as_mut_ptr(), 2) },
        0
    );
}

#[test]
fn regex_escape_c_abi_needed_size_convention() {
    let input = b"a.c(x)*";
    // exact needed size first call writes directly
    let mut out = [0u8; 32];
    let written =
        unsafe { castrum_regex_escape(input.as_ptr(), input.len(), out.as_mut_ptr(), 32) };
    assert_eq!(written, 11); // 7 chars + 4 backslashes (. ( ) * \\)
    assert_eq!(&out[..written], br#"a\.c\(x\)\*"#);
    // too-small buffer → the exact required size
    let mut small = [0u8; 4];
    assert_eq!(
        unsafe { castrum_regex_escape(input.as_ptr(), input.len(), small.as_mut_ptr(), 4) },
        11
    );
}

// ── Zero-copy `_str` siblings (cstring args / cstring return) ──

#[test]
fn metrics_str_variants_match_packed_path() {
    let h = castrum_metrics_create();
    assert_ne!(h, 0);
    let c = unsafe {
        castrum_metrics_counter(h, c"str_requests".as_ptr(), c"route\x1fstatus".as_ptr())
    };
    assert_eq!(c, 0);
    // cstring-joined values behave identically to the packed (ptr,len) path.
    assert_eq!(
        unsafe { castrum_metrics_record_str(h, c, c"/a\x1f200".as_ptr(), 2.0) },
        1
    );
    assert_eq!(
        unsafe { castrum_metrics_record(h, c, b"/a\x1f200".as_ptr(), 6, 1.0) },
        1
    );
    let mut probe = [0u8; 1];
    let cap = unsafe { castrum_metrics_render(h, probe.as_mut_ptr(), 1) };
    let mut out = vec![0u8; cap];
    let w = unsafe { castrum_metrics_render(h, out.as_mut_ptr(), cap) };
    let text = String::from_utf8_lossy(&out[..w]).into_owned();
    assert!(text.contains("str_requests{route=\"/a\",status=\"200\"} 3\n"));
    // arity mismatch still fails safely through the str path
    assert_eq!(
        unsafe { castrum_metrics_record_str(h, c, c"/a".as_ptr(), 1.0) },
        0
    );
    // gauge_set_str assigns
    let g = unsafe { castrum_metrics_gauge(h, c"str_depth".as_ptr(), c"".as_ptr()) };
    assert_eq!(
        unsafe { castrum_metrics_gauge_set_str(h, g, c"".as_ptr(), 7.5) },
        1
    );
    unsafe { castrum_metrics_destroy(h) };
}

#[test]
fn regex_escape_str_c_abi_matches_bytes_path() {
    let s = c"a.c(x)*[y]";
    let p = unsafe { castrum_regex_escape_str(s.as_ptr()) };
    assert!(!p.is_null());
    let via_str = unsafe { cstr_bytes(p).expect("cstring return") };
    let input = b"a.c(x)*[y]";
    let mut expected = Vec::new();
    crate::util::text::regex_escape_into(input, &mut expected);
    assert_eq!(via_str, expected);
}

#[test]
fn hex_validate_batch_str_matches_bytes_path() {
    let ids = c"507f1f77bcf86cd799439011\nzz";
    let mut out = [0u8; 4];
    let w =
        unsafe { castrum_hex_validate_batch_str(ids.as_ptr(), 24, out.as_mut_ptr(), out.len()) };
    assert_eq!(w, 2);
    assert_eq!(out[..2], [1, 0]);
}

// ── Wire-validate / session / batch C-ABI ──────────────────────

#[test]
fn wire_validate_and_session_c_abi() {
    // SchemaValidator instance for query/cookie validation
    // Query/cookie JSON forms carry STRING values (percent-decoded text), so
    // the fixture schema models them as strings.
    let schema_json = c"{\"type\":\"object\",\"properties\":{\"route\":{\"type\":\"string\"},\"status\":{\"type\":\"string\"}},\"required\":[\"route\"]}";
    let inst = crate::json::json_schema::SchemaValidator::new(
        napi::bindgen_prelude::Uint8Array::new(schema_json.to_bytes().to_vec()),
    )
    .expect("compile");
    let inner = inst.inner_ptr() as usize;

    // query: valid → 1 ; violating → 0
    assert_eq!(
        unsafe { castrum_query_validate(inner, c"route=/a&status=200".as_ptr()) },
        1
    );
    assert_eq!(
        unsafe { castrum_query_validate(inner, c"status=notanumber".as_ptr()) },
        0
    );
    // null inner → 0
    assert_eq!(unsafe { castrum_query_validate(0, c"a=1".as_ptr()) }, 0);

    // cookie: valid route cookie → 1
    assert_eq!(
        unsafe { castrum_cookie_validate(inner, c"route=/a".as_ptr()) },
        1
    );

    // session seal/open round trip through the C ABI
    let token = unsafe {
        castrum_session_seal(
            c"sess-9".as_ptr(),
            c"{\"n\":1}".as_ptr(),
            1_234_567,
            c"sekrit".as_ptr(),
        )
    };
    assert!(!token.is_null());
    // open with grow-once
    let mut buf = [0u8; 256];
    let w = unsafe { castrum_session_open(token, c"sekrit".as_ptr(), buf.as_mut_ptr(), buf.len()) };
    assert!(w > 13);
    assert_eq!(buf[0], 1);
    // bad signature → 0
    assert_eq!(
        unsafe { castrum_session_open(token, c"wrong".as_ptr(), buf.as_mut_ptr(), buf.len()) },
        0
    );
}

#[test]
fn metrics_record_batch_c_abi() {
    let h = castrum_metrics_create();
    let c = unsafe { castrum_metrics_counter(h, c"batch_total".as_ptr(), c"k".as_ptr()) };
    // packed: 1 entry, vals "v", amount 4
    let mut b = Vec::new();
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&c.to_le_bytes());
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(b"v");
    b.extend_from_slice(&4f64.to_le_bytes());
    assert_eq!(
        unsafe { castrum_metrics_record_batch(h, b.as_ptr(), b.len()) },
        1
    );
    let mut out = [0u8; 128];
    let w = unsafe { castrum_metrics_render(h, out.as_mut_ptr(), out.len()) };
    let text = String::from_utf8_lossy(&out[..w]).into_owned();
    assert!(text.contains("batch_total{k=\"v\"} 4"));
    unsafe { castrum_metrics_destroy(h) };
}
