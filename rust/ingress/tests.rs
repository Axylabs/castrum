    use super::*;
    use crate::ingress::output::{
        ERR_CODE_BAD_REQUEST, ERR_CODE_BODY_TOO_LARGE, ERR_CODE_INVALID_JSON, ERR_CODE_NONE,
        OUT_ERROR_CODE, OUT_HEADER_VARIANT, OUT_STATUS, OUT_VERDICT, HV_JSON,
    };

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
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 200);
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
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 413);
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
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 400);
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
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 414);
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
        let header_pairs_len: usize = headers
            .iter()
            .map(|(n, v)| 2 + n.len() + 4 + v.len())
            .sum();
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
            .full_sync_into(0, "/api/users", "127.0.0.1", "rid-1", headers, b"", &mut out)
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
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 200);
    }

    #[test]
    fn full_sync_into_rejects_tiny_output_buffer() {
        let ingress = Ingress::new(base_options()).unwrap();
        let mut tiny = vec![0u8; OUT_DATA_START - 1];
        let err = ingress.full_sync_into(0, "/x", "1.1.1.1", "rid", vec![], b"", &mut tiny);
        assert!(err.is_err());
    }
