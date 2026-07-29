// rust/ingress_async.rs — Async ingress handler
// Accepts raw request components from JS, packs & processes on a thread pool.
// This eliminates the synchronous napi blocking and JS-side packing overhead.

use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::sync::Arc;

use crate::ingress::IngressInner;
use crate::output::OUT_DATA_START;
use crate::terminal::terminal_simple;

use crate::util::tokio_join_error;

/// Packed header entry for wire format.
/// Each entry: [u16 name_len][name bytes][u32 value_len][value bytes]
fn pack_single_header(buf: &mut Vec<u8>, name: &str, value: &str) {
    let name_bytes = name.as_bytes();
    buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
    buf.extend_from_slice(name_bytes);
    let value_bytes = value.as_bytes();
    buf.extend_from_slice(&(value_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(value_bytes);
}

/// Build the full packed input buffer from raw JS components.
fn build_packed_input(
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
        pack_single_header(&mut buf, name, value);
    }

    // Patch the header section length
    let headers_len = buf.len() - headers_start;
    buf[headers_len_pos..headers_len_pos + 4].copy_from_slice(&(headers_len as u32).to_le_bytes());

    buf
}

/// Async ingress handler.
/// Accepts raw request components, processes on thread pool, returns output buffer.
/// This eliminates the synchronous napi blocking by offloading to tokio's blocking pool.
#[napi]
pub struct AsyncIngress {
    inner: Arc<IngressInner>,
}

#[napi]
impl AsyncIngress {
    #[napi(constructor)]
    pub fn new(options: crate::ingress::IngressOptions) -> Result<Self> {
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
                let limiter = crate::rate_limit::KeyedRateLimiter::new(limit, window_ms, max_entries);
                (true, Some(Arc::new(limiter)))
            }
        } else {
            (false, None)
        };

        let limits = crate::ingress::Limits::from_options(options.limits);

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

    /// Async ingress handler.
    /// Accepts raw request components, processes on tokio blocking thread pool.
    ///
    /// @param methodKind - numeric method kind (0=GET, 1=HEAD, ..., 6=OPTIONS)
    /// @param url - request URL string
    /// @param ip - client IP string (or "0.0.0.0")
    /// @param requestId - request ID hex string
    /// @param headers - Array<[name: string, value: string]>
    /// @param body - Uint8Array | null
    /// @param outputBufferSize - size of output buffer to allocate (default 262144)
    /// @returns Uint8Array containing the output header + metadata JSON
    #[napi(ts_args_type = "methodKind: number, url: string, ip: string, requestId: string, headers: Array<[string, string]>, body: Uint8Array | null, outputBufferSize?: number")]
    pub async fn handle_request_full(
        &self,
        method_kind: u32,
        url: String,
        ip: String,
        request_id: String,
        headers: Vec<Vec<String>>,
        body: Option<Uint8Array>,
        output_buffer_size: Option<u32>,
    ) -> Result<Uint8Array> {
        let inner = self.inner.clone();
        let url_bytes = url.into_bytes();
        let ip_bytes = ip.into_bytes();
        let rid_bytes = request_id.into_bytes();

        // Convert headers Vec<Vec<String>> to Vec<(String, String)>
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

        let body_owned = body.map(|b| b.as_ref().to_vec()).unwrap_or_default();
        let output_size = output_buffer_size.unwrap_or(262_144).max(OUT_DATA_START as u32) as usize;

        // Offload to thread pool — this is the key performance win
        let result = tokio::task::spawn_blocking(move || {
            let mut out = vec![0u8; output_size];

            // Build packed input inside the thread pool (no JS boundary crossing)
            let packed = build_packed_input(
                method_kind as u8,
                &url_bytes,
                &ip_bytes,
                &rid_bytes,
                &header_pairs,
            );

            // Process using the same handler as sync Ingress
            match inner.handle_packed(&packed, &body_owned, &mut out) {
                Ok(written) => {
                    out.truncate(written);
                    out
                }
                Err(_) => {
                    // Terminal error — write a simple error output
                    // Use ERR_CODE_BAD_REQUEST (6) as the generic error indicator
                    let _ = terminal_simple(&mut out, 1, crate::output::ERR_CODE_BAD_REQUEST, 500);
                    out.truncate(OUT_DATA_START);
                    out
                }
            }
        })
        .await
        .map_err(tokio_join_error)?;

        Ok(result.into())
    }
}