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
            max_url_bytes: 65536,
            max_query_bytes: 16384,
            max_cookie_bytes: 8192,
            max_headers_bytes: 65536,
            max_headers: 100,
            max_pairs: 1024,
        }
    }
}

impl Limits {
    pub(crate) fn from_options(opts: Option<IngressLimitsOptions>) -> Self {
        let d = Self::default();
        let Some(o) = opts else { return d };

        Self {
            max_url_bytes: o.max_url_bytes.map(|v| v as usize).unwrap_or(d.max_url_bytes),
            max_query_bytes: o.max_query_bytes.map(|v| v as usize).unwrap_or(d.max_query_bytes),
            max_cookie_bytes: o.max_cookie_bytes.map(|v| v as usize).unwrap_or(d.max_cookie_bytes),
            max_headers_bytes: o.max_headers_bytes.map(|v| v as usize).unwrap_or(d.max_headers_bytes),
            max_headers: o.max_headers.map(|v| v as usize).unwrap_or(d.max_headers),
            max_pairs: o.max_pairs.map(|v| v as usize).unwrap_or(d.max_pairs),
        }
    }
}
