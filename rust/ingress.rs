#![allow(clippy::too_many_arguments)]

use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::cors::CorsOptions;
use crate::headers::HeaderRefs;
use crate::method::MethodKind;
use crate::output::{
    compute_header_variant, write_output_header, FLAG_BODY_TRUNCATED,
    FLAG_BODY_VALID_JSON, FLAG_CORS_ALLOWED, FLAG_HTTPS, FLAG_IS_PREFLIGHT,
    FLAG_RATE_LIMITED, FLAG_SCHEMA_VALID, FLAG_TRUSTED_PROXY, OUT_DATA_START,
};
use crate::terminal::{
    terminal_body_too_large, terminal_invalid_json, terminal_preflight_forbidden,
    terminal_preflight_ok, terminal_rate_limited, terminal_schema_validation,
    terminal_simple,
};

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

// ── Time helpers ──────────────────────────────────────────────────
static START: OnceLock<Instant> = OnceLock::new();
static WALL_OFFSET_MS: OnceLock<i128> = OnceLock::new();

#[inline(always)]
fn monotonic_ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

#[inline(always)]
fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[inline(always)]
fn wall_offset_ms() -> i128 {
    *WALL_OFFSET_MS.get_or_init(|| wall_now_ms() as i128 - monotonic_ms() as i128)
}

#[inline(always)]
fn rate_now_ms() -> u64 {
    let v = monotonic_ms() as i128 + wall_offset_ms();
    if v < 0 { 0 } else { v as u64 }
}

// ── Packed input helpers (extracted from old ingress.rs) ──────────
#[inline]
fn read_u32_at(input: &[u8], pos: &mut usize) -> Result<usize> {
    if *pos + 4 > input.len() {
        return Err(Error::from_reason("packed input: truncated u32"));
    }
    let v = u32::from_le_bytes([
        input[*pos], input[*pos + 1], input[*pos + 2], input[*pos + 3],
    ]) as usize;
    *pos += 4;
    Ok(v)
}

#[inline]
fn read_section<'a>(input: &'a [u8], pos: &mut usize, max: usize) -> Result<&'a [u8]> {
    let len = read_u32_at(input, pos)?;
    if len > max {
        return Err(Error::from_reason("packed input: section too large"));
    }
    let end = pos
        .checked_add(len)
        .ok_or_else(|| Error::from_reason("packed input: length overflow"))?;
    if end > input.len() {
        return Err(Error::from_reason("packed input: truncated section"));
    }
    let slice = &input[*pos..end];
    *pos = end;
    Ok(slice)
}

// ── Ingress state ─────────────────────────────────────────────────
#[derive(Clone)]
pub(crate) struct IngressInner {
    pub https_fixed: Option<bool>,
    pub max_body_bytes: usize,
    pub proxy_trust: crate::ip_trust::ProxyTrustMode,
    pub parse_cookies: bool,
    pub parse_query: bool,
    pub require_json_body: bool,
    pub guard_enabled: bool,
    pub emit_metadata_json: bool,
    pub cors_enabled: bool,
    pub cors: crate::cors::CorsEngine,
    pub rate_enabled: bool,
    pub rate_limiter: Option<Arc<crate::rate_limit::KeyedRateLimiter>>,
    pub schema: Option<Arc<jsonschema::Validator>>,
    pub limits: Limits,
}

#[napi]
pub struct Ingress {
    inner: Arc<IngressInner>,
}

#[napi]
impl Ingress {
    #[napi(constructor)]
    pub fn new(options: IngressOptions) -> Result<Self> {
        let parse_cookies = options.parse_cookies.unwrap_or(false);
        let parse_query = options.parse_query.unwrap_or(false);
        let require_json_body = options.require_json_body.unwrap_or(false);
        let max_body_bytes = options.max_body_bytes.unwrap_or(1_048_576) as usize;
        let guard_enabled = options.enable_body_size_guard.unwrap_or(true);
        let emit_metadata_json = options.emit_metadata_json.unwrap_or(false);

        let proxy_trust = if let Some(tp) = options.trusted_proxies {
            crate::ip_trust::ProxyTrustMode::from_config(tp.enabled.unwrap_or(false), tp.networks)?
        } else if options.trust_proxy.unwrap_or(false) {
            crate::ip_trust::ProxyTrustMode::All
        } else {
            crate::ip_trust::ProxyTrustMode::None
        };

        let schema = if let Some(schema_bytes) = options.schema {
            let schema_str = std::str::from_utf8(&schema_bytes)
                .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in schema"))?;
            let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;
            let compiled = jsonschema::validator_for(&schema_value)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema compile error: {}", e)))?;
            Some(Arc::new(compiled))
        } else {
            None
        };

        let cors_enabled = options.cors.is_some();
        let cors = crate::cors::CorsEngine::from_options(options.cors)?;

        let (rate_enabled, rate_limiter) = if let Some(rl_opts) = options.rate_limit {
            let limit = rl_opts.limit.unwrap_or(0);
            let window_ms = rl_opts.window_ms.unwrap_or(1000);
            if limit == 0 || limit == u32::MAX {
                (false, None)
            } else {
                let max_entries = rl_opts.max_entries.map(|v| v as usize);
                // Shared per-configuration across the process: prevents a client
                // from bypassing a per-IP limit by spreading requests across routes.
                let limiter =
                    crate::rate_limit::shared_limiter(limit, window_ms, max_entries);
                (true, Some(limiter))
            }
        } else {
            (false, None)
        };

        let limits = Limits::from_options(options.limits);

        Ok(Self {
            inner: Arc::new(IngressInner {
                https_fixed: options.https,
                max_body_bytes,
                proxy_trust,
                parse_cookies,
                parse_query,
                require_json_body,
                guard_enabled,
                emit_metadata_json,
                cors_enabled,
                cors,
                rate_enabled,
                rate_limiter,
                schema,
                limits,
            }),
        })
    }

    /// Production API:
    ///   input = packed metadata frame
    ///   body = separate zero-copy body
    ///   output = response decision buffer
    #[napi(ts_args_type = "input: Uint8Array, body: Uint8Array | null, output: Uint8Array")]
    pub fn handle_request_packed(
        &self,
        input: Uint8Array,
        body: Option<Uint8Array>,
        mut output: Uint8Array,
    ) -> Result<u32> {
        let inner: &IngressInner = self.inner.as_ref();

        crate::util::run_packed_into(&input, &mut output, move |inp, out| {
            match body {
                Some(b) => {
                    let b_bytes = b.as_ref();
                    if crate::util::slices_overlap(b_bytes, out) {
                        let owned = b_bytes.to_vec();
                        inner.handle_packed(inp, &owned, out)
                    } else {
                        inner.handle_packed(inp, b_bytes, out)
                    }
                }
                None => inner.handle_packed(inp, &[], out),
            }
        })
    }

    /// Optimized sync API:
    /// Accepts raw JS values (no binary packing in JS), packs them in Rust,
    /// and processes them synchronously.
    /// This is the fastest path for simple requests.
    #[napi(ts_args_type = "methodKind: number, url: string, ip: string, requestId: string, headers: Array<[string, string]>, body: Uint8Array | null, outputBufferSize?: number")]
    pub fn handle_request_full_sync(
        &self,
        method_kind: u32,
        url: String,
        ip: String,
        request_id: String,
        headers: Vec<Vec<String>>,
        body: Option<Uint8Array>,
        output_buffer_size: Option<u32>,
    ) -> Result<Uint8Array> {
        let inner: &IngressInner = self.inner.as_ref();

        let url_bytes = url.into_bytes();
        let ip_bytes = ip.into_bytes();
        let rid_bytes = request_id.into_bytes();

        let header_pairs: Vec<(String, String)> = headers
            .into_iter()
            .filter_map(|h| {
                if h.len() >= 2 {
                    Some((h[0].clone(), h[1].clone()))
                } else {
                    None
                }
            })
            .collect();

        let body_bytes = body.map(|b| b.as_ref().to_vec()).unwrap_or_default();
        let output_size = output_buffer_size.unwrap_or(262_144).max(OUT_DATA_START as u32) as usize;

        // Build packed input in Rust — no JS-side encoder.encodeInto() needed
        let packed = build_packed_input_sync(method_kind as u8, &url_bytes, &ip_bytes, &rid_bytes, &header_pairs);

        let mut out = vec![0u8; output_size];
        let written = inner.handle_packed(&packed, &body_bytes, &mut out)?;
        out.truncate(written);
        Ok(Uint8Array::new(out))
    }
}

/// Build the full packed input buffer from raw components (sync version).
fn build_packed_input_sync(
    method_kind: u8,
    url_bytes: &[u8],
    ip_bytes: &[u8],
    rid_bytes: &[u8],
    headers: &[(String, String)],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);

    // Method kind (1 byte)
    buf.push(method_kind);

    // URL section: u32le length-prefixed
    buf.extend_from_slice(&(url_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(url_bytes);

    // IP section: u32le length-prefixed
    buf.extend_from_slice(&(ip_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(ip_bytes);

    // Request ID section: u32le length-prefixed
    buf.extend_from_slice(&(rid_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(rid_bytes);

    // Headers section: u32le length-prefixed
    let headers_len_pos = buf.len();
    buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder
    let headers_start = buf.len();

    // Write header count (u16le)
    buf.extend_from_slice(&(headers.len() as u16).to_le_bytes());

    for (name, value) in headers {
        let name_bytes = name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);
        let value_bytes = value.as_bytes();
        buf.extend_from_slice(&(value_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(value_bytes);
    }

    // Patch the header section length
    let headers_len = buf.len() - headers_start;
    buf[headers_len_pos..headers_len_pos + 4].copy_from_slice(&(headers_len as u32).to_le_bytes());

    buf
}

impl IngressInner {
    pub(crate) fn handle_packed(&self, input: &[u8], body_bytes: &[u8], out: &mut [u8]) -> Result<usize> {
        if out.len() < OUT_DATA_START {
            return Err(Error::new(Status::InvalidArg, "output buffer too small"));
        }
        if input.is_empty() {
            return Err(Error::new(Status::InvalidArg, "input buffer too small"));
        }

        // ── Parse packed input ──────────────────────────────────────
        let mut pos = 1usize;
        let mk = MethodKind::from_u8(input[0]);
        let is_options = mk == MethodKind::Options;

        let url_bytes = match read_section(input, &mut pos, self.limits.max_url_bytes) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_BAD_REQUEST, 414),
        };

        let ip_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_BAD_REQUEST, 400),
        };

        let rid_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_BAD_REQUEST, 400),
        };

        let headers_packed = match read_section(input, &mut pos, self.limits.max_headers_bytes) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_REQUEST_TOO_LARGE, 431),
        };

        let headers = match HeaderRefs::parse(headers_packed, is_options, self.limits.max_headers) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_REQUEST_TOO_LARGE, 431),
        };

        // ── Flags & rate limiting prep ────────────────────────────
        let mut flags: u32 = 0;
        let rate_active = self.rate_enabled && self.rate_limiter.is_some();

        let (resolved_ip, peer_trusted) =
            crate::ip_trust::resolve_client_ip(&self.proxy_trust, ip_bytes, headers.xff(), headers.x_real_ip());

        if peer_trusted {
            flags |= FLAG_TRUSTED_PROXY;
        }

        if crate::proxy::detect_https(self.https_fixed, &self.proxy_trust, url_bytes, &headers, peer_trusted) {
            flags |= FLAG_HTTPS;
        }

        // ── CORS evaluation ─────────────────────────────────────────
        if self.cors_enabled && headers.has_origin() {
            let eval = self.cors.evaluate(mk, &headers);

            if eval.preflight {
                flags |= FLAG_IS_PREFLIGHT;
            }
            if eval.allowed {
                flags |= FLAG_CORS_ALLOWED;
            }

            if eval.preflight {
                return if eval.allowed {
                    let hv = compute_header_variant(true, true, rate_active, false, false);
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    let hv = compute_header_variant(false, false, rate_active, false, true);
                    terminal_preflight_forbidden(flags, hv, out)
                };
            }
        }

        // ── Rate limiting ────────────────────────────────────────────
        let mut rate_limit: u32 = 0;
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;

        if rate_active {
            let limiter = self.rate_limiter.as_ref().unwrap();
            let now = rate_now_ms();
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
                return terminal_rate_limited(flags, hv, rate_limit, rate_remaining, rate_reset_ms, retry_after_ms, out);
            }
        }

        // ── Body size guard ──────────────────────────────────────────
        if self.guard_enabled && body_bytes.len() > self.max_body_bytes {
            let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
            let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
            return terminal_body_too_large(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
        }

        // ── JSON body validation & schema ────────────────────────────
        let has_body = !body_bytes.is_empty();

        let enforce_json = if self.schema.is_some() {
            mk.may_have_body() || has_body
        } else {
            self.require_json_body && (mk.may_have_body() || has_body)
        };

        if enforce_json {
            if body_bytes.is_empty() {
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
            }

            let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                Ok(d) => d,
                Err(_) => {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                }
            };

            flags |= FLAG_BODY_VALID_JSON;

            if let Some(validator) = self.schema.as_ref() {
                if validator.is_valid(&doc) {
                    flags |= FLAG_SCHEMA_VALID;
                } else {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_schema_validation(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                }
            }
        }

        // ── Parse cookies into output ────────────────────────────────
        let mut data_pos = OUT_DATA_START;
        let mut truncated = false;

        let cookies_json_len: u32 = if self.parse_cookies && headers.has_cookie() {
            if let Some(cookie_val) = headers.cookie() {
                if cookie_val.len() <= self.limits.max_cookie_bytes {
                    match crate::json_ser::cookie_json_into_slice(
                        cookie_val,
                        &mut out[data_pos..],
                        self.limits.max_pairs,
                    ) {
                        Ok(written) => {
                            if written > 2 { flags |= crate::output::FLAG_HAS_COOKIES; }
                            written as u32
                        }
                        Err(_) => {
                            // Output buffer too small: never drop silently.
                            truncated = true;
                            0
                        }
                    }
                } else { 0 }
            } else { 0 }
        } else { 0 };

        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        // ── Parse query into output ──────────────────────────────────
        let query_json_len: u32 = if self.parse_query {
            let raw_query = crate::proxy::extract_query(url_bytes);
            if raw_query.len() > self.limits.max_query_bytes {
                return terminal_simple(out, 1, crate::output::ERR_CODE_BAD_REQUEST, 414);
            }
            if !raw_query.is_empty() && data_pos < out.len() {
                match crate::query_parser::query_parse_packed_vec(raw_query) {
                    Ok(packed) => {
                        match crate::json_ser::packed_pairs_to_json_into_slice(
                            &packed,
                            &mut out[data_pos..],
                            self.limits.max_pairs,
                        ) {
                            Ok(written) => {
                                if written > 2 { flags |= crate::output::FLAG_HAS_QUERY; }
                                written as u32
                            }
                            Err(_) => {
                                // Output buffer too small: never drop silently.
                                truncated = true;
                                0
                            }
                        }
                    }
                    Err(_) => return terminal_simple(out, 1, crate::output::ERR_CODE_BAD_REQUEST, 400),
                }
            } else { 0 }
        } else { 0 };

        let query_start = data_pos;
        data_pos += query_json_len as usize;

        // ── Optional metadata JSON ───────────────────────────────────
        let body_json_len = if self.emit_metadata_json {
            let path = crate::proxy::extract_path(url_bytes);
            crate::json_ser::write_full_body_json(
                out, data_pos, rid_bytes, path,
                cookies_start, cookies_json_len as usize,
                query_start, query_json_len as usize,
            )
        } else { 0 };

        // Any serialization shortfall (cookie/query envelope overflow or the
        // metadata envelope) is surfaced via FLAG_BODY_TRUNCATED so the consumer
        // never mistakes truncated data for complete data.
        if truncated || (self.emit_metadata_json && body_json_len == 0) {
            flags |= FLAG_BODY_TRUNCATED;
        }

        // ── Final output ─────────────────────────────────────────────
        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        Ok(write_output_header(
            out, 0, crate::output::ERR_CODE_NONE, 200, flags,
            rate_limit, rate_remaining, rate_reset_ms, 0,
            cookies_json_len, query_json_len, hv, body_json_len as u32,
        ))
    }
}