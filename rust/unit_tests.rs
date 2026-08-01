// rust/unit_tests.rs — Rust unit tests for the pure-Rust core modules.
//
// The napi-facing entry points are thin wrappers; these tests exercise the
// actual logic (parsers, rate limiter, IP trust, CORS, output layout, JSON
// serialization) directly. Run with `cargo test`.

#![cfg(test)]

use crate::cors::{CorsEngine, CorsOptions};
use crate::headers::HeaderRefs;
use crate::ip_trust::{resolve_client_ip, ProxyTrustMode};
use crate::method::MethodKind;
use crate::output::{
    compute_header_variant, write_output_header, OUT_BODY_JSON_LEN, OUT_COOKIES_JSON_LEN,
    OUT_DATA_START, OUT_ERROR_CODE, OUT_FLAGS, OUT_HEADER_VARIANT, OUT_QUERY_JSON_LEN,
    OUT_RATE_LIMIT, OUT_RATE_REMAINING, OUT_RATE_RESET, OUT_RETRY_AFTER, OUT_STATUS, OUT_VERDICT,
    HV_CORS_PREFLIGHT, HV_CORS_SIMPLE, HV_JSON, HV_RATE_ACTIVE, HV_RATE_LIMITED,
};
use crate::rate_limit::KeyedRateLimiter;

// ── Shared helpers ────────────────────────────────────────────────

/// Build a packed header buffer: [u16 count] { [u16 name_len][name][u32 val_len][val] }.
fn pack_headers<'a, I>(pairs: I) -> Vec<u8>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let pairs: Vec<(&str, &str)> = pairs.into_iter().collect();
    let mut out = Vec::new();
    out.extend_from_slice(&(pairs.len() as u16).to_le_bytes());
    for (name, value) in pairs {
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(value.len() as u32).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
    }
    out
}

/// Decode a packed pairs buffer: [u32 count] { [u32 key_len][key][u32 val_len][val] }.
fn decode_packed_pairs(packed: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    assert!(packed.len() >= 4, "packed buffer too short");
    let count = u32::from_le_bytes([packed[0], packed[1], packed[2], packed[3]]) as usize;
    let mut out = Vec::with_capacity(count);
    let mut pos = 4usize;
    for _ in 0..count {
        let key_len = u32::from_le_bytes([packed[pos], packed[pos + 1], packed[pos + 2], packed[pos + 3]]) as usize;
        pos += 4;
        let key = packed[pos..pos + key_len].to_vec();
        pos += key_len;
        let val_len = u32::from_le_bytes([packed[pos], packed[pos + 1], packed[pos + 2], packed[pos + 3]]) as usize;
        pos += 4;
        let val = packed[pos..pos + val_len].to_vec();
        pos += val_len;
        out.push((key, val));
    }
    out
}

// ── rate_limit ────────────────────────────────────────────────────

#[test]
fn rate_limit_allows_up_to_limit_within_window() {
    let rl = KeyedRateLimiter::new(5, 1000, None);
    let key = 42;

    for i in 0..5 {
        let o = rl.check_key(key, 100 + i as u64);
        assert!(o.allowed, "request {} should be allowed", i);
        let expected = (5 - i - 1) as u32;
        assert_eq!(o.remaining, expected, "remaining mismatch at request {}", i);
    }

    let denied = rl.check_key(key, 105);
    assert!(!denied.allowed, "6th request within window should be denied");
    assert_eq!(denied.remaining, 0);
}

#[test]
fn rate_limit_denied_after_limit() {
    let rl = KeyedRateLimiter::new(2, 60_000, None);
    assert!(rl.check_key(1, 0).allowed);
    assert!(rl.check_key(1, 1).allowed);
    assert!(!rl.check_key(1, 2).allowed);
}

#[test]
fn rate_limit_window_advances_and_recovers() {
    let rl = KeyedRateLimiter::new(2, 1000, None);
    let key = 7;

    assert!(rl.check_key(key, 0).allowed);
    assert!(rl.check_key(key, 1).allowed);
    assert!(!rl.check_key(key, 2).allowed);

    // New window: previous weight decays; at least one slot must open.
    let o = rl.check_key(key, 1001);
    assert!(o.allowed, "request after window rollover should be allowed");
    assert!(o.reset_ms > 1001, "reset should be in the future");
}

#[test]
fn rate_limit_reset_ms_is_in_future() {
    let rl = KeyedRateLimiter::new(3, 5000, None);
    let o = rl.check_key(9, 1000);
    assert!(o.allowed);
    assert!(o.reset_ms > 1000);
}

#[test]
fn rate_limit_zero_limit_denies_everything() {
    let rl = KeyedRateLimiter::new(0, 1000, None);
    let o = rl.check_key(1, 0);
    assert!(!o.allowed);
    assert_eq!(o.remaining, 0);
}

#[test]
fn rate_limit_max_limit_allows_everything() {
    let rl = KeyedRateLimiter::new(u32::MAX, 1000, None);
    let o = rl.check_key(1, 0);
    assert!(o.allowed);
    assert_eq!(o.remaining, u32::MAX);
}

#[test]
fn rate_limit_keys_are_independent() {
    let rl = KeyedRateLimiter::new(1, 1000, None);
    assert!(rl.check_key(1, 0).allowed);
    assert!(!rl.check_key(1, 1).allowed);
    assert!(rl.check_key(2, 1).allowed, "different key should have its own bucket");
}

#[test]
fn rate_limit_seed_is_stable_per_instance() {
    let a = KeyedRateLimiter::new(10, 1000, None);
    let b = KeyedRateLimiter::new(10, 1000, None);
    // Seeds differ per instance (unique per limiter id) but are stable within one.
    assert_ne!(a.seed(), b.seed());
    assert_eq!(a.seed(), a.seed());
}

#[test]
fn rate_limit_shared_limiter_is_shared_by_config() {
    use std::sync::Arc;

    let a = crate::rate_limit::shared_limiter(100, 60_000, None);
    let b = crate::rate_limit::shared_limiter(100, 60_000, None);
    assert!(
        Arc::ptr_eq(&a, &b),
        "identical config must share one process-wide limiter"
    );

    let c = crate::rate_limit::shared_limiter(100, 60_000, Some(10_000));
    assert!(
        !Arc::ptr_eq(&a, &c),
        "different max_entries must not share a limiter"
    );

    let d = crate::rate_limit::shared_limiter(200, 60_000, None);
    assert!(
        !Arc::ptr_eq(&a, &d),
        "different limit must not share a limiter"
    );
}

#[test]
fn rate_limit_shared_limiter_shares_budget() {
    // Two instances with the same config share one bucket — a request consumed
    // via one instance must count against the other (prevents route-splitting
    // bypass).
    let a = crate::rate_limit::shared_limiter(2, 60_000, None);
    let b = crate::rate_limit::shared_limiter(2, 60_000, None);
    let key = 1234u64;

    assert!(a.check_key(key, 0).allowed);
    assert!(b.check_key(key, 1).allowed, "shared budget consumed by a");
    assert!(
        !a.check_key(key, 2).allowed,
        "budget must be exhausted across both instances"
    );
}

// ── ip_trust ──────────────────────────────────────────────────────

#[test]
fn ip_trust_disabled_mode_is_none() {
    let mode = ProxyTrustMode::from_config(false, None).unwrap();
    assert!(mode.is_none());
}

#[test]
fn ip_trust_enabled_without_networks_trusts_nothing() {
    // Regression: this must NOT become ProxyTrustMode::All (spoofing vector).
    let mode = ProxyTrustMode::from_config(true, None).unwrap();
    assert!(!mode.is_none());
    assert!(!mode.is_trusted("10.0.0.1".parse().unwrap()));
    assert!(!mode.is_trusted("8.8.8.8".parse().unwrap()));
}

#[test]
fn ip_trust_enabled_with_empty_networks_trusts_nothing() {
    let mode = ProxyTrustMode::from_config(true, Some(vec![])).unwrap();
    assert!(!mode.is_trusted("10.0.0.1".parse().unwrap()));
}

#[test]
fn ip_trust_network_list_matches() {
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    assert!(mode.is_trusted("10.1.2.3".parse().unwrap()));
    assert!(!mode.is_trusted("8.8.8.8".parse().unwrap()));
}

#[test]
fn ip_trust_single_ip_network() {
    let mode = ProxyTrustMode::from_config(true, Some(vec!["192.168.1.1".to_string()])).unwrap();
    assert!(mode.is_trusted("192.168.1.1".parse().unwrap()));
    assert!(!mode.is_trusted("192.168.1.2".parse().unwrap()));
}

#[test]
fn ip_trust_invalid_network_is_error() {
    let res = ProxyTrustMode::from_config(true, Some(vec!["not-an-ip".to_string()]));
    assert!(res.is_err());
}

#[test]
fn ip_trust_resolves_socket_ip_when_not_trusting_proxy() {
    let mode = ProxyTrustMode::from_config(false, None).unwrap();
    let (resolved, peer_trusted) = resolve_client_ip(
        &mode,
        b"203.0.113.5",
        Some(b"6.6.6.6"),
        None,
    );
    assert!(!peer_trusted);
    // Socket IP must win; XFF must be ignored.
    match resolved {
        crate::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 5]),
        _ => panic!("expected V4 socket IP"),
    }
}

#[test]
fn ip_trust_untrusted_socket_ignores_xff() {
    // Socket is NOT in the trusted networks -> XFF cannot spoof the client IP.
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    let (resolved, peer_trusted) = resolve_client_ip(
        &mode,
        b"203.0.113.9",
        Some(b"6.6.6.6"),
        None,
    );
    assert!(!peer_trusted);
    match resolved {
        crate::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 9]),
        _ => panic!("expected V4 socket IP"),
    }
}

#[test]
fn ip_trust_trusted_socket_uses_leftmost_untrusted_xff() {
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    let (resolved, peer_trusted) = resolve_client_ip(
        &mode,
        b"10.0.0.5",
        Some(b"8.8.8.8, 10.0.0.1, 10.0.0.2"),
        None,
    );
    assert!(peer_trusted);
    // Right-to-left: 10.0.0.2 trusted, 10.0.0.1 trusted, 8.8.8.8 NOT trusted -> client = 8.8.8.8.
    match resolved {
        crate::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [8, 8, 8, 8]),
        _ => panic!("expected V4 8.8.8.8"),
    }
}

#[test]
fn ip_trust_all_trusted_xff_returns_last_entry() {
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    let (resolved, peer_trusted) = resolve_client_ip(
        &mode,
        b"10.0.0.5",
        Some(b"10.0.0.1, 10.0.0.2"),
        None,
    );
    assert!(peer_trusted);
    match resolved {
        crate::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [10, 0, 0, 1]),
        _ => panic!("expected V4 10.0.0.1"),
    }
}

// ── output ────────────────────────────────────────────────────────

#[test]
fn output_compute_header_variant_bits() {
    assert_eq!(compute_header_variant(false, false, false, false, true), HV_JSON);
    assert_eq!(
        compute_header_variant(true, false, false, false, true),
        HV_JSON | HV_CORS_SIMPLE
    );
    assert_eq!(
        compute_header_variant(false, true, false, false, true),
        HV_JSON | HV_CORS_PREFLIGHT
    );
    assert_eq!(
        compute_header_variant(true, false, true, false, true),
        HV_JSON | HV_CORS_SIMPLE | HV_RATE_ACTIVE
    );
    assert_eq!(
        compute_header_variant(false, false, true, true, true),
        HV_JSON | HV_RATE_ACTIVE | HV_RATE_LIMITED
    );
}

#[test]
fn output_write_header_layout() {
    let mut out = vec![0u8; 1024];
    let written = write_output_header(
        &mut out,
        0,      // verdict
        3,      // error_code
        200,    // status
        0x1F,   // flags
        100,    // rate_limit
        50,     // rate_remaining
        123_456, // rate_reset_ms
        5,      // retry_after_ms
        10,     // cookies_json_len
        20,     // query_json_len
        HV_JSON | HV_RATE_ACTIVE,
        30,     // body_json_len
    );

    assert_eq!(out[OUT_VERDICT], 0);
    assert_eq!(out[OUT_ERROR_CODE], 3);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        200
    );
    assert_eq!(
        u32::from_le_bytes([out[OUT_FLAGS], out[OUT_FLAGS + 1], out[OUT_FLAGS + 2], out[OUT_FLAGS + 3]]),
        0x1F
    );
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_RATE_LIMIT],
            out[OUT_RATE_LIMIT + 1],
            out[OUT_RATE_LIMIT + 2],
            out[OUT_RATE_LIMIT + 3],
        ]),
        100
    );
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_RATE_REMAINING],
            out[OUT_RATE_REMAINING + 1],
            out[OUT_RATE_REMAINING + 2],
            out[OUT_RATE_REMAINING + 3],
        ]),
        50
    );
    let reset = u64::from_le_bytes(out[OUT_RATE_RESET..OUT_RATE_RESET + 8].try_into().unwrap());
    assert_eq!(reset, 123_456);
    let retry = u64::from_le_bytes(out[OUT_RETRY_AFTER..OUT_RETRY_AFTER + 8].try_into().unwrap());
    assert_eq!(retry, 5);
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_COOKIES_JSON_LEN],
            out[OUT_COOKIES_JSON_LEN + 1],
            out[OUT_COOKIES_JSON_LEN + 2],
            out[OUT_COOKIES_JSON_LEN + 3],
        ]),
        10
    );
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_QUERY_JSON_LEN],
            out[OUT_QUERY_JSON_LEN + 1],
            out[OUT_QUERY_JSON_LEN + 2],
            out[OUT_QUERY_JSON_LEN + 3],
        ]),
        20
    );
    assert_eq!(out[OUT_HEADER_VARIANT], HV_JSON | HV_RATE_ACTIVE);
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_BODY_JSON_LEN],
            out[OUT_BODY_JSON_LEN + 1],
            out[OUT_BODY_JSON_LEN + 2],
            out[OUT_BODY_JSON_LEN + 3],
        ]),
        30
    );

    assert_eq!(written, OUT_DATA_START + 10 + 20 + 30);
}

#[test]
fn output_write_header_normalizes_invalid_status() {
    let mut out = vec![0u8; 128];
    let written = write_output_header(
        &mut out, 1, 6, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    );
    let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
    assert_eq!(status, 500, "invalid status must be coerced to 500");
    assert_eq!(written, OUT_DATA_START);
}

#[test]
fn output_write_header_keeps_101() {
    let mut out = vec![0u8; 128];
    write_output_header(&mut out, 1, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
    assert_eq!(status, 101);
}

// ── headers ───────────────────────────────────────────────────────

#[test]
fn headers_parse_empty_ok() {
    let h = HeaderRefs::parse(b"", false, 100).unwrap();
    assert!(h.origin().is_none());
    assert!(h.cookie().is_none());
}

#[test]
fn headers_parse_presence_and_values() {
    let packed = pack_headers([
        ("Origin", "https://example.com"),
        ("Cookie", "session=abc"),
        ("X-Forwarded-For", "1.2.3.4"),
    ]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    assert_eq!(h.origin(), Some(&b"https://example.com"[..]));
    assert_eq!(h.cookie(), Some(&b"session=abc"[..]));
    assert_eq!(h.xff(), Some(&b"1.2.3.4"[..]));
}

#[test]
fn headers_parse_case_insensitive_names() {
    let packed = pack_headers([("ORIGIN", "https://x.io")]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    assert_eq!(h.origin(), Some(&b"https://x.io"[..]));
}

#[test]
fn headers_parse_acrm_only_for_options() {
    let packed = pack_headers([
        ("access-control-request-method", "POST"),
        ("access-control-request-headers", "Content-Type"),
    ]);
    // Non-OPTIONS: ACRM/ACRH should not be captured.
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    assert!(!h.has_acrm());
    // OPTIONS: they should be captured.
    let h2 = HeaderRefs::parse(&packed, true, 100).unwrap();
    assert!(h2.has_acrm());
    assert!(h2.has_acrh());
}

#[test]
fn headers_parse_too_many_headers_rejected() {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for i in 0..10 {
        pairs.push(("x".to_string(), format!("v{i}")));
    }

    let mut packed = Vec::new();
    packed.extend_from_slice(&(pairs.len() as u16).to_le_bytes());
    for (name, value) in &pairs {
        packed.extend_from_slice(&(name.len() as u16).to_le_bytes());
        packed.extend_from_slice(name.as_bytes());
        packed.extend_from_slice(&(value.len() as u32).to_le_bytes());
        packed.extend_from_slice(value.as_bytes());
    }

    assert!(HeaderRefs::parse(&packed, false, 5).is_err());
}

#[test]
fn headers_parse_malformed_rejected() {
    // Declares a name_len that runs past the end of the buffer.
    let packed = [2u8, 0, 0xFF, 0xFF, b'x'];
    assert!(HeaderRefs::parse(&packed, false, 100).is_err());
}

// ── method ────────────────────────────────────────────────────────

#[test]
fn method_from_bytes_ignore_case_upper() {
    assert_eq!(MethodKind::from_bytes_ignore_case(b"GET"), MethodKind::Get);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"HEAD"), MethodKind::Head);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"POST"), MethodKind::Post);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"PUT"), MethodKind::Put);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"PATCH"), MethodKind::Patch);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"DELETE"), MethodKind::Delete);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"OPTIONS"), MethodKind::Options);
}

#[test]
fn method_from_bytes_ignore_case_lower() {
    assert_eq!(MethodKind::from_bytes_ignore_case(b"get"), MethodKind::Get);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"post"), MethodKind::Post);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"options"), MethodKind::Options);
}

#[test]
fn method_from_bytes_ignore_case_unknown() {
    assert_eq!(MethodKind::from_bytes_ignore_case(b"FETCH"), MethodKind::Other);
    assert_eq!(MethodKind::from_bytes_ignore_case(b""), MethodKind::Other);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"GETX"), MethodKind::Other);
    assert_eq!(MethodKind::from_bytes_ignore_case(b"POSTING"), MethodKind::Other);
}

#[test]
fn method_from_str_upper() {
    assert_eq!(MethodKind::from_str("GET"), MethodKind::Get);
    assert_eq!(MethodKind::from_str("DELETE"), MethodKind::Delete);
    assert_eq!(MethodKind::from_str("WEIRD"), MethodKind::Other);
}

#[test]
fn method_bits_are_distinct() {
    let bits: std::collections::HashSet<u16> =
        [MethodKind::Get, MethodKind::Head, MethodKind::Post, MethodKind::Put, MethodKind::Patch, MethodKind::Delete, MethodKind::Options]
            .iter()
            .map(|m| m.bit())
            .collect();
    assert_eq!(bits.len(), 7, "each method must have a unique bit");
}

// ── cors ──────────────────────────────────────────────────────────

fn cors_options(origin: Vec<String>, methods: Vec<String>, headers: Vec<String>, creds: bool) -> CorsOptions {
    CorsOptions {
        allow_origin: Some(origin),
        allow_methods: Some(methods),
        allow_headers: Some(headers),
        expose_headers: None,
        allow_credentials: Some(creds),
        max_age: None,
    }
}

#[test]
fn cors_wildcard_with_credentials_rejected() {
    let opts = cors_options(vec!["*".to_string()], vec![], vec![], true);
    assert!(CorsEngine::from_options(Some(opts)).is_err());
}

#[test]
fn cors_wildcard_without_credentials_ok() {
    let opts = cors_options(vec!["*".to_string()], vec![], vec![], false);
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([("origin", "https://anywhere.com")]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Get, &h);
    assert!(ev.allowed);
    assert!(!ev.preflight);
}

#[test]
fn cors_allowlist_matching_origin() {
    let opts = cors_options(
        vec!["https://app.example.com".to_string()],
        vec!["GET".to_string(), "POST".to_string()],
        vec![],
        true,
    );
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([("origin", "https://app.example.com")]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Get, &h);
    assert!(ev.allowed);
}

#[test]
fn cors_allowlist_non_matching_origin() {
    let opts = cors_options(
        vec!["https://app.example.com".to_string()],
        vec!["GET".to_string()],
        vec![],
        true,
    );
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([("origin", "https://evil.example.net")]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Get, &h);
    assert!(!ev.allowed);
}

#[test]
fn cors_no_origin_never_allowed() {
    let opts = cors_options(vec!["*".to_string()], vec![], vec![], false);
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([]);
    let h = HeaderRefs::parse(&packed, false, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Get, &h);
    assert!(!ev.allowed);
}

#[test]
fn cors_preflight_allowed() {
    let opts = cors_options(
        vec!["https://app.example.com".to_string()],
        vec!["POST".to_string()],
        vec!["Content-Type".to_string()],
        true,
    );
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([
        ("origin", "https://app.example.com"),
        ("access-control-request-method", "POST"),
        ("access-control-request-headers", "Content-Type"),
    ]);
    let h = HeaderRefs::parse(&packed, true, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Options, &h);
    assert!(ev.preflight);
    assert!(ev.allowed);
}

#[test]
fn cors_preflight_disallowed_method() {
    let opts = cors_options(
        vec!["https://app.example.com".to_string()],
        vec!["GET".to_string()],
        vec![],
        true,
    );
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([
        ("origin", "https://app.example.com"),
        ("access-control-request-method", "DELETE"),
    ]);
    let h = HeaderRefs::parse(&packed, true, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Options, &h);
    assert!(ev.preflight);
    assert!(!ev.allowed);
}

#[test]
fn cors_preflight_disallowed_header() {
    let opts = cors_options(
        vec!["https://app.example.com".to_string()],
        vec!["POST".to_string()],
        vec!["Content-Type".to_string()],
        true,
    );
    let engine = CorsEngine::from_options(Some(opts)).unwrap();
    let packed = pack_headers([
        ("origin", "https://app.example.com"),
        ("access-control-request-method", "POST"),
        ("access-control-request-headers", "X-Secret-Token"),
    ]);
    let h = HeaderRefs::parse(&packed, true, 100).unwrap();
    let ev = engine.evaluate(MethodKind::Options, &h);
    assert!(ev.preflight);
    assert!(!ev.allowed);
}

// ── query_parser ──────────────────────────────────────────────────

#[test]
fn query_parse_basic_pairs() {
    let packed = crate::query_parser::query_parse_packed_vec(b"a=1&b=2").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
}

#[test]
fn query_parse_percent_and_plus_decoding() {
    let packed = crate::query_parser::query_parse_packed_vec(b"name=John%20Doe&q=a+b").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"name".to_vec(), b"John Doe".to_vec()));
    assert_eq!(pairs[1], (b"q".to_vec(), b"a b".to_vec()));
}

#[test]
fn query_parse_empty_value() {
    let packed = crate::query_parser::query_parse_packed_vec(b"flag").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"flag".to_vec(), b"".to_vec()));
}

#[test]
fn query_parse_invalid_percent_rejected() {
    assert!(crate::query_parser::query_parse_packed_vec(b"a=%ZZ").is_err());
}

#[test]
fn query_parse_empty_input() {
    let packed = crate::query_parser::query_parse_packed_vec(b"").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert!(pairs.is_empty());
}

// ── cookie_parser ─────────────────────────────────────────────────

#[test]
fn cookie_parse_basic() {
    let packed = crate::cookie_parser::cookie_parse_packed_vec(b"a=1; b=2");
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
}

#[test]
fn cookie_parse_trims_whitespace() {
    let packed = crate::cookie_parser::cookie_parse_packed_vec(b" a = 1 ; b = hello world ");
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"hello world".to_vec()));
}

#[test]
fn cookie_parse_skips_empty_name() {
    let packed = crate::cookie_parser::cookie_parse_packed_vec(b"=1; =2; ok=3");
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"ok".to_vec(), b"3".to_vec()));
}

#[test]
fn cookie_parse_empty_value() {
    let packed = crate::cookie_parser::cookie_parse_packed_vec(b"session=");
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"session".to_vec(), b"".to_vec()));
}

// ── json_ser ──────────────────────────────────────────────────────

#[test]
fn json_escaped_len_plain_ascii() {
    assert_eq!(crate::json_ser::json_escaped_len(b"hello world"), 11);
}

#[test]
fn json_escaped_len_quotes_and_backslash() {
    // "a\"b" -> a, \", b = 3 chars + 1 extra for the escaped quote.
    assert_eq!(crate::json_ser::json_escaped_len(b"a\"b"), 4);
    // backslash doubles: bytes a, \, b = 3 -> 4 escaped.
    assert_eq!(crate::json_ser::json_escaped_len(b"a\\b"), 4);
}

#[test]
fn json_escaped_len_newline() {
    assert_eq!(crate::json_ser::json_escaped_len(b"a\nb"), 4);
}

#[test]
fn json_escaped_len_control_char_wide() {
    // 0x01 must be escaped as \u0001 -> 6 bytes for 1 input byte.
    assert_eq!(crate::json_ser::json_escaped_len(&[b'a', 0x01, b'b']), 8);
}

#[test]
fn cookie_json_into_slice_output() {
    let mut out = vec![0u8; 256];
    let written = crate::json_ser::cookie_json_into_slice(b"a=1; b=hello world", &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"hello world\"}");
}

#[test]
fn cookie_json_into_slice_escapes() {
    let mut out = vec![0u8; 256];
    let written = crate::json_ser::cookie_json_into_slice(b"k=\"v\"", &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"k\":\"\\\"v\\\"\"}");
}

#[test]
fn cookie_json_into_slice_small_buffer_errors() {
    let mut out = vec![0u8; 8];
    let res = crate::json_ser::cookie_json_into_slice(b"a=1; b=2; c=3; d=4", &mut out, 100);
    assert!(res.is_err(), "truncation must surface as an error, not silent data loss");
}

#[test]
fn packed_pairs_to_json_into_slice_output() {
    // Build packed query pairs for a=1 & b=2 via the query parser, then serialize.
    let packed = crate::query_parser::query_parse_packed_vec(b"a=1&b=2").unwrap();
    let mut out = vec![0u8; 256];
    let written = crate::json_ser::packed_pairs_to_json_into_slice(&packed, &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"2\"}");
}

// ── Malformed-input panic safety ──────────────────────────────────

// Deterministic xorshift PRNG so the fuzz-style tests are reproducible.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

#[test]
fn parsers_do_not_panic_on_malformed_input() {
    let mut rng = Rng(0xdeadbeef);

    for _ in 0..2000 {
        let len = (rng.next() % 64) as usize;
        let data = rng.bytes(len);

        // Every reachable parser must return Ok/Err, never panic.
        let _ = crate::query_parser::query_parse_packed_vec(&data);
        let _ = crate::cookie_parser::cookie_parse_packed_vec(&data);
        let _ = HeaderRefs::parse(&data, (rng.next() & 1) == 1, 100);
        let _ = crate::json_ser::cookie_json_into_slice(&data, &mut vec![0u8; 64], 100);
        let _ = crate::json_ser::json_escaped_len(&data);
    }
}

#[test]
fn header_parser_do_not_panic_on_adversarial_packed_headers() {
    let mut rng = Rng(0xc0ffee);

    for _ in 0..2000 {
        // Length fields are arbitrary bytes -> must not cause OOB reads/panics.
        let len = (rng.next() % 48) as usize;
        let data = rng.bytes(len);
        let _ = HeaderRefs::parse(&data, true, 200);
        let _ = HeaderRefs::parse(&data, false, 200);
    }
}
