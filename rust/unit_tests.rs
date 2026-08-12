// rust/unit_tests.rs — Rust unit tests for the pure-Rust core modules.
//
// The napi-facing entry points are thin wrappers; these tests exercise the
// actual logic (parsers, rate limiter, IP trust, CORS, output layout, JSON
// serialization) directly. Run with `cargo test`.

#![cfg(test)]

use crate::http::headers::HeaderRefs;
use crate::http::method::MethodKind;
use crate::ingress::cors::{CorsEngine, CorsOptions};
use crate::ingress::ip_trust::{resolve_client_ip, ProxyTrustMode};
use crate::ingress::output::{
    compute_header_variant, write_output_header, HV_CORS_PREFLIGHT, HV_CORS_SIMPLE, HV_JSON,
    HV_RATE_ACTIVE, HV_RATE_LIMITED, OUT_BODY_JSON_LEN, OUT_COOKIES_JSON_LEN, OUT_DATA_START,
    OUT_ERROR_CODE, OUT_FLAGS, OUT_HEADER_VARIANT, OUT_QUERY_JSON_LEN, OUT_RATE_LIMIT,
    OUT_RATE_REMAINING, OUT_RATE_RESET, OUT_RETRY_AFTER, OUT_STATUS, OUT_VERDICT,
};
use crate::ingress::rate_limit::KeyedRateLimiter;
use crate::test_support::{decode_packed_pairs, pack_headers, Rng};

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
    assert!(
        !denied.allowed,
        "6th request within window should be denied"
    );
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
    assert!(
        rl.check_key(2, 1).allowed,
        "different key should have its own bucket"
    );
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

    let a = crate::ingress::rate_limit::shared_limiter(100, 60_000, None).unwrap();
    let b = crate::ingress::rate_limit::shared_limiter(100, 60_000, None).unwrap();
    assert!(
        Arc::ptr_eq(&a, &b),
        "identical config must share one process-wide limiter"
    );

    let c = crate::ingress::rate_limit::shared_limiter(100, 60_000, Some(10_000)).unwrap();
    assert!(
        !Arc::ptr_eq(&a, &c),
        "different max_entries must not share a limiter"
    );

    let d = crate::ingress::rate_limit::shared_limiter(200, 60_000, None).unwrap();
    assert!(
        !Arc::ptr_eq(&a, &d),
        "different limit must not share a limiter"
    );
}

#[test]
fn rate_limit_shared_limiter_refuses_17th_distinct_config() {
    // The registry is BOUNDED (MAX_SHARED_LIMITERS = 16) and must never
    // SILENTLY evict a live limiter (eviction resets per-IP budgets — a
    // rate-limit bypass vector). Fill it with 16 distinct configs (starting
    // with the 4 the other shared_limiter tests already register, so this is
    // deterministic regardless of test order), then assert a 17th throws.
    let mut configs: Vec<(u32, u32, usize)> = vec![
        (100, 60_000, 1_048_576), // matches shared_limiter(100, 60_000, None)
        (100, 60_000, 10_000), // matches shared_limiter(100, 60_000, Some(10_000))
        (200, 60_000, 1_048_576), // matches shared_limiter(200, 60_000, None)
        (2, 60_000, 1_048_576), // matches shared_limiter(2, 60_000, None)
    ];
    for i in 0..12u32 {
        configs.push((300 + i, 60_000, 1000 + i as usize));
    }
    for &(limit, window, max_entries) in &configs {
        let _ =
            crate::ingress::rate_limit::shared_limiter(limit, window, Some(max_entries))
                .expect("distinct config registers");
    }
    // Registry at capacity: a genuinely new config must error, not evict.
    let res = crate::ingress::rate_limit::shared_limiter(500_000, 60_000, Some(123_456));
    let err = match res {
        Ok(_) => panic!("17th distinct config must be refused, not silently evicted"),
        Err(e) => e,
    };
    assert!(
        err.contains("too many distinct rate-limit configurations"),
        "unexpected error: {err}"
    );
}

#[test]
fn rate_limit_shared_limiter_shares_budget() {
    // Two instances with the same config share one bucket — a request consumed
    // via one instance must count against the other (prevents route-splitting
    // bypass).
    let a = crate::ingress::rate_limit::shared_limiter(2, 60_000, None).unwrap();
    let b = crate::ingress::rate_limit::shared_limiter(2, 60_000, None).unwrap();
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
    let (resolved, peer_trusted) = resolve_client_ip(&mode, b"203.0.113.5", Some(b"6.6.6.6"), None);
    assert!(!peer_trusted);
    // Socket IP must win; XFF must be ignored.
    match resolved {
        crate::ingress::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 5]),
        _ => panic!("expected V4 socket IP"),
    }
}

#[test]
fn ip_trust_untrusted_socket_ignores_xff() {
    // Socket is NOT in the trusted networks -> XFF cannot spoof the client IP.
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    let (resolved, peer_trusted) = resolve_client_ip(&mode, b"203.0.113.9", Some(b"6.6.6.6"), None);
    assert!(!peer_trusted);
    match resolved {
        crate::ingress::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 9]),
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
        crate::ingress::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [8, 8, 8, 8]),
        _ => panic!("expected V4 8.8.8.8"),
    }
}

#[test]
fn ip_trust_all_trusted_xff_returns_last_entry() {
    let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
    let (resolved, peer_trusted) =
        resolve_client_ip(&mode, b"10.0.0.5", Some(b"10.0.0.1, 10.0.0.2"), None);
    assert!(peer_trusted);
    match resolved {
        crate::ingress::ip_trust::ResolvedIp::V4(o) => assert_eq!(o, [10, 0, 0, 1]),
        _ => panic!("expected V4 10.0.0.1"),
    }
}

// ── output ────────────────────────────────────────────────────────

#[test]
fn output_compute_header_variant_bits() {
    assert_eq!(
        compute_header_variant(false, false, false, false, true),
        HV_JSON
    );
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
        0,       // verdict
        3,       // error_code
        200,     // status
        0x1F,    // flags
        100,     // rate_limit
        50,      // rate_remaining
        123_456, // rate_reset_ms
        5,       // retry_after_ms
        10,      // cookies_json_len
        20,      // query_json_len
        HV_JSON | HV_RATE_ACTIVE,
        30, // body_json_len
    );

    assert_eq!(out[OUT_VERDICT], 0);
    assert_eq!(out[OUT_ERROR_CODE], 3);
    assert_eq!(
        u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]),
        200
    );
    assert_eq!(
        u32::from_le_bytes([
            out[OUT_FLAGS],
            out[OUT_FLAGS + 1],
            out[OUT_FLAGS + 2],
            out[OUT_FLAGS + 3]
        ]),
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
    let retry = u64::from_le_bytes(
        out[OUT_RETRY_AFTER..OUT_RETRY_AFTER + 8]
            .try_into()
            .unwrap(),
    );
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
    let written = write_output_header(&mut out, 1, 6, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
    assert_eq!(status, 500, "invalid status must be coerced to 500");
    assert_eq!(written, OUT_DATA_START);
}

#[test]
fn output_write_header_clamps_out_of_range_status() {
    // The pipeline only emits 200 (`HeaderFields::ok`) or terminal 4xx/5xx;
    // out-of-range statuses (e.g. 101, 600) are intentionally clamped to 500
    // (see output.rs write_output_header).
    let mut out = vec![0u8; 128];
    write_output_header(&mut out, 1, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
    assert_eq!(status, 500);
}

#[test]
#[should_panic(expected = "output buffer too small")]
fn output_header_panics_on_undersized() {
    // Enterprise guard: `write_output_header` self-checks the full 48-byte
    // header up front so a miscalculated buffer becomes a clean panic (→ napi
    // catch_unwind → JS 500) instead of a silent OOB write.
    let mut out = vec![0u8; crate::ingress::output::OUT_DATA_START - 1];
    crate::ingress::output::write_output_header(
        &mut out,
        0,
        0,
        200,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    );
}

#[test]
fn random_token_rejects_huge_len() {
    // A u32 byte_len must not be able to trigger a ~4 GiB single allocation.
    assert!(
        crate::crypto::random_token::random_token(16 * 1024 * 1024 + 1).is_err(),
        "huge byte_len must error"
    );
    // A normal size still works.
    assert!(crate::crypto::random_token::random_token(32).is_ok());
}

#[test]
fn init_thread_pool_is_idempotent() {
    // The rayon global pool is process-wide and first-call-wins. A second
    // init_thread_pool (after a prior init OR after a direct par_iter
    // auto-initialized rayon) must return Ok — never a poisoned error.
    let first = crate::util::threadpool::init_thread_pool(Some(2));
    let second = crate::util::threadpool::init_thread_pool(Some(2));
    assert!(first.is_ok(), "first init must succeed (got {first:?})");
    assert!(
        second.is_ok(),
        "second init must be a no-op, not an error (got {second:?})"
    );
}

#[test]
#[should_panic(expected = "hex_encode: output buffer too small")]
fn hex_encode_panics_on_undersized() {
    let mut out = [0u8; 4];
    crate::util::bytes::hex_encode(b"abcd", &mut out);
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
    // ACRH value is captured on OPTIONS (no dedicated flag/method).
    assert_eq!(h2.acrh(), Some(&b"Content-Type"[..]));
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
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"HEAD"),
        MethodKind::Head
    );
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"POST"),
        MethodKind::Post
    );
    assert_eq!(MethodKind::from_bytes_ignore_case(b"PUT"), MethodKind::Put);
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"PATCH"),
        MethodKind::Patch
    );
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"DELETE"),
        MethodKind::Delete
    );
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"OPTIONS"),
        MethodKind::Options
    );
}

#[test]
fn method_from_bytes_ignore_case_lower() {
    assert_eq!(MethodKind::from_bytes_ignore_case(b"get"), MethodKind::Get);
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"post"),
        MethodKind::Post
    );
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"options"),
        MethodKind::Options
    );
}

#[test]
fn method_from_bytes_ignore_case_unknown() {
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"FETCH"),
        MethodKind::Other
    );
    assert_eq!(MethodKind::from_bytes_ignore_case(b""), MethodKind::Other);
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"GETX"),
        MethodKind::Other
    );
    assert_eq!(
        MethodKind::from_bytes_ignore_case(b"POSTING"),
        MethodKind::Other
    );
}

#[test]
fn method_from_str_upper() {
    assert_eq!(MethodKind::from_str("GET"), MethodKind::Get);
    assert_eq!(MethodKind::from_str("DELETE"), MethodKind::Delete);
    assert_eq!(MethodKind::from_str("WEIRD"), MethodKind::Other);
}

#[test]
fn method_bits_are_distinct() {
    let bits: std::collections::HashSet<u16> = [
        MethodKind::Get,
        MethodKind::Head,
        MethodKind::Post,
        MethodKind::Put,
        MethodKind::Patch,
        MethodKind::Delete,
        MethodKind::Options,
    ]
    .iter()
    .map(|m| m.bit())
    .collect();
    assert_eq!(bits.len(), 7, "each method must have a unique bit");
}

// ── cors ──────────────────────────────────────────────────────────

fn cors_options(
    origin: Vec<String>,
    methods: Vec<String>,
    headers: Vec<String>,
    creds: bool,
) -> CorsOptions {
    CorsOptions {
        allow_origin: Some(origin),
        allow_methods: Some(methods),
        allow_headers: Some(headers),
        allow_credentials: Some(creds),
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
    let packed = crate::http::query_parser::query_parse_packed_vec(b"a=1&b=2").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
}

#[test]
fn query_parse_percent_and_plus_decoding() {
    let packed =
        crate::http::query_parser::query_parse_packed_vec(b"name=John%20Doe&q=a+b").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"name".to_vec(), b"John Doe".to_vec()));
    assert_eq!(pairs[1], (b"q".to_vec(), b"a b".to_vec()));
}

#[test]
fn query_parse_empty_value() {
    let packed = crate::http::query_parser::query_parse_packed_vec(b"flag").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"flag".to_vec(), b"".to_vec()));
}

#[test]
fn query_parse_invalid_percent_rejected() {
    assert!(crate::http::query_parser::query_parse_packed_vec(b"a=%ZZ").is_err());
}

#[test]
fn query_parse_empty_input() {
    let packed = crate::http::query_parser::query_parse_packed_vec(b"").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert!(pairs.is_empty());
}

// ── cookie_parser ─────────────────────────────────────────────────

#[test]
fn cookie_parse_basic() {
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(b"a=1; b=2").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
}

#[test]
fn cookie_parse_trims_whitespace() {
    let packed =
        crate::http::cookie_parser::cookie_parse_packed_vec(b" a = 1 ; b = hello world ").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
    assert_eq!(pairs[1], (b"b".to_vec(), b"hello world".to_vec()));
}

#[test]
fn cookie_parse_skips_empty_name() {
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(b"=1; =2; ok=3").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"ok".to_vec(), b"3".to_vec()));
}

#[test]
fn cookie_parse_empty_value() {
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(b"session=").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"session".to_vec(), b"".to_vec()));
}

#[test]
fn query_parse_null_byte_preserved() {
    // `%00` decodes to a NUL byte inside the value (byte-oriented parser).
    let packed = crate::http::query_parser::query_parse_packed_vec(b"a=%00b").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"a".to_vec(), b"\x00b".to_vec()));
}

#[test]
fn query_parse_semicolon_is_data() {
    // In a query string `&` separates pairs; `;` is ordinary data.
    let packed = crate::http::query_parser::query_parse_packed_vec(b"a=1;b=2").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"a".to_vec(), b"1;b=2".to_vec()));
}

#[test]
fn query_parse_non_utf8_byte_passthrough() {
    // `%FF` decodes to a raw 0xFF byte; the parser does not require valid
    // UTF-8 in query values (callers must handle it when they do).
    let packed = crate::http::query_parser::query_parse_packed_vec(b"a=%FF").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"a".to_vec(), vec![0xFF]));
}

#[test]
fn cookie_parse_equals_in_value() {
    // Only the first `=` separates name from value.
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(b"a=b=c").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0], (b"a".to_vec(), b"b=c".to_vec()));
}

#[test]
fn cookie_parse_expires_value_with_commas() {
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(
        b"session=abc; expires=Wed, 21 Oct 2015 07:28:00 GMT",
    )
    .unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(
        pairs[1],
        (b"expires".to_vec(), b"Wed, 21 Oct 2015 07:28:00 GMT".to_vec())
    );
}

#[test]
fn cookie_parse_quotes_are_not_special() {
    // Cookies split on `;` unconditionally — quotes are ordinary data, and a
    // token without `=` becomes a pair with an empty value.
    let packed = crate::http::cookie_parser::cookie_parse_packed_vec(b"a=\"x;y\"").unwrap();
    let pairs = decode_packed_pairs(&packed);
    assert_eq!(pairs.len(), 2);
    assert_eq!(pairs[0], (b"a".to_vec(), b"\"x".to_vec()));
    assert_eq!(pairs[1], (b"y\"".to_vec(), b"".to_vec()));
}

// ── json_ser ──────────────────────────────────────────────────────

#[test]
fn json_escaped_len_plain_ascii() {
    assert_eq!(crate::json::json_ser::json_escaped_len(b"hello world"), 11);
}

#[test]
fn json_escaped_len_quotes_and_backslash() {
    // "a\"b" -> a, \", b = 3 chars + 1 extra for the escaped quote.
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\"b"), 4);
    // backslash doubles: bytes a, \, b = 3 -> 4 escaped.
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\\b"), 4);
}

#[test]
fn json_escaped_len_newline() {
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\nb"), 4);
}

#[test]
fn json_escaped_len_control_char_wide() {
    // 0x01 must be escaped as \u0001 -> 6 bytes for 1 input byte.
    assert_eq!(
        crate::json::json_ser::json_escaped_len(&[b'a', 0x01, b'b']),
        8
    );
}

#[test]
fn json_escaped_len_short_control_escapes() {
    // \r, \t, \x08, \x0c are written as 2-byte escapes, each contributing
    // +1. (memchr3 only finds ", \, \n; the run scanner handles these.)
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\rb"), 4); // a, \r, b
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\tb"), 4);
    assert_eq!(
        crate::json::json_ser::json_escaped_len(&[b'a', 0x08, b'b']),
        4
    );
    assert_eq!(
        crate::json::json_ser::json_escaped_len(&[b'a', 0x0c, b'b']),
        4
    );
    // Mixed: newline (memchr3 path) + tab (trailing path).
    assert_eq!(crate::json::json_ser::json_escaped_len(b"a\n\tb"), 6);
}

#[test]
fn json_escaped_len_fused_matches_write_on_utf8_corpus() {
    // The fused len (single pass: memchr3 + gap UTF-8 validation) must exactly
    // equal the bytes `write_json_escaped` emits for valid non-ASCII UTF-8 AND
    // invalid UTF-8 (where every byte becomes \u00XX).
    let cases: &[&[u8]] = &[
        "héllo wörld".as_bytes(),                           // valid non-ASCII, no escapes
        "caf\u{00e9} \u{201c}quoted\u{201d}".as_bytes(),    // valid with escapes
        &[b'a', 0xC3, 0xA9, b'b'],                          // é valid
        &[b'"', 0xC3, 0xA9, b'\\'],                         // escapes + multibyte
        &[0xFF, 0xFE, b'a'],                                // invalid UTF-8
        &[b'a', 0x80, b'b'],                                // lone continuation byte
        &[0xC3, b' ', b'x'],                                // truncated multibyte
        &[b'a', b'\\', 0xFF, b'\n', 0x01],                  // mixed invalid + escapes
        "日本語のテキスト".as_bytes(),                        // pure multibyte, no ASCII
    ];
    for input in cases {
        let len = crate::json::json_ser::json_escaped_len(input);
        let mut out = vec![0u8; len];
        let mut pos = 0usize;
        crate::json::json_ser::write_json_escaped(&mut out, &mut pos, input);
        assert_eq!(pos, len, "len must match written for {input:?}");
    }
}

#[test]
fn json_escaped_len_invalid_utf8_is_len_times_six() {
    let cases: &[&[u8]] = &[
        &[0xFF, 0xFE],
        &[b'a', 0x80, b'b'],
        &[0xC3, b' '],
        &[b'a', b'\\', 0xFF],
    ];
    for input in cases {
        let len = crate::json::json_ser::json_escaped_len(input);
        assert_eq!(len, input.len() * 6, "input: {input:?}");
    }
}

#[test]
fn write_json_escaped_never_overflows_exact_buffer() {
    // Regression: a buffer sized EXACTLY by json_escaped_len must never
    // overflow. Before the fix, \r/\t/\x08/\x0c were undercounted → the write
    // past the end panicked (caught by napi → 500) or corrupted memory.
    let cases: &[&[u8]] = &[
        b"a\rb",
        b"a\tb",
        &[b'a', 0x08, b'b'],
        &[b'a', 0x0c, b'b'],
        b"cookie=1; other=2\r\n\t",
        b"\t\r\x08\x0c\"\\\n\x01\x1f",
    ];

    for input in cases {
        let len = crate::json::json_ser::json_escaped_len(input);
        let mut out = vec![0u8; len];
        let mut pos = 0usize;
        crate::json::json_ser::write_json_escaped(&mut out, &mut pos, input);
        assert_eq!(
            pos, len,
            "must write exactly json_escaped_len bytes: {input:?}"
        );
    }
}

#[test]
fn write_json_escaped_escapes_control_before_special() {
    // Regression: control chars that appear BEFORE a memchr3 special (", \,
    // \n) must still be escaped. Previously they were copied raw into the JSON
    // string → RFC-8259-invalid output (e.g. a cookie value `a\tb"c` or a URL
    // query `?q=%09%22`). The length accounting must match the write exactly.
    let cases: &[(&[u8], &[u8])] = &[
        // a\rb"c → a \\r b \"
        (
            b"a\rb\"c",
            &[
                b'a', b'\\', b'r', b'b', // \r → \\r
                b'\\', b'"', // " → \"
                b'c',
            ],
        ),
        // a\tb\\c → a \t b \ \
        (
            b"a\tb\\c",
            &[
                b'a', b'\\', b't', b'b', // \t → \\t
                b'\\', b'\\', // \ → \\
                b'c',
            ],
        ),
        // 0x01 before \n → \u0001 then \n
        (
            &[b'a', 0x01, b'b', b'\n', b'c'],
            &[
                b'a', b'\\', b'u', b'0', b'0', b'0', b'1', // \u0001
                b'b', b'\\', b'n', b'c', // \n
            ],
        ),
    ];

    for (input, expected) in cases {
        let len = crate::json::json_ser::json_escaped_len(input);
        let mut out = vec![0u8; len];
        let mut pos = 0usize;
        crate::json::json_ser::write_json_escaped(&mut out, &mut pos, input);
        assert_eq!(pos, len, "accounting must be exact for {input:?}");
        assert_eq!(
            &out[..pos],
            *expected,
            "output must be valid JSON for {input:?}"
        );
    }
}

#[test]
fn cookie_json_into_slice_short_control_escapes() {
    // Cookie values containing \r/\t must serialize correctly into a buffer
    // sized by the (fixed) length accounting.
    let mut out = vec![0u8; 256];
    let written =
        crate::json::json_ser::cookie_json_into_slice(b"a=va\tl; b=x\ry", &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"a\":\"va\\tl\",\"b\":\"x\\ry\"}");
}

#[test]
fn cookie_json_into_slice_output() {
    let mut out = vec![0u8; 256];
    let written =
        crate::json::json_ser::cookie_json_into_slice(b"a=1; b=hello world", &mut out, 100)
            .unwrap();
    assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"hello world\"}");
}

#[test]
fn cookie_json_into_slice_escapes() {
    let mut out = vec![0u8; 256];
    let written = crate::json::json_ser::cookie_json_into_slice(b"k=\"v\"", &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"k\":\"\\\"v\\\"\"}");
}

#[test]
fn cookie_json_into_slice_small_buffer_errors() {
    let mut out = vec![0u8; 8];
    let res = crate::json::json_ser::cookie_json_into_slice(b"a=1; b=2; c=3; d=4", &mut out, 100);
    assert!(
        res.is_err(),
        "truncation must surface as an error, not silent data loss"
    );
}

#[test]
fn packed_pairs_to_json_into_slice_output() {
    // Build packed query pairs for a=1 & b=2 via the query parser, then serialize.
    let packed = crate::http::query_parser::query_parse_packed_vec(b"a=1&b=2").unwrap();
    let mut out = vec![0u8; 256];
    let written =
        crate::json::json_ser::packed_pairs_to_json_into_slice(&packed, &mut out, 100).unwrap();
    assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"2\"}");
}

#[test]
fn query_to_json_into_slice_matches_packed_pipeline() {
    // The direct writer must produce byte-identical output to the two-step
    // query_parse_packed_vec + packed_pairs_to_json_into_slice pipeline it
    // replaces on the ingress hot path.
    use crate::json::json_ser::{query_to_json_into_slice, QueryJsonError};
    let cases: &[&[u8]] = &[
        b"a=1&b=2",
        b"name=John%20Doe&q=a+b",
        b"flag",
        b"",
        b"x=%41%42",
        b"a=%ZZ",
        b"k=%E2%82%AC", // euro (valid UTF-8 after decode)
        b"weird=%FF",   // invalid UTF-8 after decode (binary escape path)
        b"a=1&a=2&a=3",
        b"spaces=+a+b+c+",
    ];
    for &raw in cases {
        let packed = crate::http::query_parser::query_parse_packed_vec(raw);
        let mut direct_out = vec![0u8; 512];
        let direct = query_to_json_into_slice(raw, &mut direct_out, 100);
        match (&packed, &direct) {
            (Ok(packed), Ok(written)) => {
                let mut ref_out = vec![0u8; 512];
                let ref_written = crate::json::json_ser::packed_pairs_to_json_into_slice(
                    packed,
                    &mut ref_out,
                    100,
                )
                .unwrap();
                assert_eq!(
                    &direct_out[..*written],
                    &ref_out[..ref_written],
                    "query={raw:?}"
                );
            }
            (Err(_), Err(QueryJsonError::Malformed)) => {} // both reject malformed %XX
            (other, _) => panic!("mismatched outcome for query={raw:?}: {other:?} vs {direct:?}"),
        }
    }

    // Buffer-too-small must surface as BufferTooSmall (→ truncated), not Malformed.
    let mut tiny = vec![0u8; 2];
    assert!(matches!(
        query_to_json_into_slice(b"a=1", &mut tiny, 100),
        Err(QueryJsonError::BufferTooSmall)
    ));
}

// ── Malformed-input panic safety ──────────────────────────────────

#[test]
fn parsers_do_not_panic_on_malformed_input() {
    let mut rng = Rng(0xdeadbeef);

    for _ in 0..2000 {
        let len = (rng.next() % 64) as usize;
        let data = rng.bytes(len);

        // Every reachable parser must return Ok/Err, never panic.
        let _ = crate::http::query_parser::query_parse_packed_vec(&data);
        let _ = crate::http::cookie_parser::cookie_parse_packed_vec(&data);
        let _ = HeaderRefs::parse(&data, (rng.next() & 1) == 1, 100);
        let _ = crate::json::json_ser::cookie_json_into_slice(&data, &mut [0u8; 64], 100);
        let _ = crate::json::json_ser::json_escaped_len(&data);
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

// ── New packed batch entry points (fnv1a64, etag, url, mime, ws, passwordVerify, urlResolve) ──

use napi::bindgen_prelude::Uint8Array;

/// Build the `[u32 count]{[u32 len][bytes]}` packed batch input for tests.
fn pack_slices(items: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for it in items {
        out.extend_from_slice(&(it.len() as u32).to_le_bytes());
        out.extend_from_slice(it);
    }
    out
}

fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn read_i64(buf: &[u8], off: usize) -> i64 {
    i64::from_le_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ])
}

#[test]
fn fnv1a64_batch_matches_scalar() {
    let out = crate::util::batch::fnv1a64_batch_packed(Uint8Array::new(pack_slices(&[
        b"foobar",
        b"",
        b"castrum",
    ])))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 3);
    assert_eq!(read_i64(out, 4), 0x8594_4171_f739_67e8u64 as i64);
    assert_eq!(read_i64(out, 12), 0xcbf2_9ce4_8422_2325u64 as i64);
    assert_eq!(
        read_i64(out, 20),
        crate::crypto::hashing::fnv1a64_bytes(b"castrum") as i64
    );
}

#[test]
fn etag_batch_matches_scalar() {
    let out = crate::http::etag::etag_batch_packed(
        Uint8Array::new(pack_slices(&[b"123456789", b"hello"])),
        None,
    )
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"\"cbf43926\"");
    // Weak variant is 12 bytes with the W/ prefix.
    let weak = crate::http::etag::etag_batch_packed(
        Uint8Array::new(pack_slices(&[b"123456789"])),
        Some(true),
    )
    .unwrap();
    let weak = weak.as_ref();
    let wlen = read_u32(weak, 4) as usize;
    assert_eq!(wlen, 12);
    assert_eq!(&weak[8..8 + wlen], b"W/\"cbf43926\"");
}

#[test]
fn url_encode_batch_matches_scalar() {
    let out = crate::http::url_codec::url_encode_batch_packed(Uint8Array::new(pack_slices(&[
        b"a b&c",
        b"plain",
    ])))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"a%20b%26c");
}

#[test]
fn url_decode_batch_matches_scalar() {
    let out = crate::http::url_codec::url_decode_batch_packed(Uint8Array::new(pack_slices(&[
        b"a%20b",
        b"plain",
    ])))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"a b");

    // Strict bytes decode (no UTF-8 validation): %C3%A9 → the two raw bytes.
    let out = crate::http::url_codec::url_decode_bytes_batch_packed(Uint8Array::new(pack_slices(
        &[b"%C3%A9"],
    )))
    .unwrap();
    let out = out.as_ref();
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], &[0xc3, 0xa9]);
}

#[test]
fn mime_from_extension_batch_matches_scalar() {
    let out = crate::http::mime_lookup::mime_from_extension_batch_packed(Uint8Array::new(
        pack_slices(&[b".js", b"PNG", b"nope"]),
    ))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 3);
    let mut off = 4usize;
    let expected = [
        b"text/javascript".as_slice(),
        b"image/png".as_slice(),
        b"application/octet-stream".as_slice(),
    ];
    for exp in expected {
        let len = read_u32(out, off) as usize;
        off += 4;
        assert_eq!(&out[off..off + len], exp);
        off += len;
    }
}

#[test]
fn ws_accept_key_batch_matches_rfc6455() {
    // Expected vector mirrors the repo's existing scalar test in
    // rust/payload/websocket.rs (rfc6455_accept_key_vector).
    let out = crate::payload::websocket::ws_accept_key_batch_packed(Uint8Array::new(
        pack_slices(&[b"dGhlIHNhbXBsZSBub25jZQ=="]),
    ))
    .unwrap();
    let out = out.as_ref();
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

#[test]
fn password_verify_batch_matches_scalar() {
    use crate::crypto::argon2::hash_password;
    // Low-cost argon2id so the test stays fast; salt must be >= 8 bytes.
    let phc = hash_password(b"hunter2", b"0123456789abcdef", 8, 1, 1, 16).unwrap();
    let good = crate::crypto::argon2::password_verify_batch_packed(
        Uint8Array::new(pack_slices(&[b"hunter2", b"wrong"])),
        Uint8Array::new(pack_slices(&[phc.as_bytes(), phc.as_bytes()])),
    )
    .unwrap();
    let good = good.as_ref();
    // bitset: bit0 = true (correct password), bit1 = false.
    assert_eq!(read_u32(good, 0), 2);
    assert_eq!(good[4] & 0b01, 0b01);
    assert_eq!(good[4] & 0b10, 0);
}

#[test]
fn url_resolve_batch_matches_rfc3986() {
    let base = b"http://a/b/c/d;p?q";
    let out = crate::http::url_join::url_resolve_batch_packed(
        Uint8Array::new(pack_slices(&[base.as_slice(), base.as_slice()])),
        Uint8Array::new(pack_slices(&[b"g", b"../g"])),
    )
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"http://a/b/c/g");
    let off = 8 + len0;
    let len1 = read_u32(out, off) as usize;
    assert_eq!(&out[off + 4..off + 4 + len1], b"http://a/b/g");
}
