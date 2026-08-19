//! The ingress HTTP pipeline (napi boundary): the `Ingress` class + entry
//! points (`handle_request_packed`, `handle_request_full_sync{,_into}`). The
//! core pipeline logic lives in the pure-Rust `pipeline` submodule; see
//! `docs/INGRESS.md` and `docs/REPO_MAP.md` for the two JS-side paths.

use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::sync::Arc;

use crate::ingress::output::{MAX_OUTPUT_BUFFER_SIZE, OUT_DATA_START};
use crate::ingress::rate_limit::RateLimiterState;

/// Clamp an ingress output-buffer size into `[OUT_DATA_START, MAX_OUTPUT_BUFFER_SIZE]`
/// so a misconfigured (huge/negative) `outputBufferSize` can never trigger a
/// multi-GB native allocation (OOM) in the allocating full_sync entry.
fn clamp_output_size(output_buffer_size: Option<u32>) -> usize {
    output_buffer_size
        .unwrap_or(262_144)
        .clamp(OUT_DATA_START as u32, MAX_OUTPUT_BUFFER_SIZE) as usize
}

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
pub(crate) mod packed;
pub(crate) mod time;

pub(crate) mod cors;
pub mod ingress_constants;
pub(crate) mod ip_trust;
// Per-route native stack (`castrum_route_*` C-ABI + napi `Route` class) —
// the LIVE external wire consumed by `@ignex/native` (route-wire.ts v3).
// Supersedes the deleted `rust/route.rs` (dead external-project wire); see
// the module doc for the contract and the lenient-parse parity rules.
pub mod native_route;
pub(crate) mod output;
pub(crate) mod proxy;
pub(crate) mod rate_limit;
pub(crate) mod terminal;

pub(crate) use self::native_route::NativeRoute;
pub(crate) use self::options::{IngressOptions, Limits};
pub(crate) use self::packed::build_packed_input_sync;
pub(crate) use self::pipeline::IngressSchema;

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
        let max_body_bytes = options
            .max_body_bytes
            .unwrap_or(crate::ingress::options::DEFAULT_MAX_BODY_BYTES as u32)
            as usize;
        let guard_enabled = options.enable_body_size_guard.unwrap_or(true);
        let emit_metadata_json = options.emit_metadata_json.unwrap_or(false);

        let proxy_trust = if let Some(tp) = options.trusted_proxies {
            crate::ingress::ip_trust::ProxyTrustMode::from_config(
                tp.enabled.unwrap_or(false),
                tp.networks,
            )
            .map_err(|e| Error::new(Status::InvalidArg, e))?
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
            let compiled = IngressSchema::compile(&schema_value).map_err(|e| {
                Error::new(Status::InvalidArg, format!("Schema compile error: {}", e))
            })?;
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
                RateLimiterState::Enabled(
                    crate::ingress::rate_limit::shared_limiter(limit, window_ms, max_entries)
                        .map_err(|e| Error::new(Status::InvalidArg, e))?,
                )
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

    /// Opaque handle to the inner pipeline state, for the `bun:ffi` C-ABI fast
    /// path (`castrum_ingress_handle_packed` in rust/ffi.rs).
    ///
    /// # Safety / lifetime
    /// The returned value is a raw pointer into the `Arc<IngressInner>` and is
    /// ONLY valid while THIS `Ingress` instance is alive (napi keeps the native
    /// state alive while the JS object is referenced; it is dropped on GC). It
    /// must be treated as an opaque handle — JS must never dereference it, and
    /// it must be discarded if the instance is dropped. The internal wrapper
    /// (`src/native/ffi.ts`) holds the instance for the lifetime of the ingress
    /// handler, so in practice the handle never outlives the state it points
    /// to. Exposed for the internal fast path only; not part of the public API.
    #[napi]
    pub fn ingress_inner_ptr(&self) -> u64 {
        self.inner.as_ref() as *const IngressInner as u64
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

        crate::util::run_packed_into(&input, &mut output, move |inp, out| match body {
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
    #[allow(clippy::too_many_arguments)]
    #[napi(
        ts_args_type = "methodKind: number, url: string, ip: string, requestId: string, headers: Array<[string, string]>, body: Uint8Array | null, outputBufferSize?: number"
    )]
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
        // The fresh `out` vec cannot alias `body` (a distinct JS buffer), so it
        // is safe to borrow the body without copying.
        let body_bytes: &[u8] = match &body {
            Some(b) => b.as_ref(),
            None => &[],
        };

        // Default SMALL (the packed decision + metadata JSON is typically a few
        // hundred bytes — a flat 256 KiB zero-fill per call is wasteful) and
        // grow on the pipeline's "output buffer too small" signal, capped at
        // `MAX_OUTPUT_BUFFER_SIZE`. Hot paths use the pooled `_into` variant.
        let mut output_size = match output_buffer_size {
            Some(s) => clamp_output_size(Some(s)),
            // `OUT_DATA_START + 8192` is within `[OUT_DATA_START, MAX]` by
            // construction, so no clamp is needed for the default.
            None => OUT_DATA_START + 8192,
        };
        let mut out = vec![0u8; output_size];
        let mut attempt_headers = headers.clone();
        loop {
            match self.full_sync_into(
                method_kind,
                &url,
                &ip,
                &request_id,
                attempt_headers,
                body_bytes,
                &mut out,
            ) {
                Ok(written) => {
                    out.truncate(written);
                    return Ok(Uint8Array::new(out));
                }
                Err(e)
                    if e.reason == "output buffer too small"
                        && output_size < MAX_OUTPUT_BUFFER_SIZE as usize =>
                {
                    // Grow (bounded) and retry with a fresh header marshal.
                    output_size = (output_size * 2).min(MAX_OUTPUT_BUFFER_SIZE as usize);
                    out.resize(output_size, 0);
                    attempt_headers = headers.clone();
                }
                Err(e) => return Err(e),
            }
        }
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
    #[allow(clippy::too_many_arguments)]
    #[napi(
        ts_args_type = "methodKind: number, url: string, ip: string, requestId: string, headers: Array<[string, string]>, body: Uint8Array | null, output: Uint8Array"
    )]
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
    #[allow(clippy::too_many_arguments)]
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
