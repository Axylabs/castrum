// rust/ingress/pipeline.rs — The core ingress request pipeline.
//
// `IngressInner::handle_packed` runs the 8-stage pipeline over a packed
// metadata frame + a borrowed body and writes the packed decision into the
// caller-provided `out` buffer; `write_body_sections` serializes cookies/query
// and the optional metadata envelope. This is the hot path shared by both the
// packed-input fast path (`handle_request_packed`) and the full_sync family.
//
// The napi boundary (`Ingress`, the entry points) lives in mod.rs; this module
// is pure core logic (napi types only at the `Result`/`Error` boundaries used
// for error signalling).

use napi::bindgen_prelude::*;
use napi::Status;

use std::sync::Arc;

use super::IngressInner;
use crate::http::headers::HeaderRefs;
use crate::http::method::MethodKind;
use crate::ingress::output::{
    compute_header_variant, HeaderFields, RateInfo, FLAG_BODY_TRUNCATED, FLAG_BODY_VALID_JSON,
    FLAG_CORS_ALLOWED, FLAG_HAS_COOKIES, FLAG_HAS_QUERY, FLAG_HTTPS, FLAG_IS_PREFLIGHT,
    FLAG_RATE_LIMITED, FLAG_SCHEMA_VALID, FLAG_TRUSTED_PROXY, OUT_DATA_START,
};
use crate::ingress::packed::read_section;
use crate::ingress::terminal::{
    terminal_body_too_large, terminal_invalid_json, terminal_preflight_forbidden,
    terminal_preflight_ok, terminal_rate_limited, terminal_schema_validation, terminal_simple,
};
use crate::ingress::time::rate_now_ms;

/// Precompiled request-body schema for an ingress instance.
///
/// Holds the authoritative `jsonschema` crate validator plus an optional
/// zero-DOM `fast_schema` fast path, both compiled **once at construction** so
/// no per-request schema work happens. `validate` engages the fast path when
/// the schema uses only the supported keyword subset and falls back to the
/// DOM validator otherwise — identical semantics to
/// `json_schema::SchemaValidator::validate_doc`.
pub(crate) struct IngressSchema {
    schema: Arc<jsonschema::Validator>,
    fast: Option<Arc<crate::json::fast_schema::FastNode>>,
}

impl IngressSchema {
    /// Compile the authoritative validator plus the optional fast path. Returns
    /// the raw schema compile error string for the caller to format.
    pub(crate) fn compile(schema_value: &serde_json::Value) -> std::result::Result<Self, String> {
        // `should_validate_formats(true)`: see json_schema.rs — jsonschema 0.48
        // disables formats by default; the fast path now honors format:email, so
        // the authoritative DOM validator must too (byte-parity requirement).
        // `.with_draft(Draft7)`: the fast path implements draft-07 and the crate
        // default draft (no `$schema`) is 2020-12 — pin so both paths agree on
        // schemas without a `$schema`. Declared `$schema` still overrides.
        let compiled = match jsonschema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .should_validate_formats(true)
            .build(schema_value)
        {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        let fast = crate::json::fast_schema::compile(schema_value)
            .ok()
            .map(Arc::new);
        Ok(Self {
            schema: Arc::new(compiled),
            fast,
        })
    }

    /// Validate a request body against the precompiled schema.
    #[inline]
    pub(crate) fn validate(&self, bytes: &[u8]) -> bool {
        if let Some(fast) = &self.fast {
            return fast.is_valid_bytes(bytes);
        }
        match sonic_rs::from_slice::<serde_json::Value>(bytes) {
            Ok(value) => self.schema.is_valid(&value),
            Err(_) => false,
        }
    }

    /// Whether the zero-DOM fast path is engaged for this schema.
    ///
    /// The fast path is used only when every keyword in the schema is in the
    /// supported subset (otherwise `compile` leaves `fast` as `None` and the
    /// DOM validator is authoritative). The ingress pipeline checks this so it
    /// can skip the separate `json_valid_bytes` gate ONLY when the validator is
    /// the DOM parser — a successful DOM parse already proves the body is
    /// well-formed JSON. The fast path is deliberately NOT relied on for that:
    /// its string scanning is structural but does not reject every RFC-8259
    /// violation (e.g. invalid `\uXXXX` escapes), so it must stay behind the
    /// strict `json_valid_bytes` gate.
    #[inline]
    pub(crate) fn uses_fast_path(&self) -> bool {
        self.fast.is_some()
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
            Err(_) => {
                return Ok(terminal_simple(out, crate::ingress::output::ERR_CODE_BAD_REQUEST, 414))
            }
        };
        let ip_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => {
                return Ok(terminal_simple(out, crate::ingress::output::ERR_CODE_BAD_REQUEST, 400))
            }
        };
        let rid_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => {
                return Ok(terminal_simple(out, crate::ingress::output::ERR_CODE_BAD_REQUEST, 400))
            }
        };
        let headers_packed = match read_section(input, &mut pos, self.limits.max_headers_bytes) {
            Ok(v) => v,
            Err(_) => {
                return Ok(terminal_simple(
                    out,
                    crate::ingress::output::ERR_CODE_REQUEST_TOO_LARGE,
                    431,
                ))
            }
        };
        let headers = match HeaderRefs::parse(headers_packed, is_options, self.limits.max_headers) {
            Ok(v) => v,
            Err(_) => {
                return Ok(terminal_simple(
                    out,
                    crate::ingress::output::ERR_CODE_REQUEST_TOO_LARGE,
                    431,
                ))
            }
        };

        // ── 2. Trust, client IP, and HTTPS ──────────────────────────
        let mut flags: u32 = 0;
        let rate_active = self.rate.as_limiter().is_some();

        let (resolved_ip, peer_trusted) = crate::ingress::ip_trust::resolve_client_ip(
            &self.proxy_trust,
            ip_bytes,
            headers.xff(),
            headers.x_real_ip(),
        );

        if peer_trusted {
            flags |= FLAG_TRUSTED_PROXY;
        }

        if crate::ingress::proxy::detect_https(
            self.https_fixed,
            &self.proxy_trust,
            url_bytes,
            &headers,
            peer_trusted,
        ) {
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
                return Ok(if eval.allowed {
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    terminal_preflight_forbidden(flags, hv, out)
                });
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
                return Ok(terminal_rate_limited(flags, hv, rate, out));
            }
        }

        // ── 5. Body size guard (may terminate with 413) ────────────
        if self.guard_enabled && body_bytes.len() > self.max_body_bytes {
            return Ok(terminal_body_too_large(flags, success_hv, rate, out));
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
                return Ok(terminal_invalid_json(flags, success_hv, rate, out));
            }

            // Fused validity + schema pass, preserving the 400/422 split:
            //
            // * DOM fallback path (no fast node): `schema.validate` parses the
            //   body into a `serde_json::Value` first, so a pass already proves
            //   the body is well-formed JSON — we can skip the separate
            //   `json_valid_bytes` body scan on the happy path (one full-body
            //   pass instead of two). On a failure `json_valid_bytes` still
            //   distinguishes a malformed body (400) from a well-formed body
            //   that fails the schema (422), exactly as before.
            // * Fast path (zero-DOM): the fast validator's structural string
            //   scanning does NOT reject every RFC-8259 violation (bad
            //   `\uXXXX` escapes, raw control bytes), so it MUST stay behind
            //   the strict `json_valid_bytes` gate to keep 400 semantics.
            match self.schema.as_ref() {
                Some(schema) if !schema.uses_fast_path() => {
                    if schema.validate(body_bytes) {
                        flags |= FLAG_BODY_VALID_JSON;
                        flags |= FLAG_SCHEMA_VALID;
                    } else if !crate::json::json_ops::json_valid_bytes(body_bytes) {
                        return Ok(terminal_invalid_json(flags, success_hv, rate, out));
                    } else {
                        return Ok(terminal_schema_validation(flags, success_hv, rate, out));
                    }
                }
                _ => {
                    // Strict gate (fast-path schema, or no schema): validate
                    // JSON validity first, then the schema when present.
                    if !crate::json::json_ops::json_valid_bytes(body_bytes) {
                        return Ok(terminal_invalid_json(flags, success_hv, rate, out));
                    }
                    flags |= FLAG_BODY_VALID_JSON;
                    if let Some(schema) = self.schema.as_ref() {
                        if !schema.validate(body_bytes) {
                            return Ok(terminal_schema_validation(flags, success_hv, rate, out));
                        }
                    }
                    // With no schema configured, validation trivially passes.
                    // Setting the flag here keeps `schemaValid` meaning "schema
                    // passed" for consumers that gate on it (e.g. handlers.ts
                    // jsonWriteHandler) regardless of schema configuration.
                    flags |= FLAG_SCHEMA_VALID;
                }
            }
        }

        // ── 7. Serialize cookies / query / metadata into the output ─
        // Extract the query string once and reuse it for both the size guard
        // and the JSON serialization, instead of scanning the URL twice.
        let raw_query: &[u8] = if self.parse_query {
            let q = crate::ingress::proxy::extract_query(url_bytes);
            if q.len() > self.limits.max_query_bytes {
                return Ok(terminal_simple(out, crate::ingress::output::ERR_CODE_BAD_REQUEST, 414));
            }
            q
        } else {
            &[]
        };

        let sections = match self.write_body_sections(url_bytes, rid_bytes, &headers, raw_query, out) {
            Ok(s) => s,
            Err(_) => {
                return Ok(terminal_simple(out, crate::ingress::output::ERR_CODE_BAD_REQUEST, 400))
            }
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
        raw_query: &[u8],
        out: &mut [u8],
    ) -> Result<BodySections> {
        let mut data_pos = OUT_DATA_START;
        let mut truncated = false;

        // ── Cookies → JSON ──
        let cookies_json_len: u32 = if self.parse_cookies {
            match headers.cookie() {
                Some(cookie) if cookie.len() <= self.limits.max_cookie_bytes => {
                    match crate::json::json_ser::cookie_json_into_slice(
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

        // ── Query → JSON (direct, zero-alloc: no intermediate packed buffer,
        //     no second parse of packed pairs; the query was already extracted
        //     once by the caller for the size guard) ──
        let query_json_len: u32 = if self.parse_query
            && !raw_query.is_empty()
            && data_pos < out.len()
        {
            match crate::json::json_ser::query_to_json_into_slice(
                raw_query,
                &mut out[data_pos..],
                self.limits.max_pairs,
            ) {
                Ok(written) => written as u32,
                Err(crate::json::json_ser::QueryJsonError::Malformed) => {
                    return Err(Error::from_reason("query parse failed"))
                }
                Err(crate::json::json_ser::QueryJsonError::BufferTooSmall) => {
                    truncated = true;
                    0
                }
            }
        } else {
            0
        };
        let query_start = data_pos;
        data_pos += query_json_len as usize;

        // ── Optional metadata envelope ──
        let body_json_len = if self.emit_metadata_json {
            crate::json::json_ser::write_full_body_json(
                out,
                data_pos,
                rid_bytes,
                crate::ingress::proxy::extract_path(url_bytes),
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
