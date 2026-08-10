use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::sync::Arc;

use crate::ingress::output::OUT_DATA_START;
use crate::ingress::rate_limit::RateLimiterState;

// ── Ingress submodules (task-focused split of the former single-file module) ──
//   - pipeline:    the core request pipeline — `IngressInner::handle_packed`
//                  + `write_body_sections` + `BodySections` (pipeline.rs)
//   - tests:       unit tests (tests.rs)
//   - options:     JS-facing option structs + Limits
//   - time:        monotonic/wall-clock helpers
//   - packed:      packed-input readers + builder
//   - cors, proxy, ip_trust, rate_limit, terminal, output, ingress_constants:
//     the ingress support modules (moved into this folder from the crate root).
mod pipeline;

#[cfg(test)]
mod tests;

pub(crate) mod options;
pub(crate) mod time;
pub(crate) mod packed;

pub(crate) mod cors;
pub(crate) mod ip_trust;
pub(crate) mod output;
pub(crate) mod proxy;
pub(crate) mod rate_limit;
pub(crate) mod terminal;
pub mod ingress_constants;

use self::options::{IngressOptions, Limits};
use self::packed::build_packed_input_sync;
use self::pipeline::IngressSchema;

// ── Ingress state ─────────────────────────────────────────────────
#[derive(Clone)]
pub(crate) struct IngressInner {
    pub https_fixed: Option<bool>,
    pub max_body_bytes: usize,
    pub proxy_trust: crate::ingress::ip_trust::ProxyTrustMode,
    pub parse_cookies: bool,
    pub parse_query: bool,
    pub require_json_body: bool,
    pub guard_enabled: bool,
    pub emit_metadata_json: bool,
    pub cors_enabled: bool,
    pub cors: crate::ingress::cors::CorsEngine,
    pub rate: RateLimiterState,
    pub schema: Option<Arc<IngressSchema>>,
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
            crate::ingress::ip_trust::ProxyTrustMode::from_config(tp.enabled.unwrap_or(false), tp.networks)?
        } else if options.trust_proxy.unwrap_or(false) {
            crate::ingress::ip_trust::ProxyTrustMode::All
        } else {
            crate::ingress::ip_trust::ProxyTrustMode::None
        };

        let schema = if let Some(schema_bytes) = options.schema {
            let schema_str = std::str::from_utf8(&schema_bytes)
                .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in schema"))?;
            let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;
            // Compile BOTH the authoritative jsonschema validator and the
            // zero-DOM fast path once at construction — no per-request schema
            // work (see IngressSchema in pipeline.rs).
            let compiled = IngressSchema::compile(&schema_value)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema compile error: {}", e)))?;
            Some(Arc::new(compiled))
        } else {
            None
        };

        let cors_enabled = options.cors.is_some();
        let cors = crate::ingress::cors::CorsEngine::from_options(options.cors)?;

        let rate = if let Some(rl_opts) = options.rate_limit {
            let limit = rl_opts.limit.unwrap_or(0);
            let window_ms = rl_opts.window_ms.unwrap_or(1000);
            if limit == 0 || limit == u32::MAX {
                RateLimiterState::Disabled
            } else {
                let max_entries = rl_opts.max_entries.map(|v| v as usize);
                // Shared per-configuration across the process: prevents a client
                // from bypassing a per-IP limit by spreading requests across routes.
                RateLimiterState::Enabled(crate::ingress::rate_limit::shared_limiter(
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

