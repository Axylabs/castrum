// rust/core/pipeline.rs — Pure Rust ingress pipeline
// No napi dependencies. This is the core request processing pipeline.

use crate::core::prelude::*;
use crate::core::method::MethodKind;
use crate::core::headers::HeaderRefs;
use crate::core::proxy;
use crate::core::output::{
    self, compute_header_variant, write_output_header,
    FLAG_BODY_TRUNCATED, FLAG_BODY_VALID_JSON, FLAG_CORS_ALLOWED,
    FLAG_IS_PREFLIGHT, FLAG_RATE_LIMITED, FLAG_SCHEMA_VALID,
    OUT_DATA_START,
};
use crate::core::runtime::Runtime;
use crate::core::terminal;
use crate::core::cors::CorsEngine;
use crate::core::rate_limit::KeyedRateLimiter;
use std::sync::Arc;

/// Configuration for the ingress pipeline.
#[derive(Clone)]
pub struct IngressConfig {
    pub https_fixed: Option<bool>,
    pub max_body_bytes: usize,
    pub parse_cookies: bool,
    pub parse_query: bool,
    pub require_json_body: bool,
    pub guard_enabled: bool,
    pub emit_metadata_json: bool,
    pub cors_enabled: bool,
    pub max_url_bytes: usize,
    pub max_query_bytes: usize,
    pub max_cookie_bytes: usize,
    pub max_headers_bytes: usize,
    pub max_headers: usize,
    pub max_pairs: usize,
}

impl Default for IngressConfig {
    fn default() -> Self {
        Self {
            https_fixed: None,
            max_body_bytes: 1_048_576,
            parse_cookies: false,
            parse_query: false,
            require_json_body: false,
            guard_enabled: true,
            emit_metadata_json: false,
            cors_enabled: false,
            max_url_bytes: 65536,
            max_query_bytes: 16384,
            max_cookie_bytes: 8192,
            max_headers_bytes: 65536,
            max_headers: 100,
            max_pairs: 1024,
        }
    }
}

/// The pure Rust ingress pipeline.
#[derive(Clone)]
pub struct IngressPipeline {
    inner: Arc<PipelineInner>,
}

#[derive(Clone)]
struct PipelineInner {
    config: IngressConfig,
    proxy_trust: crate::core::ip_trust::ProxyTrustMode,
    cors: CorsEngine,
    rate_limiter: Option<Arc<KeyedRateLimiter>>,
    rate_enabled: bool,
    schema: Option<Arc<jsonschema::Validator>>,
}

impl IngressPipeline {
    /// Create a new ingress pipeline.
    pub fn new(config: IngressConfig) -> Self {
        Self {
            inner: Arc::new(PipelineInner {
                config,
                proxy_trust: crate::core::ip_trust::ProxyTrustMode::None,
                cors: CorsEngine::disabled(),
                rate_limiter: None,
                rate_enabled: false,
                schema: None,
            }),
        }
    }

    /// Set the proxy trust mode.
    pub fn with_proxy_trust(mut self, mode: crate::core::ip_trust::ProxyTrustMode) -> Self {
        Arc::make_mut(&mut self.inner).proxy_trust = mode;
        self
    }

    /// Set the CORS engine.
    pub fn with_cors(mut self, cors: CorsEngine) -> Self {
        let inner = Arc::make_mut(&mut self.inner);
        inner.cors = cors;
        inner.config.cors_enabled = true;
        self
    }

    /// Set the rate limiter.
    pub fn with_rate_limiter(mut self, limiter: KeyedRateLimiter) -> Self {
        let inner = Arc::make_mut(&mut self.inner);
        inner.rate_limiter = Some(Arc::new(limiter));
        inner.rate_enabled = true;
        self
    }

    /// Process a packed request through the pipeline.
    ///
    /// * `input` - Packed input buffer (method byte + length-prefixed sections)
    /// * `body_bytes` - The request body
    /// * `out` - Output buffer to write the result into
    ///
    /// Returns the number of bytes written to `out`.
    pub fn process(&self, input: &[u8], body_bytes: &[u8], out: &mut [u8]) -> CoreResult<usize> {
        let inner = self.inner.as_ref();
        let config = &inner.config;

        if out.len() < OUT_DATA_START {
            return Err(buffer_too_small(OUT_DATA_START, out.len()));
        }
        if input.is_empty() {
            return Err(invalid_input("input buffer too small"));
        }

        // Parse packed input
        let mut pos = 1usize;
        let mk = MethodKind::from_u8(input[0]);
        let is_options = mk == MethodKind::Options;

        let url_bytes = read_section(input, &mut pos, config.max_url_bytes)
            .map_err(|_| malformed_data("url section", pos))?;

        let ip_bytes = read_section(input, &mut pos, 128)
            .map_err(|_| malformed_data("ip section", pos))?;

        let rid_bytes = read_section(input, &mut pos, 128)
            .map_err(|_| malformed_data("request id section", pos))?;

        let headers_packed = read_section(input, &mut pos, config.max_headers_bytes)
            .map_err(|_| malformed_data("headers section", pos))?;

        let headers = HeaderRefs::parse(headers_packed, is_options, config.max_headers)
            .map_err(|_| malformed_data("header parsing", pos))?;

        // Flags & rate limiting prep
        let mut flags: u32 = 0;
        let rate_active = inner.rate_enabled && inner.rate_limiter.is_some();

        let (resolved_ip, peer_trusted) =
            crate::core::ip_trust::resolve_client_ip(
                &inner.proxy_trust, ip_bytes, headers.xff(), headers.x_real_ip()
            );

        if peer_trusted {
            flags |= output::FLAG_TRUSTED_PROXY;
        }

        if proxy::detect_https(config.https_fixed, &inner.proxy_trust, url_bytes, &headers, peer_trusted) {
            flags |= output::FLAG_HTTPS;
        }

        // CORS evaluation
        if config.cors_enabled && headers.has_origin() {
            let eval = inner.cors.evaluate(mk, &headers);

            if eval.preflight {
                flags |= FLAG_IS_PREFLIGHT;
            }
            if eval.allowed {
                flags |= FLAG_CORS_ALLOWED;
            }

            if eval.preflight {
                return Ok(if eval.allowed {
                    let hv = compute_header_variant(true, true, rate_active, false, false);
                    terminal::terminal_preflight_ok(flags, hv, out)
                } else {
                    let hv = compute_header_variant(false, false, rate_active, false, true);
                    terminal::terminal_preflight_forbidden(flags, hv, out)
                });
            }
        }

        // Rate limiting
        let mut rate_limit: u32 = 0;
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;

        if rate_active {
            let limiter = inner.rate_limiter.as_ref().unwrap();
            let now = crate::core::runtime::NativeRuntime::now_ms();
            let key = resolved_ip.rate_key(limiter.seed());
            let outcome = limiter.check_key(key, now);

            rate_limit = limiter.limit();
            rate_remaining = outcome.remaining;
            rate_reset_ms = outcome.reset_ms;

            if !outcome.allowed {
                flags |= FLAG_RATE_LIMITED;
                let retry_after_ms = outcome.reset_ms.saturating_sub(now);
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, true, true, true);
                return Ok(terminal::terminal_rate_limited(
                    flags, hv, rate_limit, rate_remaining, rate_reset_ms, retry_after_ms, out,
                ));
            }
        }

        // Body size guard
        if config.guard_enabled && body_bytes.len() > config.max_body_bytes {
            let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
            let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
            return Ok(terminal::terminal_body_too_large(
                flags, hv, rate_limit, rate_remaining, rate_reset_ms, out,
            ));
        }

        // JSON body validation & schema
        let has_body = !body_bytes.is_empty();
        let enforce_json = if inner.schema.is_some() {
            mk.may_have_body() || has_body
        } else {
            config.require_json_body && (mk.may_have_body() || has_body)
        };

        if enforce_json {
            if body_bytes.is_empty() {
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                return Ok(terminal::terminal_invalid_json(
                    flags, hv, rate_limit, rate_remaining, rate_reset_ms, out,
                ));
            }

            let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                Ok(d) => d,
                Err(_) => {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return Ok(terminal::terminal_invalid_json(
                        flags, hv, rate_limit, rate_remaining, rate_reset_ms, out,
                    ));
                }
            };

            flags |= FLAG_BODY_VALID_JSON;

            if let Some(validator) = inner.schema.as_ref() {
                if validator.is_valid(&doc) {
                    flags |= FLAG_SCHEMA_VALID;
                } else {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return Ok(terminal::terminal_schema_validation(
                        flags, hv, rate_limit, rate_remaining, rate_reset_ms, out,
                    ));
                }
            }
        }

        // Parse cookies into output
        let mut data_pos = OUT_DATA_START;
        let cookies_json_len = parse_cookies_to_output(headers, config, out, &mut data_pos, &mut flags)?;
        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        // Parse query into output
        let query_json_len = parse_query_to_output(url_bytes, config, out, &mut data_pos, &mut flags)?;
        let query_start = data_pos;
        data_pos += query_json_len as usize;

        // Optional metadata JSON
        let body_json_len = if config.emit_metadata_json {
            let path = proxy::extract_path(url_bytes);
            crate::core::json_ser::write_full_body_json(
                out, data_pos, rid_bytes, path,
                cookies_start, cookies_json_len as usize,
                query_start, query_json_len as usize,
            )
        } else {
            0
        };

        if config.emit_metadata_json && body_json_len == 0 {
            flags |= FLAG_BODY_TRUNCATED;
        }

        // Final output
        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        Ok(write_output_header(
            out, 0, output::ERR_CODE_NONE, 200, flags,
            rate_limit, rate_remaining, rate_reset_ms, 0,
            cookies_json_len, query_json_len, hv, body_json_len as u32,
        ))
    }
}

// ── Helper functions ──────────────────────────────────────────────

#[inline]
fn read_section<'a>(input: &'a [u8], pos: &mut usize, max: usize) -> CoreResult<&'a [u8]> {
    let len = read_u32_at(input, *pos)?;
    *pos += 4;

    if len > max {
        return Err(limit_exceeded("section", max, len));
    }

    let end = pos
        .checked_add(len)
        .ok_or_else(|| overflow("section length"))?;

    if end > input.len() {
        return Err(malformed_data("truncated section", *pos));
    }

    let slice = &input[*pos..end];
    *pos = end;
    Ok(slice)
}

#[inline]
fn read_u32_at(input: &[u8], pos: usize) -> CoreResult<usize> {
    if pos + 4 > input.len() {
        return Err(malformed_data("truncated u32", pos));
    }
    Ok(u32::from_le_bytes([
        input[pos], input[pos + 1], input[pos + 2], input[pos + 3],
    ]) as usize)
}

fn parse_cookies_to_output(
    headers: HeaderRefs,
    config: &IngressConfig,
    out: &mut [u8],
    data_pos: &mut usize,
    flags: &mut u32,
) -> CoreResult<u32> {
    if !config.parse_cookies || !headers.has_cookie() {
        return Ok(0);
    }

    let cookie_val = match headers.cookie() {
        Some(v) => v,
        None => return Ok(0),
    };

    if cookie_val.len() > config.max_cookie_bytes {
        return Ok(0);
    }

    match crate::core::json_ser::cookie_json_into_slice(
        cookie_val,
        &mut out[*data_pos..],
        config.max_pairs,
    ) {
        Ok(written) => {
            if written > 2 {
                *flags |= output::FLAG_HAS_COOKIES;
            }
            Ok(written as u32)
        }
        Err(_) => Ok(0),
    }
}

fn parse_query_to_output(
    url_bytes: &[u8],
    config: &IngressConfig,
    out: &mut [u8],
    data_pos: &mut usize,
    flags: &mut u32,
) -> CoreResult<u32> {
    if !config.parse_query {
        return Ok(0);
    }

    let raw_query = proxy::extract_query(url_bytes);
    if raw_query.len() > config.max_query_bytes {
        return Err(limit_exceeded("query bytes", config.max_query_bytes, raw_query.len()));
    }

    if raw_query.is_empty() || *data_pos >= out.len() {
        return Ok(0);
    }

    let packed = crate::core::query_parser::query_parse_packed_vec(raw_query);
    if packed.len() <= 4 && u32::from_le_bytes([packed[0], packed[1], packed[2], packed[3]]) == 0 {
        return Ok(0);
    }

    match crate::core::json_ser::packed_pairs_to_json_into_slice(
        &packed,
        &mut out[*data_pos..],
        config.max_pairs,
    ) {
        Ok(written) => {
            if written > 2 {
                *flags |= output::FLAG_HAS_QUERY;
            }
            Ok(written as u32)
        }
        Err(_) => Ok(0),
    }
}
