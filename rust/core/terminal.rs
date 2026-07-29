// rust/core/terminal.rs — Cold-path terminal response writers
// Pure Rust, no napi dependencies.
//
// These functions are #[cold] so they don't pollute the hot-path instruction cache.

use crate::core::output::{
    write_output_header, ERR_CODE_BODY_TOO_LARGE, ERR_CODE_CORS_PREFLIGHT,
    ERR_CODE_INVALID_JSON, ERR_CODE_NONE, ERR_CODE_RATE_LIMITED,
    ERR_CODE_SCHEMA_VALIDATION, HV_JSON,
};

/// Write a simple terminal response (no CORS, no rate limiting).
#[inline(never)]
#[cold]
pub fn terminal_simple(out: &mut [u8], verdict: u8, error_code: u8, status: u16) -> usize {
    write_output_header(
        out, verdict, error_code, status, 0, 0, 0, 0, 0, 0, 0, HV_JSON, 0,
    )
}

/// Write a preflight OK response (204).
#[inline(never)]
#[cold]
pub fn terminal_preflight_ok(flags: u32, hv: u8, out: &mut [u8]) -> usize {
    write_output_header(
        out, 2, ERR_CODE_NONE, 204, flags, 0, 0, 0, 0, 0, 0, hv, 0,
    )
}

/// Write a preflight forbidden response (403).
#[inline(never)]
#[cold]
pub fn terminal_preflight_forbidden(flags: u32, hv: u8, out: &mut [u8]) -> usize {
    write_output_header(
        out, 2, ERR_CODE_CORS_PREFLIGHT, 403, flags, 0, 0, 0, 0, 0, 0, hv, 0,
    )
}

/// Write a rate-limited response (429).
#[inline(never)]
#[cold]
pub fn terminal_rate_limited(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    retry: u64,
    out: &mut [u8],
) -> usize {
    write_output_header(
        out, 1, ERR_CODE_RATE_LIMITED, 429, flags, rl, rr, reset, retry, 0, 0, hv, 0,
    )
}

/// Write a body-too-large response (413).
#[inline(never)]
#[cold]
pub fn terminal_body_too_large(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> usize {
    write_output_header(
        out, 1, ERR_CODE_BODY_TOO_LARGE, 413, flags, rl, rr, reset, 0, 0, 0, hv, 0,
    )
}

/// Write an invalid JSON response (400).
#[inline(never)]
#[cold]
pub fn terminal_invalid_json(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> usize {
    write_output_header(
        out, 1, ERR_CODE_INVALID_JSON, 400, flags, rl, rr, reset, 0, 0, 0, hv, 0,
    )
}

/// Write a schema validation failure response (422).
#[inline(never)]
#[cold]
pub fn terminal_schema_validation(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> usize {
    write_output_header(
        out, 1, ERR_CODE_SCHEMA_VALIDATION, 422, flags, rl, rr, reset, 0, 0, 0, hv, 0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::output::OUT_DATA_START;

    #[test]
    fn test_terminal_simple() {
        let mut buf = [0u8; 128];
        let written = terminal_simple(&mut buf, 1, 6, 400);
        assert!(written >= OUT_DATA_START);
        assert_eq!(buf[crate::core::output::OUT_VERDICT], 1);
        assert_eq!(buf[crate::core::output::OUT_ERROR_CODE], 6);
    }
}
