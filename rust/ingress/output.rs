// rust/ingress/output.rs — Ingress output buffer layout and low-level write helpers
// The canonical numeric source for the ingress binary output layout.
// `ingress_constants.rs` re-exports these values to JS via NAPI.

// ── Output buffer binary layout ───────────────────────────────────
pub const OUT_VERDICT: usize = 0;
pub const OUT_ERROR_CODE: usize = 1;
pub const OUT_STATUS: usize = 2;
pub const OUT_FLAGS: usize = 4;
pub const OUT_RATE_LIMIT: usize = 8;
pub const OUT_RATE_REMAINING: usize = 12;
pub const OUT_RATE_RESET: usize = 16;
pub const OUT_RETRY_AFTER: usize = 24;
pub const OUT_COOKIES_JSON_LEN: usize = 32;
pub const OUT_QUERY_JSON_LEN: usize = 36;
pub const OUT_HEADER_VARIANT: usize = 40;
pub const OUT_BODY_JSON_LEN: usize = 44;
pub const OUT_DATA_START: usize = 48;

/// Upper bound for the allocating `handle_request_full_sync` output buffer
/// (64 MiB) — a misconfigured huge `outputBufferSize` would otherwise allocate
/// gigabytes and OOM the process.
pub const MAX_OUTPUT_BUFFER_SIZE: u32 = 64 * 1024 * 1024;

// ── Flags ─────────────────────────────────────────────────────────
pub const FLAG_HAS_COOKIES: u32 = 1 << 0;
pub const FLAG_HAS_QUERY: u32 = 1 << 1;
pub const FLAG_BODY_VALID_JSON: u32 = 1 << 2;
pub const FLAG_SCHEMA_VALID: u32 = 1 << 3;
pub const FLAG_CORS_ALLOWED: u32 = 1 << 4;
pub const FLAG_IS_PREFLIGHT: u32 = 1 << 5;
pub const FLAG_RATE_LIMITED: u32 = 1 << 6;
pub const FLAG_HTTPS: u32 = 1 << 7;
pub const FLAG_TRUSTED_PROXY: u32 = 1 << 8;
pub const FLAG_BODY_TRUNCATED: u32 = 1 << 9;

// ── Header variant bits ───────────────────────────────────────────
pub const HV_JSON: u8 = 1 << 0;
pub const HV_CORS_SIMPLE: u8 = 1 << 1;
pub const HV_CORS_PREFLIGHT: u8 = 1 << 2;
pub const HV_RATE_ACTIVE: u8 = 1 << 3;
pub const HV_RATE_LIMITED: u8 = 1 << 4;
pub const HV_COUNT: u8 = 32;

// ── Error codes ───────────────────────────────────────────────────
pub const ERR_CODE_NONE: u8 = 0;
pub const ERR_CODE_CORS_PREFLIGHT: u8 = 1;
pub const ERR_CODE_RATE_LIMITED: u8 = 2;
pub const ERR_CODE_BODY_TOO_LARGE: u8 = 3;
pub const ERR_CODE_INVALID_JSON: u8 = 4;
pub const ERR_CODE_SCHEMA_VALIDATION: u8 = 5;
pub const ERR_CODE_BAD_REQUEST: u8 = 6;
pub const ERR_CODE_REQUEST_TOO_LARGE: u8 = 7;
pub const ERR_CODE_INTERNAL: u8 = 8;

// ── Output header writer ──────────────────────────────────────────

/// Compute the header variant byte from booleans.
#[inline(always)]
pub fn compute_header_variant(
    cors_ok: bool,
    is_preflight: bool,
    rate_active: bool,
    rate_limited: bool,
    wants_json: bool,
) -> u8 {
    let mut hv: u8 = 0;
    if wants_json {
        hv |= HV_JSON;
    }
    if cors_ok && !is_preflight {
        hv |= HV_CORS_SIMPLE;
    }
    if is_preflight {
        hv |= HV_CORS_PREFLIGHT;
    }
    if rate_active {
        hv |= HV_RATE_ACTIVE;
    }
    if rate_limited {
        hv |= HV_RATE_LIMITED;
    }
    hv
}

// ── Aggregated header fields ──────────────────────────────────────

/// Rate-limit metadata threaded through the pipeline and written into the
/// output header. Bundled into one struct so call sites stay readable.
#[derive(Default, Clone, Copy)]
pub(crate) struct RateInfo {
    pub limit: u32,
    pub remaining: u32,
    pub reset_ms: u64,
    pub retry_after_ms: u64,
}

/// The full set of fields written into the 48-byte ingress output header.
///
/// Using a struct (instead of 13 positional arguments) keeps call sites
/// readable and prevents argument-order mistakes.
#[derive(Clone, Copy)]
pub(crate) struct HeaderFields {
    pub verdict: u8,
    pub error_code: u8,
    pub status: u16,
    pub flags: u32,
    pub rate: RateInfo,
    pub cookies_json_len: u32,
    pub query_json_len: u32,
    pub header_variant: u8,
    pub body_json_len: u32,
}

impl HeaderFields {
    /// Build a successful response (verdict 0, status 200).
    #[inline(always)]
    pub fn ok(
        flags: u32,
        rate: RateInfo,
        cookies_json_len: u32,
        query_json_len: u32,
        header_variant: u8,
        body_json_len: u32,
    ) -> Self {
        Self {
            verdict: 0,
            error_code: ERR_CODE_NONE,
            status: 200,
            flags,
            rate,
            cookies_json_len,
            query_json_len,
            header_variant,
            body_json_len,
        }
    }

    /// Build a terminal error response.
    #[inline(always)]
    pub fn terminal(
        verdict: u8,
        error_code: u8,
        status: u16,
        flags: u32,
        rate: RateInfo,
        header_variant: u8,
    ) -> Self {
        Self {
            verdict,
            error_code,
            status,
            flags,
            rate,
            cookies_json_len: 0,
            query_json_len: 0,
            header_variant,
            body_json_len: 0,
        }
    }

    /// Serialize into the output buffer. Returns the total bytes written.
    #[inline(always)]
    pub fn write(self, out: &mut [u8]) -> usize {
        write_output_header(
            out,
            self.verdict,
            self.error_code,
            self.status,
            self.flags,
            self.rate.limit,
            self.rate.remaining,
            self.rate.reset_ms,
            self.rate.retry_after_ms,
            self.cookies_json_len,
            self.query_json_len,
            self.header_variant,
            self.body_json_len,
        )
    }
}

/// Write the output header into the buffer. Returns the total written bytes
/// (header + data payload sizes).
#[inline(always)]
/// Write the binary output header for an ingress decision.
///
/// The napi-driven ingress layout legitimately carries many fields; this is
/// the single writer for the packed decision header.
#[allow(clippy::too_many_arguments)]
pub fn write_output_header(
    out: &mut [u8],
    verdict: u8,
    error_code: u8,
    status: u16,
    flags: u32,
    rate_limit: u32,
    rate_remaining: u32,
    rate_reset_ms: u64,
    retry_after_ms: u64,
    cookies_json_len: u32,
    query_json_len: u32,
    header_variant: u8,
    body_json_len: u32,
) -> usize {
    // The pipeline only writes 200 (`HeaderFields::ok`) or terminal 4xx/5xx,
    // so 101 (and any other out-of-range status) is clamped to 500.
    let status = if (200u16..=599u16).contains(&status) {
        status
    } else {
        500
    };

    // Defense-in-depth: the writer stores directly into the header slots; a
    // SINGLE upfront check (instead of per-field `write_u16/32/64` capacity
    // asserts) requires the full header, so a too-small buffer still fails
    // loudly (→ JS 500 via catch_unwind) but the hot path pays one bounds
    // check for the whole 48-byte header instead of seven. The header layout
    // is fixed and power-of-two aligned, so all stores below are in-bounds
    // after the check.
    assert!(
        out.len() >= OUT_DATA_START,
        "output buffer too small for the ingress decision header"
    );

    unsafe {
        let p = out.as_mut_ptr();
        // # Safety: `p` points into `out`, which has been verified to hold at
        // least `OUT_DATA_START` bytes above; every offset written below is a
        // compile-time constant within `[0, OUT_DATA_START)`, so all these
        // stores are in-bounds. No other reference to `out` is live here.
        *p.add(OUT_VERDICT) = verdict;
        *p.add(OUT_ERROR_CODE) = error_code;
        (p.add(OUT_STATUS) as *mut u16).write_unaligned(status);
        (p.add(OUT_FLAGS) as *mut u32).write_unaligned(flags);
        (p.add(OUT_RATE_LIMIT) as *mut u32).write_unaligned(rate_limit);
        (p.add(OUT_RATE_REMAINING) as *mut u32).write_unaligned(rate_remaining);
        (p.add(OUT_RATE_RESET) as *mut u64).write_unaligned(rate_reset_ms);
        (p.add(OUT_RETRY_AFTER) as *mut u64).write_unaligned(retry_after_ms);
        (p.add(OUT_COOKIES_JSON_LEN) as *mut u32).write_unaligned(cookies_json_len);
        (p.add(OUT_QUERY_JSON_LEN) as *mut u32).write_unaligned(query_json_len);
        *p.add(OUT_HEADER_VARIANT) = header_variant;
        *p.add(OUT_HEADER_VARIANT + 1) = 0;
        *p.add(OUT_HEADER_VARIANT + 2) = 0;
        *p.add(OUT_HEADER_VARIANT + 3) = 0;
        (p.add(OUT_BODY_JSON_LEN) as *mut u32).write_unaligned(body_json_len);
    }

    OUT_DATA_START + cookies_json_len as usize + query_json_len as usize + body_json_len as usize
}

#[cfg(test)]
mod tests {
    use super::{
        compute_header_variant, write_output_header, HV_CORS_PREFLIGHT, HV_CORS_SIMPLE, HV_JSON,
        HV_RATE_ACTIVE, HV_RATE_LIMITED, OUT_BODY_JSON_LEN, OUT_COOKIES_JSON_LEN, OUT_DATA_START,
        OUT_ERROR_CODE, OUT_FLAGS, OUT_HEADER_VARIANT, OUT_QUERY_JSON_LEN, OUT_RATE_LIMIT,
        OUT_RATE_REMAINING, OUT_RATE_RESET, OUT_RETRY_AFTER, OUT_STATUS, OUT_VERDICT,
    };

    #[test]
    fn output_compute_header_variant_bits() {
        assert_eq!(compute_header_variant(false, false, false, false, true), HV_JSON);
        assert_eq!(compute_header_variant(true, false, false, false, true), HV_JSON | HV_CORS_SIMPLE);
        assert_eq!(compute_header_variant(false, true, false, false, true), HV_JSON | HV_CORS_PREFLIGHT);
        assert_eq!(compute_header_variant(true, false, true, false, true), HV_JSON | HV_CORS_SIMPLE | HV_RATE_ACTIVE);
        assert_eq!(compute_header_variant(false, false, true, true, true), HV_JSON | HV_RATE_ACTIVE | HV_RATE_LIMITED);
    }

    #[test]
    fn output_write_header_layout() {
        let mut out = vec![0u8; 1024];
        let written = write_output_header(
            &mut out,
            0,       // verdict
            3,       // error_code
            200,     // status
            0x1F,    // flags
            100,     // rate_limit
            50,      // rate_remaining
            123_456, // rate_reset_ms
            5,       // retry_after_ms
            10,      // cookies_json_len
            20,      // query_json_len
            HV_JSON | HV_RATE_ACTIVE,
            30, // body_json_len
        );

        assert_eq!(out[OUT_VERDICT], 0);
        assert_eq!(out[OUT_ERROR_CODE], 3);
        assert_eq!(u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]), 200);
        assert_eq!(
            u32::from_le_bytes([out[OUT_FLAGS], out[OUT_FLAGS + 1], out[OUT_FLAGS + 2], out[OUT_FLAGS + 3]]),
            0x1F
        );
        assert_eq!(
            u32::from_le_bytes([out[OUT_RATE_LIMIT], out[OUT_RATE_LIMIT + 1], out[OUT_RATE_LIMIT + 2], out[OUT_RATE_LIMIT + 3]]),
            100
        );
        assert_eq!(
            u32::from_le_bytes([out[OUT_RATE_REMAINING], out[OUT_RATE_REMAINING + 1], out[OUT_RATE_REMAINING + 2], out[OUT_RATE_REMAINING + 3]]),
            50
        );
        let reset = u64::from_le_bytes(out[OUT_RATE_RESET..OUT_RATE_RESET + 8].try_into().unwrap());
        assert_eq!(reset, 123_456);
        let retry = u64::from_le_bytes(out[OUT_RETRY_AFTER..OUT_RETRY_AFTER + 8].try_into().unwrap());
        assert_eq!(retry, 5);
        assert_eq!(
            u32::from_le_bytes([out[OUT_COOKIES_JSON_LEN], out[OUT_COOKIES_JSON_LEN + 1], out[OUT_COOKIES_JSON_LEN + 2], out[OUT_COOKIES_JSON_LEN + 3]]),
            10
        );
        assert_eq!(
            u32::from_le_bytes([out[OUT_QUERY_JSON_LEN], out[OUT_QUERY_JSON_LEN + 1], out[OUT_QUERY_JSON_LEN + 2], out[OUT_QUERY_JSON_LEN + 3]]),
            20
        );
        assert_eq!(out[OUT_HEADER_VARIANT], HV_JSON | HV_RATE_ACTIVE);
        assert_eq!(
            u32::from_le_bytes([out[OUT_BODY_JSON_LEN], out[OUT_BODY_JSON_LEN + 1], out[OUT_BODY_JSON_LEN + 2], out[OUT_BODY_JSON_LEN + 3]]),
            30
        );

        assert_eq!(written, OUT_DATA_START + 10 + 20 + 30);
    }

    #[test]
    fn output_write_header_normalizes_invalid_status() {
        let mut out = vec![0u8; 128];
        let written = write_output_header(&mut out, 1, 6, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
        assert_eq!(status, 500, "invalid status must be coerced to 500");
        assert_eq!(written, OUT_DATA_START);
    }

    #[test]
    fn output_write_header_clamps_out_of_range_status() {
        // The pipeline only emits 200 (`HeaderFields::ok`) or terminal 4xx/5xx;
        // out-of-range statuses (e.g. 101, 600) are intentionally clamped to 500
        // (see output.rs write_output_header).
        let mut out = vec![0u8; 128];
        write_output_header(&mut out, 1, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        let status = u16::from_le_bytes([out[OUT_STATUS], out[OUT_STATUS + 1]]);
        assert_eq!(status, 500);
    }

    #[test]
    #[should_panic(expected = "output buffer too small")]
    fn output_header_panics_on_undersized() {
        // Enterprise guard: `write_output_header` self-checks the full 48-byte
        // header up front so a miscalculated buffer becomes a clean panic (→ napi
        // catch_unwind → JS 500) instead of a silent OOB write.
        let mut out = vec![0u8; crate::ingress::output::OUT_DATA_START - 1];
        crate::ingress::output::write_output_header(&mut out, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}
