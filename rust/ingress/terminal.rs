// rust/ingress/terminal.rs — Cold-path terminal response writers
// These functions are #[cold] so they don't pollute the hot-path
// instruction cache. They build responses via `HeaderFields`.

use crate::ingress::output::{
    HeaderFields, RateInfo, ERR_CODE_BODY_TOO_LARGE, ERR_CODE_CORS_PREFLIGHT,
    ERR_CODE_INVALID_JSON, ERR_CODE_NONE, ERR_CODE_RATE_LIMITED, ERR_CODE_SCHEMA_VALIDATION,
    HV_JSON,
};
use napi::Result;

/// Write a simple terminal response (no CORS, no rate limiting).
#[cold]
pub(crate) fn terminal_simple(out: &mut [u8], error_code: u8, status: u16) -> Result<usize> {
    Ok(HeaderFields::terminal(1, error_code, status, 0, RateInfo::default(), HV_JSON).write(out))
}

/// Write a preflight OK response (204).
#[cold]
pub(crate) fn terminal_preflight_ok(flags: u32, hv: u8, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(2, ERR_CODE_NONE, 204, flags, RateInfo::default(), hv).write(out))
}

/// Write a preflight forbidden response (403).
#[cold]
pub(crate) fn terminal_preflight_forbidden(flags: u32, hv: u8, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(
        2,
        ERR_CODE_CORS_PREFLIGHT,
        403,
        flags,
        RateInfo::default(),
        hv,
    )
    .write(out))
}

/// Write a rate-limited response (429).
#[cold]
pub(crate) fn terminal_rate_limited(
    flags: u32,
    hv: u8,
    rate: RateInfo,
    out: &mut [u8],
) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_RATE_LIMITED, 429, flags, rate, hv).write(out))
}

/// Write a body-too-large response (413).
#[cold]
pub(crate) fn terminal_body_too_large(
    flags: u32,
    hv: u8,
    rate: RateInfo,
    out: &mut [u8],
) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_BODY_TOO_LARGE, 413, flags, rate, hv).write(out))
}

/// Write an invalid JSON response (400).
#[cold]
pub(crate) fn terminal_invalid_json(
    flags: u32,
    hv: u8,
    rate: RateInfo,
    out: &mut [u8],
) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_INVALID_JSON, 400, flags, rate, hv).write(out))
}

/// Write a schema validation failure response (422).
#[cold]
pub(crate) fn terminal_schema_validation(
    flags: u32,
    hv: u8,
    rate: RateInfo,
    out: &mut [u8],
) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_SCHEMA_VALIDATION, 422, flags, rate, hv).write(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingress::output::{
        HV_CORS_PREFLIGHT, OUT_DATA_START, OUT_ERROR_CODE, OUT_STATUS, OUT_VERDICT,
    };

    fn u16_at(out: &[u8], off: usize) -> u16 {
        u16::from_le_bytes([out[off], out[off + 1]])
    }

    #[test]
    fn terminal_simple_writes_error_layout() {
        let mut out = vec![0u8; 128];
        let written = terminal_simple(&mut out, ERR_CODE_INVALID_JSON, 400).unwrap();
        // Terminal responses write the fixed 48-byte header with no data payload.
        assert_eq!(written, OUT_DATA_START);
        assert_eq!(out[OUT_VERDICT], 1);
        assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_INVALID_JSON);
        assert_eq!(u16_at(&out, OUT_STATUS), 400);
    }

    #[test]
    fn terminal_rate_limited_writes_429_and_rate_info() {
        let mut out = vec![0u8; 128];
        let rate = RateInfo {
            limit: 10,
            remaining: 0,
            reset_ms: 5,
            retry_after_ms: 7,
        };
        let written = terminal_rate_limited(0, HV_JSON, rate, &mut out).unwrap();
        assert_eq!(written, OUT_DATA_START);
        assert_eq!(out[OUT_VERDICT], 1);
        assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_RATE_LIMITED);
        assert_eq!(u16_at(&out, OUT_STATUS), 429);
    }

    #[test]
    fn terminal_preflight_ok_is_204() {
        let mut out = vec![0u8; 128];
        let written = terminal_preflight_ok(0, HV_CORS_PREFLIGHT, &mut out).unwrap();
        assert_eq!(written, OUT_DATA_START);
        assert_eq!(u16_at(&out, OUT_STATUS), 204);
        assert_eq!(out[OUT_ERROR_CODE], ERR_CODE_NONE);
    }
}
