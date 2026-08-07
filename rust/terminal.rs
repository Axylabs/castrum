// rust/terminal.rs — Cold-path terminal response writers
// These functions are #[cold] so they don't pollute the hot-path
// instruction cache. They build responses via `HeaderFields`.

use crate::output::{
    HeaderFields, RateInfo, ERR_CODE_BODY_TOO_LARGE, ERR_CODE_CORS_PREFLIGHT,
    ERR_CODE_INVALID_JSON, ERR_CODE_NONE, ERR_CODE_RATE_LIMITED,
    ERR_CODE_SCHEMA_VALIDATION, HV_JSON,
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
    Ok(HeaderFields::terminal(2, ERR_CODE_CORS_PREFLIGHT, 403, flags, RateInfo::default(), hv).write(out))
}

/// Write a rate-limited response (429).
#[cold]
pub(crate) fn terminal_rate_limited(flags: u32, hv: u8, rate: RateInfo, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_RATE_LIMITED, 429, flags, rate, hv).write(out))
}

/// Write a body-too-large response (413).
#[cold]
pub(crate) fn terminal_body_too_large(flags: u32, hv: u8, rate: RateInfo, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_BODY_TOO_LARGE, 413, flags, rate, hv).write(out))
}

/// Write an invalid JSON response (400).
#[cold]
pub(crate) fn terminal_invalid_json(flags: u32, hv: u8, rate: RateInfo, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_INVALID_JSON, 400, flags, rate, hv).write(out))
}

/// Write a schema validation failure response (422).
#[cold]
pub(crate) fn terminal_schema_validation(flags: u32, hv: u8, rate: RateInfo, out: &mut [u8]) -> Result<usize> {
    Ok(HeaderFields::terminal(1, ERR_CODE_SCHEMA_VALIDATION, 422, flags, rate, hv).write(out))
}