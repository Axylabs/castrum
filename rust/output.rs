// rust/output.rs — Ingress output buffer layout and low-level write helpers
// The canonical numeric source for the ingress binary output layout.
// `ingress_constants.rs` re-exports these values to JS via NAPI.

use std::ptr;

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

// ── Unsafe output helpers ─────────────────────────────────────────

/// Panic-safe capacity check for the unsafe writers. This makes each write
/// self-checking instead of resting on a single upstream `out.len() >= 48`
/// guard — with `panic = "unwind"` a miscalculation becomes a clean JS error
/// (napi catch_unwind) rather than a silent OOB write.
#[inline(always)]
fn check_capacity(out: &[u8], pos: usize, n: usize) {
    let end = pos
        .checked_add(n)
        .unwrap_or_else(|| panic!("castrum output position overflow at {pos} (n={n})"));
    assert!(
        end <= out.len(),
        "castrum output buffer overflow at {pos} (n={n}, len={})",
        out.len()
    );
}

/// Write a u16 at the given position in little-endian format.
///
/// # Safety
/// `pos + 2` must be within `out` (enforced by `check_capacity`, which panics
/// on overflow — with `panic = "unwind"` napi converts that to a clean JS error).
#[inline(always)]
pub unsafe fn write_u16(out: &mut [u8], pos: usize, value: u16) {
    check_capacity(out, pos, 2);
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 2);
}

/// Write a u32 at the given position in little-endian format.
///
/// # Safety
/// `pos + 4` must be within `out` (enforced by `check_capacity`, which panics
/// on overflow — with `panic = "unwind"` napi converts that to a clean JS error).
#[inline(always)]
pub unsafe fn write_u32(out: &mut [u8], pos: usize, value: u32) {
    check_capacity(out, pos, 4);
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 4);
}

/// Write a u64 at the given position in little-endian format.
///
/// # Safety
/// `pos + 8` must be within `out` (enforced by `check_capacity`, which panics
/// on overflow — with `panic = "unwind"` napi converts that to a clean JS error).
#[inline(always)]
pub unsafe fn write_u64(out: &mut [u8], pos: usize, value: u64) {
    check_capacity(out, pos, 8);
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 8);
}

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
    let status = if status == 101 || (200u16..=599u16).contains(&status) {
        status
    } else {
        500
    };

    unsafe {
        out[OUT_VERDICT] = verdict;
        out[OUT_ERROR_CODE] = error_code;
        write_u16(out, OUT_STATUS, status);
        write_u32(out, OUT_FLAGS, flags);
        write_u32(out, OUT_RATE_LIMIT, rate_limit);
        write_u32(out, OUT_RATE_REMAINING, rate_remaining);
        write_u64(out, OUT_RATE_RESET, rate_reset_ms);
        write_u64(out, OUT_RETRY_AFTER, retry_after_ms);
        write_u32(out, OUT_COOKIES_JSON_LEN, cookies_json_len);
        write_u32(out, OUT_QUERY_JSON_LEN, query_json_len);
        out[OUT_HEADER_VARIANT] = header_variant;
        out[OUT_HEADER_VARIANT + 1] = 0;
        out[OUT_HEADER_VARIANT + 2] = 0;
        out[OUT_HEADER_VARIANT + 3] = 0;
        write_u32(out, OUT_BODY_JSON_LEN, body_json_len);
    }

    OUT_DATA_START
        + cookies_json_len as usize
        + query_json_len as usize
        + body_json_len as usize
}