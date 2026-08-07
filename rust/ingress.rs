use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::sync::Arc;

use crate::headers::HeaderRefs;
use crate::method::MethodKind;
use crate::output::{
    compute_header_variant, HeaderFields, RateInfo, FLAG_BODY_TRUNCATED, FLAG_BODY_VALID_JSON,
    FLAG_CORS_ALLOWED, FLAG_HAS_COOKIES, FLAG_HAS_QUERY, FLAG_HTTPS, FLAG_IS_PREFLIGHT,
    FLAG_RATE_LIMITED, FLAG_SCHEMA_VALID, FLAG_TRUSTED_PROXY, OUT_DATA_START,
};
use crate::rate_limit::RateLimiterState;
use crate::terminal::{
    terminal_body_too_large, terminal_invalid_json, terminal_preflight_forbidden,
    terminal_preflight_ok, terminal_rate_limited, terminal_schema_validation, terminal_simple,
};

// ── Ingress submodules (task-focused split of the former single-file module) ──
//   - options: JS-facing option structs + Limits
//   - time:    monotonic/wall-clock helpers
//   - packed:  packed-input readers + builder
pub(crate) mod options;
pub(crate) mod time;
pub(crate) mod packed;

use self::options::{IngressOptions, Limits};
use self::packed::{build_packed_input_sync, read_section};
use self::time::rate_now_ms;

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
    pub rate: RateLimiterState,
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

        let rate = if let Some(rl_opts) = options.rate_limit {
            let limit = rl_opts.limit.unwrap_or(0);
            let window_ms = rl_opts.window_ms.unwrap_or(1000);
            if limit == 0 || limit == u32::MAX {
                RateLimiterState::Disabled
            } else {
                let max_entries = rl_opts.max_entries.map(|v| v as usize);
                // Shared per-configuration across the process: prevents a client
                // from bypassing a per-IP limit by spreading requests across routes.
                RateLimiterState::Enabled(crate::rate_limit::shared_limiter(
                    limit,
                    window_ms,
                    max_entries,
                ))
            }
        } else {
            RateLimiterState::Disabled
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
                rate,
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
    ///
    /// Allocating variant: allocates a fresh output buffer per call. Hot paths
    /// should prefer [`Self::handle_request_full_sync_into`], which reuses a
    /// caller-provided (pooled) output buffer.
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
        let output_size =
            output_buffer_size.unwrap_or(262_144).max(OUT_DATA_START as u32) as usize;

        // The fresh `out` vec cannot alias `body` (a distinct JS buffer), so it
        // is safe to borrow the body without copying.
        let body_bytes: &[u8] = match &body {
            Some(b) => b.as_ref(),
            None => &[],
        };

        let mut out = vec![0u8; output_size];
        let written = self.full_sync_into(
            method_kind,
            &url,
            &ip,
            &request_id,
            headers,
            body_bytes,
            &mut out,
        )?;
        out.truncate(written);
        Ok(Uint8Array::new(out))
    }

    /// Reusable-output variant of [`Self::handle_request_full_sync`]: packs raw
    /// request components in Rust, runs the pipeline, and writes the packed
    /// decision into the caller-provided `output` buffer, returning the number
    /// of bytes written.
    ///
    /// The caller is expected to pool the output buffer across requests (see
    /// `src/shared/buffer-pool.ts`) to eliminate per-request allocation. The
    /// body is zero-copied unless it aliases `output` (guarded by
    /// `crate::util::slices_overlap`).
    #[napi(ts_args_type = "methodKind: number, url: string, ip: string, requestId: string, headers: Array<[string, string]>, body: Uint8Array | null, output: Uint8Array")]
    pub fn handle_request_full_sync_into(
        &self,
        method_kind: u32,
        url: String,
        ip: String,
        request_id: String,
        headers: Vec<Vec<String>>,
        body: Option<Uint8Array>,
        mut output: Uint8Array,
    ) -> Result<u32> {
        let body_bytes: &[u8] = match &body {
            Some(b) => b.as_ref(),
            None => &[],
        };

        // Check overlap before taking the mutable slice (can't alias output
        // mutably and immutably at the same time).
        let overlaps = crate::util::slices_overlap(body_bytes, output.as_ref());

        if overlaps {
            // The caller aliased body with output: fall back to an owned copy.
            let owned = body_bytes.to_vec();
            // SAFETY: `output` is a caller-provided buffer we write into and
            // `full_sync_into` does not retain the slice beyond the call. This
            // mirrors the existing `crate::util::run_packed_into` pattern.
            let out: &mut [u8] = unsafe { output.as_mut() };
            let written =
                self.full_sync_into(method_kind, &url, &ip, &request_id, headers, &owned, out)?;
            return Ok(written as u32);
        }

        // SAFETY: see above — the caller-provided buffer is only borrowed for
        // the duration of the call.
        let out: &mut [u8] = unsafe { output.as_mut() };
        let written = self.full_sync_into(
            method_kind,
            &url,
            &ip,
            &request_id,
            headers,
            body_bytes,
            out,
        )?;
        Ok(written as u32)
    }

    /// Shared core for the full_sync family: packs raw request components in
    /// Rust and runs the ingress pipeline, writing into `out` (which must be at
    /// least `OUT_DATA_START` bytes). Returns the number of bytes written.
    ///
    /// `body` is borrowed; callers must guarantee it does not alias `out` (the
    /// into-variant checks overlap before calling).
    fn full_sync_into(
        &self,
        method_kind: u32,
        url: &str,
        ip: &str,
        request_id: &str,
        headers: Vec<Vec<String>>,
        body: &[u8],
        out: &mut [u8],
    ) -> Result<usize> {
        let inner: &IngressInner = self.inner.as_ref();

        // Consume the napi-marshaled header strings by moving the last two
        // elements out of each Vec — avoids a second allocation per header
        // name/value (napi already allocated the owned Strings).
        let header_pairs: Vec<(String, String)> = headers
            .into_iter()
            .filter_map(|mut h| {
                if h.len() < 2 {
                    return None;
                }
                let value = h.pop().unwrap_or_default();
                let name = h.pop().unwrap_or_default();
                Some((name, value))
            })
            .collect();

        let packed = build_packed_input_sync(
            method_kind as u8,
            url.as_bytes(),
            ip.as_bytes(),
            request_id.as_bytes(),
            &header_pairs,
        );

        inner.handle_packed(&packed, body, out)
    }
}

impl IngressInner {
    /// Process one request.
    ///
    /// - `input`: packed metadata frame (method byte + url/ip/rid/headers sections)
    /// - `body_bytes`: the request body (empty when there is none)
    /// - `out`: receives the packed decision header followed by JSON payloads
    pub(crate) fn handle_packed(
        &self,
        input: &[u8],
        body_bytes: &[u8],
        out: &mut [u8],
    ) -> Result<usize> {
        if out.len() < OUT_DATA_START {
            return Err(Error::new(Status::InvalidArg, "output buffer too small"));
        }
        if input.is_empty() {
            return Err(Error::new(Status::InvalidArg, "input buffer too small"));
        }

        // ── 1. Parse the packed input frame ─────────────────────────
        let mut pos = 1usize;
        let mk = MethodKind::from_u8(input[0]);
        let is_options = mk == MethodKind::Options;

        let url_bytes = match read_section(input, &mut pos, self.limits.max_url_bytes) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, crate::output::ERR_CODE_BAD_REQUEST, 414),
        };
        let ip_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, crate::output::ERR_CODE_BAD_REQUEST, 400),
        };
        let rid_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, crate::output::ERR_CODE_BAD_REQUEST, 400),
        };
        let headers_packed = match read_section(input, &mut pos, self.limits.max_headers_bytes) {
            Ok(v) => v,
            Err(_) => {
                return terminal_simple(out, crate::output::ERR_CODE_REQUEST_TOO_LARGE, 431)
            }
        };
        let headers = match HeaderRefs::parse(headers_packed, is_options, self.limits.max_headers) {
            Ok(v) => v,
            Err(_) => {
                return terminal_simple(out, crate::output::ERR_CODE_REQUEST_TOO_LARGE, 431)
            }
        };

        // ── 2. Trust, client IP, and HTTPS ──────────────────────────
        let mut flags: u32 = 0;
        let rate_active = self.rate.as_limiter().is_some();

        let (resolved_ip, peer_trusted) = crate::ip_trust::resolve_client_ip(
            &self.proxy_trust,
            ip_bytes,
            headers.xff(),
            headers.x_real_ip(),
        );

        if peer_trusted {
            flags |= FLAG_TRUSTED_PROXY;
        }

        if crate::proxy::detect_https(self.https_fixed, &self.proxy_trust, url_bytes, &headers, peer_trusted)
        {
            flags |= FLAG_HTTPS;
        }

        // ── 3. CORS (may terminate on a preflight request) ─────────
        if self.cors_enabled && headers.has_origin() {
            let eval = self.cors.evaluate(mk, &headers);

            if eval.preflight {
                flags |= FLAG_IS_PREFLIGHT;
            }
            if eval.allowed {
                flags |= FLAG_CORS_ALLOWED;
            }

            if eval.preflight {
                let hv = if eval.allowed {
                    compute_header_variant(true, true, rate_active, false, false)
                } else {
                    compute_header_variant(false, false, rate_active, false, true)
                };
                return if eval.allowed {
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    terminal_preflight_forbidden(flags, hv, out)
                };
            }
        }

        // The header variant for every non-preflight JSON response.
        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let success_hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        // ── 4. Rate limiting (may terminate with 429) ──────────────
        let mut rate = RateInfo::default();
        if let Some(limiter) = self.rate.as_limiter() {
            let now = rate_now_ms();
            let outcome = limiter.check_key(resolved_ip.rate_key(limiter.seed()), now);

            rate.limit = limiter.limit();
            rate.remaining = outcome.remaining;
            rate.reset_ms = outcome.reset_ms;

            if !outcome.allowed {
                flags |= FLAG_RATE_LIMITED;
                rate.retry_after_ms = outcome.reset_ms.saturating_sub(now);
                let hv = compute_header_variant(cors_ok, false, true, true, true);
                return terminal_rate_limited(flags, hv, rate, out);
            }
        }

        // ── 5. Body size guard (may terminate with 413) ────────────
        if self.guard_enabled && body_bytes.len() > self.max_body_bytes {
            return terminal_body_too_large(flags, success_hv, rate, out);
        }

        // ── 6. JSON body validation & schema (400 / 422) ───────────
        let has_body = !body_bytes.is_empty();
        let enforce_json = if self.schema.is_some() {
            mk.may_have_body() || has_body
        } else {
            self.require_json_body && (mk.may_have_body() || has_body)
        };

        if enforce_json {
            if body_bytes.is_empty() {
                return terminal_invalid_json(flags, success_hv, rate, out);
            }

            if let Some(validator) = self.schema.as_ref() {
                // Schema path: build the DOM (jsonschema validates a Value).
                let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                    Ok(d) => d,
                    Err(_) => return terminal_invalid_json(flags, success_hv, rate, out),
                };

                flags |= FLAG_BODY_VALID_JSON;

                if !validator.is_valid(&doc) {
                    return terminal_schema_validation(flags, success_hv, rate, out);
                }
            } else {
                // No schema configured (the common case): validate WITHOUT
                // building a serde_json::Value DOM that would be thrown away
                // immediately. `json_valid_bytes` skips values via IgnoredAny
                // (SIMD-validated, zero DOM allocation) — identical "is valid
                // JSON" semantics at a fraction of the per-request cost.
                if !crate::json_ops::json_valid_bytes(body_bytes) {
                    return terminal_invalid_json(flags, success_hv, rate, out);
                }
                flags |= FLAG_BODY_VALID_JSON;
            }
            // With no schema configured, validation trivially passes. Setting
            // the flag here keeps `schemaValid` meaning "schema passed" for
            // consumers that gate on it (e.g. handlers.ts jsonWriteHandler)
            // regardless of whether a schema is configured.
            flags |= FLAG_SCHEMA_VALID;
        }

        // ── 7. Serialize cookies / query / metadata into the output ─
        if self.parse_query {
            let raw_query = crate::proxy::extract_query(url_bytes);
            if raw_query.len() > self.limits.max_query_bytes {
                return terminal_simple(out, crate::output::ERR_CODE_BAD_REQUEST, 414);
            }
        }

        let sections = match self.write_body_sections(url_bytes, rid_bytes, &headers, out) {
            Ok(s) => s,
            Err(_) => return terminal_simple(out, crate::output::ERR_CODE_BAD_REQUEST, 400),
        };

        if sections.cookies_json_len > 2 {
            flags |= FLAG_HAS_COOKIES;
        }
        if sections.query_json_len > 2 {
            flags |= FLAG_HAS_QUERY;
        }
        if sections.truncated || (self.emit_metadata_json && sections.body_json_len == 0) {
            flags |= FLAG_BODY_TRUNCATED;
        }

        // ── 8. Write the output header ──────────────────────────────
        Ok(HeaderFields::ok(
            flags,
            rate,
            sections.cookies_json_len,
            sections.query_json_len,
            success_hv,
            sections.body_json_len as u32,
        )
        .write(out))
    }

    /// Serialize cookies→JSON and query→JSON (plus the optional metadata
    /// envelope) into the output buffer. Returns each section's length and
    /// whether any output had to be truncated.
    ///
    /// Errors only when the query string is malformed (mapped to a 400 by the
    /// caller); a too-small output buffer is surfaced via `truncated` so the
    /// consumer never mistakes truncated data for complete data.
    fn write_body_sections(
        &self,
        url_bytes: &[u8],
        rid_bytes: &[u8],
        headers: &HeaderRefs<'_>,
        out: &mut [u8],
    ) -> Result<BodySections> {
        let mut data_pos = OUT_DATA_START;
        let mut truncated = false;

        // ── Cookies → JSON ──
        let cookies_json_len: u32 = if self.parse_cookies {
            match headers.cookie() {
                Some(cookie) if cookie.len() <= self.limits.max_cookie_bytes => {
                    match crate::json_ser::cookie_json_into_slice(
                        cookie,
                        &mut out[data_pos..],
                        self.limits.max_pairs,
                    ) {
                        Ok(written) => written as u32,
                        Err(_) => {
                            truncated = true;
                            0
                        }
                    }
                }
                _ => 0,
            }
        } else {
            0
        };
        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        // ── Query → JSON ──
        let query_json_len: u32 = if self.parse_query {
            let raw_query = crate::proxy::extract_query(url_bytes);
            if !raw_query.is_empty() && data_pos < out.len() {
                match crate::query_parser::query_parse_packed_vec(raw_query) {
                    Ok(packed) => {
                        match crate::json_ser::packed_pairs_to_json_into_slice(
                            &packed,
                            &mut out[data_pos..],
                            self.limits.max_pairs,
                        ) {
                            Ok(written) => written as u32,
                            Err(_) => {
                                truncated = true;
                                0
                            }
                        }
                    }
                    Err(_) => return Err(Error::from_reason("query parse failed")),
                }
            } else {
                0
            }
        } else {
            0
        };
        let query_start = data_pos;
        data_pos += query_json_len as usize;

        // ── Optional metadata envelope ──
        let body_json_len = if self.emit_metadata_json {
            crate::json_ser::write_full_body_json(
                out,
                data_pos,
                rid_bytes,
                crate::proxy::extract_path(url_bytes),
                cookies_start,
                cookies_json_len as usize,
                query_start,
                query_json_len as usize,
            )
        } else {
            0
        };

        Ok(BodySections {
            cookies_json_len,
            query_json_len,
            body_json_len,
            truncated,
        })
    }
}

/// Result of serializing cookies/query/metadata into the output buffer.
struct BodySections {
    cookies_json_len: u32,
    query_json_len: u32,
    body_json_len: usize,
    truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{
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
            proxy_trust: crate::ip_trust::ProxyTrustMode::None,
            parse_cookies: false,
            parse_query: false,
            require_json_body: false,
            guard_enabled: true,
            emit_metadata_json: false,
            cors_enabled: false,
            cors: crate::cors::CorsEngine::disabled(),
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
}
