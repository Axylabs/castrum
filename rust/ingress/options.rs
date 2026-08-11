// rust/ingress/options.rs — Ingress option types + request limits.
//
// JS-facing configuration structs (`#[napi(object)]`) plus the internal
// `Limits` defaults/validation. Kept separate from the pipeline so the
// constructor's marshaling stays close to the shapes it consumes.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ingress::cors::CorsOptions;

#[napi(object)]
pub struct RateLimitOptions {
    pub limit: Option<u32>,
    pub window_ms: Option<u32>,
    pub max_entries: Option<u32>,
}

#[napi(object)]
pub struct TrustedProxyOptions {
    pub enabled: Option<bool>,
    pub networks: Option<Vec<String>>,
}

#[napi(object)]
pub struct IngressLimitsOptions {
    pub max_url_bytes: Option<u32>,
    pub max_query_bytes: Option<u32>,
    pub max_cookie_bytes: Option<u32>,
    pub max_headers_bytes: Option<u32>,
    pub max_headers: Option<u32>,
    pub max_pairs: Option<u32>,
}

#[napi(object)]
pub struct IngressOptions {
    pub trust_proxy: Option<bool>,
    pub trusted_proxies: Option<TrustedProxyOptions>,
    pub parse_cookies: Option<bool>,
    pub parse_query: Option<bool>,
    pub require_json_body: Option<bool>,
    pub schema: Option<Uint8Array>,
    pub cors: Option<CorsOptions>,
    pub rate_limit: Option<RateLimitOptions>,
    pub https: Option<bool>,
    pub max_body_bytes: Option<u32>,
    pub enable_body_size_guard: Option<bool>,
    pub emit_metadata_json: Option<bool>,
    pub limits: Option<IngressLimitsOptions>,
}

// ── Limits ────────────────────────────────────────────────────────
// Default per-request ingress limits (bytes / counts). These bound how much
// of a request the pipeline will buffer/parse, protecting against oversized
// URL/query/cookie/header blocks. Tunable via `limits` in the ingress options.
pub(crate) const DEFAULT_MAX_URL_BYTES: usize = 65536;
pub(crate) const DEFAULT_MAX_QUERY_BYTES: usize = 16384;
pub(crate) const DEFAULT_MAX_COOKIE_BYTES: usize = 8192;
pub(crate) const DEFAULT_MAX_HEADERS_BYTES: usize = 65536;
pub(crate) const DEFAULT_MAX_HEADERS: usize = 100;
pub(crate) const DEFAULT_MAX_PAIRS: usize = 1024;
pub(crate) const DEFAULT_MAX_BODY_BYTES: usize = 1_048_576;

#[derive(Clone)]
pub(crate) struct Limits {
    pub max_url_bytes: usize,
    pub max_query_bytes: usize,
    pub max_cookie_bytes: usize,
    pub max_headers_bytes: usize,
    pub max_headers: usize,
    pub max_pairs: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_url_bytes: DEFAULT_MAX_URL_BYTES,
            max_query_bytes: DEFAULT_MAX_QUERY_BYTES,
            max_cookie_bytes: DEFAULT_MAX_COOKIE_BYTES,
            max_headers_bytes: DEFAULT_MAX_HEADERS_BYTES,
            max_headers: DEFAULT_MAX_HEADERS,
            max_pairs: DEFAULT_MAX_PAIRS,
        }
    }
}

impl Limits {
    pub(crate) fn from_options(opts: Option<IngressLimitsOptions>) -> Self {
        let d = Self::default();
        let Some(o) = opts else { return d };

        Self {
            max_url_bytes: o
                .max_url_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_url_bytes),
            max_query_bytes: o
                .max_query_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_query_bytes),
            max_cookie_bytes: o
                .max_cookie_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_cookie_bytes),
            max_headers_bytes: o
                .max_headers_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_headers_bytes),
            max_headers: o.max_headers.map(|v| v as usize).unwrap_or(d.max_headers),
            max_pairs: o.max_pairs.map(|v| v as usize).unwrap_or(d.max_pairs),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_defaults() {
        let d = Limits::default();
        assert_eq!(d.max_url_bytes, DEFAULT_MAX_URL_BYTES);
        assert_eq!(d.max_query_bytes, DEFAULT_MAX_QUERY_BYTES);
        assert_eq!(d.max_cookie_bytes, DEFAULT_MAX_COOKIE_BYTES);
        assert_eq!(d.max_headers_bytes, DEFAULT_MAX_HEADERS_BYTES);
        assert_eq!(d.max_headers, DEFAULT_MAX_HEADERS);
        assert_eq!(d.max_pairs, DEFAULT_MAX_PAIRS);
    }

    #[test]
    fn limits_none_keeps_defaults() {
        let l = Limits::from_options(None);
        assert_eq!(l.max_url_bytes, DEFAULT_MAX_URL_BYTES);
        assert_eq!(l.max_pairs, DEFAULT_MAX_PAIRS);
        assert_eq!(l.max_headers, DEFAULT_MAX_HEADERS);
    }

    #[test]
    fn limits_partial_override_merges() {
        let opts = IngressLimitsOptions {
            max_url_bytes: Some(4096),
            max_query_bytes: None,
            max_cookie_bytes: None,
            max_headers_bytes: None,
            max_headers: None,
            max_pairs: None,
        };
        let l = Limits::from_options(Some(opts));
        // Overridden field wins; untouched fields keep their defaults.
        assert_eq!(l.max_url_bytes, 4096);
        assert_eq!(l.max_query_bytes, DEFAULT_MAX_QUERY_BYTES);
        assert_eq!(l.max_cookie_bytes, DEFAULT_MAX_COOKIE_BYTES);
        assert_eq!(l.max_headers_bytes, DEFAULT_MAX_HEADERS_BYTES);
        assert_eq!(l.max_headers, DEFAULT_MAX_HEADERS);
        assert_eq!(l.max_pairs, DEFAULT_MAX_PAIRS);
    }

    #[test]
    fn limits_full_override() {
        let opts = IngressLimitsOptions {
            max_url_bytes: Some(1),
            max_query_bytes: Some(2),
            max_cookie_bytes: Some(3),
            max_headers_bytes: Some(4),
            max_headers: Some(5),
            max_pairs: Some(6),
        };
        let l = Limits::from_options(Some(opts));
        assert_eq!(l.max_url_bytes, 1);
        assert_eq!(l.max_query_bytes, 2);
        assert_eq!(l.max_cookie_bytes, 3);
        assert_eq!(l.max_headers_bytes, 4);
        assert_eq!(l.max_headers, 5);
        assert_eq!(l.max_pairs, 6);
    }
}
