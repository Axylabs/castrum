// rust/core/output.rs — Output buffer layout and low-level write helpers
// Pure Rust, no napi dependencies.

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

// ── Error codes ───────────────────────────────────────────────────
pub const ERR_CODE_NONE: u8 = 0;
pub const ERR_CODE_CORS_PREFLIGHT: u8 = 1;
pub const ERR_CODE_RATE_LIMITED: u8 = 2;
pub const ERR_CODE_BODY_TOO_LARGE: u8 = 3;
pub const ERR_CODE_INVALID_JSON: u8 = 4;
pub const ERR_CODE_SCHEMA_VALIDATION: u8 = 5;
pub const ERR_CODE_BAD_REQUEST: u8 = 6;
pub const ERR_CODE_REQUEST_TOO_LARGE: u8 = 7;

// ── Unsafe output helpers ─────────────────────────────────────────

/// Write a u16 at the given position in little-endian format.
#[inline(always)]
pub unsafe fn write_u16(out: &mut [u8], pos: usize, value: u16) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 2);
}

/// Write a u32 at the given position in little-endian format.
#[inline(always)]
pub unsafe fn write_u32(out: &mut [u8], pos: usize, value: u32) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 4);
}

/// Write a u64 at the given position in little-endian format.
#[inline(always)]
pub unsafe fn write_u64(out: &mut [u8], pos: usize, value: u64) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 8);
}

// ── Slice cursor for sequential writing ───────────────────────────

/// A lightweight zero-cost cursor over a mutable byte slice.
/// Used for sequential writes without bounds checking (caller must ensure capacity).
pub struct Buf<'a> {
    slice: &'a mut [u8],
    pos: usize,
}

impl<'a> Buf<'a> {
    /// Create a new cursor starting at the beginning of the given slice.
    #[inline(always)]
    pub fn new(slice: &'a mut [u8]) -> Self {
        Self { slice, pos: 0 }
    }

    /// The current write position.
    #[inline(always)]
    pub fn pos(&self) -> usize {
        self.pos
    }

    /// Returns `true` if there is enough remaining capacity.
    #[inline(always)]
    pub fn can_write(&self, n: usize) -> bool {
        self.pos + n <= self.slice.len()
    }

    /// Advance the cursor by `n` bytes (caller must have written to them).
    #[inline(always)]
    pub fn advance(&mut self, n: usize) {
        self.pos += n;
    }

    /// Write a single byte.
    #[inline(always)]
    pub fn push(&mut self, b: u8) {
        self.slice[self.pos] = b;
        self.pos += 1;
    }

    /// Write a byte slice.
    #[inline(always)]
    pub fn write(&mut self, bytes: &[u8]) {
        let end = self.pos + bytes.len();
        self.slice[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
    }

    /// Write a u8 at the current position.
    #[inline(always)]
    pub fn write_u8(&mut self, value: u8) {
        self.slice[self.pos] = value;
        self.pos += 1;
    }

    /// Write a u16 in little-endian at the current position.
    #[inline(always)]
    pub fn write_u16(&mut self, value: u16) {
        let end = self.pos + 2;
        self.slice[self.pos..end].copy_from_slice(&value.to_le_bytes());
        self.pos = end;
    }

    /// Write a u32 in little-endian at the current position.
    #[inline(always)]
    pub fn write_u32(&mut self, value: u32) {
        let end = self.pos + 4;
        self.slice[self.pos..end].copy_from_slice(&value.to_le_bytes());
        self.pos = end;
    }

    /// Write a u32 at a specific position (patch).
    #[inline(always)]
    pub fn patch_u32(&mut self, pos: usize, value: u32) {
        self.slice[pos..pos + 4].copy_from_slice(&value.to_le_bytes());
    }

    /// Get a mutable sub-slice starting at current position.
    #[inline(always)]
    pub fn remaining_mut(&mut self) -> &mut [u8] {
        &mut self.slice[self.pos..]
    }

    /// Get a sub-slice of the written area.
    #[inline(always)]
    pub fn written(&self) -> &[u8] {
        &self.slice[..self.pos]
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_output_header() {
        let mut buf = [0u8; 128];
        let written = write_output_header(
            &mut buf, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, HV_JSON, 0,
        );
        assert!(written >= OUT_DATA_START);
        assert_eq!(buf[OUT_VERDICT], 0);
        assert_eq!(buf[OUT_STATUS..OUT_STATUS + 2], [200u8, 0]);
    }

    #[test]
    fn test_buf() {
        let mut data = [0u8; 16];
        let mut buf = Buf::new(&mut data);
        buf.write_u32(42);
        buf.write_u16(7);
        assert_eq!(buf.pos(), 6);
    }
}
