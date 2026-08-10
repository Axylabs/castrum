
use std::sync::Arc;

use super::*;
use crate::ingress::cors::{CorsEngine, CorsOptions};
use crate::ingress::output::{
    ERR_CODE_BAD_REQUEST, ERR_CODE_BODY_TOO_LARGE, ERR_CODE_INVALID_JSON, ERR_CODE_NONE,
    ERR_CODE_RATE_LIMITED, ERR_CODE_REQUEST_TOO_LARGE, ERR_CODE_SCHEMA_VALIDATION, FLAG_CORS_ALLOWED,
    FLAG_HAS_COOKIES, FLAG_HAS_QUERY, FLAG_HTTPS, FLAG_SCHEMA_VALID, HV_CORS_SIMPLE, HV_JSON,
    OUT_COOKIES_JSON_LEN, OUT_ERROR_CODE, OUT_FLAGS, OUT_HEADER_VARIANT, OUT_QUERY_JSON_LEN,
    OUT_STATUS, OUT_VERDICT,
};
use crate::ingress::pipeline::IngressSchema;
use crate::ingress::rate_limit::{KeyedRateLimiter, RateLimiterState};

/// Build a packed input frame: `[method]` then u32le-length-prefixed
/// url/ip/rid sections, then a u32le-length-prefixed headers section.
fn packed_input(method: u8, url: &[u8], ip: &[u8], rid: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(method);
    for section in [url, ip, rid] {
        out.extend_from_slice(&(section.len() as u32).to_le_bytes());
        out.extend_from_slice(section);
    }
    // Headers section: empty for these tests.
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

fn base_inner() -> IngressInner {
    IngressInner {
        https_fixed: None,
        max_body_bytes: 1_048_576,
        proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
        parse_cookies: false,
        parse_query: false,
        require_json_body: false,
        guard_enabled: true,
        emit_metadata_json: false,
        cors_enabled: false,
        cors: crate::ingress::cors::CorsEngine::disabled(),
        rate: RateLimiterState::Disabled,
        schema: None,
        limits: Limits::default(),
    }
}

#[test]
fn handle_packed_simple_get_ok() {
    let inner = base_inner();
    let input = packed_input(0, b"/api/users", b"127.0.0.1", b"rid-1");
    let mut out = vec![0u8; 512];
    let written = inner.handle_packed(&input, b"", &mut out).unwrap();

    assert_eq!(out[OUT_VERDICT], 0);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_NONE);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        200
    );
    assert_eq!(out[OUT_HEADER_VARIANT], HV_JSON);
    assert_eq!(written, OUT_DATA_START);
}

#[test]
fn handle_packed_body_too_large_413() {
    let inner = IngressInner {
        max_body_bytes: 4,
        ..base_inner()
    };
    let input = packed_input(2, b"/api", b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"12345", &mut out).unwrap();

    assert_eq!(out[OUT_VERDICT], 1);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_BODY_TOO_LARGE);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        413
    );
}

#[test]
fn handle_packed_invalid_json_400() {
    let inner = IngressInner {
        require_json_body: true,
        ..base_inner()
    };
    let input = packed_input(2, b"/api", b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"not json", &mut out).unwrap();

    assert_eq!(out[OUT_VERDICT], 1);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_INVALID_JSON);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        400
    );
}

#[test]
fn handle_packed_url_too_long_414() {
    let inner = IngressInner {
        limits: Limits {
            max_url_bytes: 8,
            ..Limits::default()
        },
        ..base_inner()
    };
    let input = packed_input(0, b"/a/very/long/url/path", b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();

    assert_eq!(out[OUT_VERDICT], 1);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_BAD_REQUEST);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        414
    );
}

// ── handle_request_full_sync_into / full_sync_into ─────────────

/// Build a minimal `IngressOptions` for unit tests (no JS runtime needed).
fn base_options() -> IngressOptions {
    IngressOptions {
        trust_proxy: None,
        trusted_proxies: None,
        parse_cookies: Some(true),
        parse_query: Some(true),
        require_json_body: None,
        schema: None,
        cors: None,
        rate_limit: None,
        https: Some(true),
        max_body_bytes: None,
        enable_body_size_guard: Some(true),
        emit_metadata_json: Some(true),
        limits: None,
    }
}

#[test]
fn build_packed_input_sync_layout_matches_manual_frame() {
    let headers: Vec<(String, String)> = vec![
        (String::from("cookie"), String::from("a=1;b=2")),
        (String::from("origin"), String::from("https://x")),
    ];
    let packed = build_packed_input_sync(2, b"/api", b"1.2.3.4", b"rid", &headers);

    // Manual equivalent: [method] then u32le-length-prefixed url/ip/rid
    // sections, then a u32le-length-prefixed headers section containing a
    // u16le count followed by (u16le name-len, name, u32le value-len, value).
    let mut manual = Vec::new();
    manual.push(2u8);
    for section in [b"/api".as_slice(), b"1.2.3.4".as_slice(), b"rid".as_slice()] {
        manual.extend_from_slice(&(section.len() as u32).to_le_bytes());
        manual.extend_from_slice(section);
    }
    let header_pairs_len: usize = headers.iter().map(|(n, v)| 2 + n.len() + 4 + v.len()).sum();
    manual.extend_from_slice(&((2 + header_pairs_len) as u32).to_le_bytes());
    manual.extend_from_slice(&(headers.len() as u16).to_le_bytes());
    for (n, v) in &headers {
        manual.extend_from_slice(&(n.len() as u16).to_le_bytes());
        manual.extend_from_slice(n.as_bytes());
        manual.extend_from_slice(&(v.len() as u32).to_le_bytes());
        manual.extend_from_slice(v.as_bytes());
    }

    assert_eq!(packed, manual);
}

#[test]
fn full_sync_into_matches_handle_packed_reference() {
    let ingress = Ingress::new(base_options()).unwrap();

    let headers: Vec<Vec<String>> = vec![
        vec![String::from("cookie"), String::from("a=1;b=2")],
        vec![String::from("x-forwarded-for"), String::from("9.9.9.9")],
    ];

    let mut out = vec![0u8; 131072];
    let written = ingress
        .full_sync_into(
            0,
            "/api/users",
            "127.0.0.1",
            "rid-1",
            headers,
            b"",
            &mut out,
        )
        .expect("full_sync_into should succeed");

    // Reference: handle_packed on the equivalent manually-built frame,
    // using an inner that mirrors `base_options()` (parse cookies/query,
    // emit metadata, https fixed).
    let inner = IngressInner {
        https_fixed: Some(true),
        parse_cookies: true,
        parse_query: true,
        emit_metadata_json: true,
        ..base_inner()
    };
    let mut ref_out = vec![0u8; 131072];
    let header_pairs = vec![
        (String::from("cookie"), String::from("a=1;b=2")),
        (String::from("x-forwarded-for"), String::from("9.9.9.9")),
    ];
    let ref_packed =
        build_packed_input_sync(0, b"/api/users", b"127.0.0.1", b"rid-1", &header_pairs);
    let ref_written = inner.handle_packed(&ref_packed, b"", &mut ref_out).unwrap();

    assert_eq!(written, ref_written);
    assert_eq!(&out[..written], &ref_out[..ref_written]);
    // sanity: 200 ok
    assert_eq!(out[OUT_VERDICT], 0);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        200
    );
}

#[test]
fn full_sync_into_rejects_tiny_output_buffer() {
    let ingress = Ingress::new(base_options()).unwrap();
    let mut tiny = vec![0u8; OUT_DATA_START - 1];
    let err = ingress.full_sync_into(0, "/x", "1.1.1.1", "rid", vec![], b"", &mut tiny);
    assert!(err.is_err());
}

// ── Enabled-feature pipeline e2e (schema / rate limit / CORS / limits) ──

/// Build a packed input frame including a headers section:
/// `[method]` then u32le-length-prefixed url/ip/rid sections, then a
/// u32le-length-prefixed headers section
/// (`[u16 count] { [u16 name_len][name][u32 val_len][val] }`).
fn packed_input_with_headers(
    method: u8,
    url: &[u8],
    ip: &[u8],
    rid: &[u8],
    headers: &[(&str, &str)],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(method);
    for section in [url, ip, rid] {
        out.extend_from_slice(&(section.len() as u32).to_le_bytes());
        out.extend_from_slice(section);
    }
    let header_pairs_len: usize = headers
        .iter()
        .map(|(n, v)| 2 + n.len() + 4 + v.len())
        .sum();
    out.extend_from_slice(&((2 + header_pairs_len) as u32).to_le_bytes());
    out.extend_from_slice(&(headers.len() as u16).to_le_bytes());
    for (n, v) in headers {
        out.extend_from_slice(&(n.len() as u16).to_le_bytes());
        out.extend_from_slice(n.as_bytes());
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        out.extend_from_slice(v.as_bytes());
    }
    out
}

fn flags_at(out: &[u8]) -> u32 {
    u32::from_le_bytes([out[OUT_FLAGS], out[OUT_FLAGS + 1], out[OUT_FLAGS + 2], out[OUT_FLAGS + 3]])
}

fn status_at(out: &[u8]) -> u16 {
    u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]])
}

#[test]
fn schema_valid_200_and_invalid_422() {
    let schema = IngressSchema::compile(&serde_json::json!({
        "type": "object",
        "required": ["id"],
        "properties": { "id": { "type": "number" } },
    }))
    .expect("schema compiles");
    let inner = IngressInner {
        schema: Some(Arc::new(schema)),
        ..base_inner()
    };
    let input = packed_input(2, b"/api", b"127.0.0.1", b"rid");

    // Well-formed but schema-invalid body → 422 (distinct from 400 malformed).
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, br#"{"id":"x"}"#, &mut out).unwrap();
    assert_eq!(out[OUT_VERDICT], 1);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_SCHEMA_VALIDATION);
    assert_eq!(status_at(&out), 422);

    // Valid body → 200 with FLAG_SCHEMA_VALID (exercises the zero-DOM fast
    // path, since this schema uses only supported keywords).
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, br#"{"id":1}"#, &mut out).unwrap();
    assert_eq!(out[OUT_VERDICT], 0);
    assert_eq!(status_at(&out), 200);
    assert_ne!(flags_at(&out) & FLAG_SCHEMA_VALID, 0);
}

#[test]
fn rate_limit_429_after_limit() {
    let inner = IngressInner {
        rate: RateLimiterState::Enabled(Arc::new(KeyedRateLimiter::new(1, 60_000, None))),
        ..base_inner()
    };
    let input = packed_input(0, b"/api", b"127.0.0.1", b"rid");
    let mut out1 = vec![0u8; 512];
    let mut out2 = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out1).unwrap();
    inner.handle_packed(&input, b"", &mut out2).unwrap();

    assert_eq!(out1[OUT_VERDICT], 0, "first request is allowed");
    assert_eq!(status_at(&out1), 200);
    assert_eq!(out2[OUT_VERDICT], 1, "second request is rate limited");
    assert_eq!(out2[OUT_ERROR_CODE], ERR_CODE_RATE_LIMITED);
    assert_eq!(status_at(&out2), 429);
}

fn cors_engine() -> CorsEngine {
    CorsEngine::from_options(Some(CorsOptions {
        allow_origin: Some(vec!["https://app.example.com".into()]),
        allow_methods: None,
        allow_headers: None,
        expose_headers: None,
        allow_credentials: Some(false),
        max_age: None,
    }))
    .unwrap()
}

#[test]
fn cors_preflight_allowed_204_forbidden_403() {
    let inner = IngressInner {
        cors_enabled: true,
        cors: cors_engine(),
        ..base_inner()
    };

    // Allowed preflight: OPTIONS (6) with matching origin + ACRM.
    let input = packed_input_with_headers(
        6,
        b"/api",
        b"127.0.0.1",
        b"rid",
        &[
            ("origin", "https://app.example.com"),
            ("access-control-request-method", "POST"),
        ],
    );
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_NONE);
    assert_eq!(status_at(&out), 204);

    // Forbidden preflight: non-matching origin.
    let input = packed_input_with_headers(
        6,
        b"/api",
        b"127.0.0.1",
        b"rid",
        &[
            ("origin", "https://evil.example.com"),
            ("access-control-request-method", "POST"),
        ],
    );
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(status_at(&out), 403);
}

#[test]
fn cors_simple_sets_flag_and_hv() {
    let inner = IngressInner {
        cors_enabled: true,
        cors: cors_engine(),
        ..base_inner()
    };
    let input = packed_input_with_headers(
        0,
        b"/api",
        b"127.0.0.1",
        b"rid",
        &[("origin", "https://app.example.com")],
    );
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(status_at(&out), 200);
    assert_ne!(flags_at(&out) & FLAG_CORS_ALLOWED, 0);
    assert_ne!(out[OUT_HEADER_VARIANT] & HV_CORS_SIMPLE, 0);
}

#[test]
fn too_many_headers_431() {
    let inner = IngressInner {
        limits: Limits {
            max_headers: 1,
            ..Limits::default()
        },
        ..base_inner()
    };
    let input = packed_input_with_headers(0, b"/api", b"127.0.0.1", b"rid", &[("a", "1"), ("b", "2")]);
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(out[OUT_VERDICT], 1);
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_REQUEST_TOO_LARGE);
    assert_eq!(status_at(&out), 431);
}

#[test]
fn headers_section_over_bytes_431() {
    let inner = IngressInner {
        limits: Limits {
            max_headers_bytes: 4,
            ..Limits::default()
        },
        ..base_inner()
    };
    let input =
        packed_input_with_headers(0, b"/api", b"127.0.0.1", b"rid", &[("a", "123456")]);
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_REQUEST_TOO_LARGE);
    assert_eq!(status_at(&out), 431);
}

#[test]
fn query_over_limit_414() {
    let inner = IngressInner {
        parse_query: true,
        limits: Limits {
            max_query_bytes: 4,
            ..Limits::default()
        },
        ..base_inner()
    };
    let input = packed_input(0, b"/api?long=1234567890", b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_BAD_REQUEST);
    assert_eq!(status_at(&out), 414);
}

#[test]
fn https_fixed_sets_flag() {
    let inner = IngressInner {
        https_fixed: Some(true),
        ..base_inner()
    };
    let input = packed_input(0, b"/api", b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 512];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_ne!(flags_at(&out) & FLAG_HTTPS, 0);
}

#[test]
fn cookies_and_query_json_written() {
    let inner = IngressInner {
        parse_cookies: true,
        parse_query: true,
        ..base_inner()
    };
    let input = packed_input_with_headers(
        0,
        b"/api?page=2&q=hello%20world",
        b"127.0.0.1",
        b"rid",
        &[("cookie", "sid=abc123; theme=dark")],
    );
    let mut out = vec![0u8; 4096];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(status_at(&out), 200);
    assert_ne!(flags_at(&out) & FLAG_HAS_COOKIES, 0);
    assert_ne!(flags_at(&out) & FLAG_HAS_QUERY, 0);

    let cookies_len = u32::from_le_bytes([
        out[OUT_COOKIES_JSON_LEN],
        out[OUT_COOKIES_JSON_LEN + 1],
        out[OUT_COOKIES_JSON_LEN + 2],
        out[OUT_COOKIES_JSON_LEN + 3],
    ]) as usize;
    let query_len = u32::from_le_bytes([
        out[OUT_QUERY_JSON_LEN],
        out[OUT_QUERY_JSON_LEN + 1],
        out[OUT_QUERY_JSON_LEN + 2],
        out[OUT_QUERY_JSON_LEN + 3],
    ]) as usize;
    assert!(cookies_len > 2);
    assert!(query_len > 2);

    let cookies_json = &out[OUT_DATA_START..OUT_DATA_START + cookies_len];
    let query_json =
        &out[OUT_DATA_START + cookies_len..OUT_DATA_START + cookies_len + query_len];
    assert_eq!(cookies_json, br#"{"sid":"abc123","theme":"dark"}"#);
    // Query keys in order; `%20` decoded to a space and JSON-escaped.
    assert_eq!(query_json, br#"{"page":"2","q":"hello world"}"#);
}

#[test]
fn unicode_query_json_written() {
    let inner = IngressInner {
        parse_query: true,
        ..base_inner()
    };
    let input = packed_input(
        0,
        "/api?q=%E2%9C%93&e=%F0%9F%98%80".as_bytes(),
        b"127.0.0.1",
        b"rid",
    );
    let mut out = vec![0u8; 4096];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(status_at(&out), 200);

    let query_len = u32::from_le_bytes([
        out[OUT_QUERY_JSON_LEN],
        out[OUT_QUERY_JSON_LEN + 1],
        out[OUT_QUERY_JSON_LEN + 2],
        out[OUT_QUERY_JSON_LEN + 3],
    ]) as usize;
    let query_json = &out[OUT_DATA_START..OUT_DATA_START + query_len];
    // Percent-decoded UTF-8 (`✓`, `😀`) is preserved verbatim in the JSON.
    let expected = "{\"q\":\"✓\",\"e\":\"😀\"}".as_bytes();
    assert_eq!(query_json, expected);
}

#[test]
fn truncated_multibyte_query_escaped() {
    let inner = IngressInner {
        parse_query: true,
        ..base_inner()
    };
    // `%E2%9C` decodes to 2 bytes of a 3-byte sequence → invalid UTF-8. The
    // JSON writer must escape every byte as `\u00XX` (not emit invalid UTF-8),
    // and the length accounting must match (6 bytes per byte).
    let input = packed_input(0, "/api?q=%E2%9C".as_bytes(), b"127.0.0.1", b"rid");
    let mut out = vec![0u8; 4096];
    inner.handle_packed(&input, b"", &mut out).unwrap();
    assert_eq!(status_at(&out), 200);

    let query_len = u32::from_le_bytes([
        out[OUT_QUERY_JSON_LEN],
        out[OUT_QUERY_JSON_LEN + 1],
        out[OUT_QUERY_JSON_LEN + 2],
        out[OUT_QUERY_JSON_LEN + 3],
    ]) as usize;
    let query_json = &out[OUT_DATA_START..OUT_DATA_START + query_len];
    assert_eq!(query_json, br#"{"q":"\u00e2\u009c"}"#);
}
