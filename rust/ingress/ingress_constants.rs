// rust/ingress/ingress_constants.rs — NAPI exports for the ingress binary layout
//
// The NUMERIC values live in `output.rs` (the single source of truth). This
// module re-exports them to JavaScript via NAPI so TypeScript (via
// `src/ingress/constants.ts`) always reads the same numbers the Rust hot path
// uses — the two copies can never drift.

use crate::ingress::output;
use napi_derive::napi;

// ── Output buffer layout ───────────────────────────────────
#[napi]
pub const INGRESS_OUT_VERDICT: u32 = output::OUT_VERDICT as u32;
#[napi]
pub const INGRESS_OUT_ERROR_CODE: u32 = output::OUT_ERROR_CODE as u32;
#[napi]
pub const INGRESS_OUT_STATUS: u32 = output::OUT_STATUS as u32;
#[napi]
pub const INGRESS_OUT_FLAGS: u32 = output::OUT_FLAGS as u32;
#[napi]
pub const INGRESS_OUT_RATE_LIMIT: u32 = output::OUT_RATE_LIMIT as u32;
#[napi]
pub const INGRESS_OUT_RATE_REMAINING: u32 = output::OUT_RATE_REMAINING as u32;
#[napi]
pub const INGRESS_OUT_RATE_RESET: u32 = output::OUT_RATE_RESET as u32;
#[napi]
pub const INGRESS_OUT_RETRY_AFTER: u32 = output::OUT_RETRY_AFTER as u32;
#[napi]
pub const INGRESS_OUT_COOKIES_JSON_LEN: u32 = output::OUT_COOKIES_JSON_LEN as u32;
#[napi]
pub const INGRESS_OUT_QUERY_JSON_LEN: u32 = output::OUT_QUERY_JSON_LEN as u32;
#[napi]
pub const INGRESS_OUT_HEADER_VARIANT: u32 = output::OUT_HEADER_VARIANT as u32;
#[napi]
pub const INGRESS_OUT_BODY_JSON_LEN: u32 = output::OUT_BODY_JSON_LEN as u32;
#[napi]
pub const INGRESS_OUT_DATA_START: u32 = output::OUT_DATA_START as u32;

// ── Flags ──────────────────────────────────────────────────
#[napi]
pub const INGRESS_FLAG_HAS_COOKIES: u32 = output::FLAG_HAS_COOKIES;
#[napi]
pub const INGRESS_FLAG_HAS_QUERY: u32 = output::FLAG_HAS_QUERY;
#[napi]
pub const INGRESS_FLAG_BODY_VALID_JSON: u32 = output::FLAG_BODY_VALID_JSON;
#[napi]
pub const INGRESS_FLAG_SCHEMA_VALID: u32 = output::FLAG_SCHEMA_VALID;
#[napi]
pub const INGRESS_FLAG_CORS_ALLOWED: u32 = output::FLAG_CORS_ALLOWED;
#[napi]
pub const INGRESS_FLAG_IS_PREFLIGHT: u32 = output::FLAG_IS_PREFLIGHT;
#[napi]
pub const INGRESS_FLAG_RATE_LIMITED: u32 = output::FLAG_RATE_LIMITED;
#[napi]
pub const INGRESS_FLAG_HTTPS: u32 = output::FLAG_HTTPS;
#[napi]
pub const INGRESS_FLAG_TRUSTED_PROXY: u32 = output::FLAG_TRUSTED_PROXY;
#[napi]
pub const INGRESS_FLAG_BODY_TRUNCATED: u32 = output::FLAG_BODY_TRUNCATED;

// ── Header variant bits ────────────────────────────────────
#[napi]
pub const INGRESS_HV_JSON: u32 = output::HV_JSON as u32;
#[napi]
pub const INGRESS_HV_CORS_SIMPLE: u32 = output::HV_CORS_SIMPLE as u32;
#[napi]
pub const INGRESS_HV_CORS_PREFLIGHT: u32 = output::HV_CORS_PREFLIGHT as u32;
#[napi]
pub const INGRESS_HV_RATE_ACTIVE: u32 = output::HV_RATE_ACTIVE as u32;
#[napi]
pub const INGRESS_HV_RATE_LIMITED: u32 = output::HV_RATE_LIMITED as u32;
#[napi]
pub const INGRESS_HV_COUNT: u32 = output::HV_COUNT as u32;

// ── Error codes ────────────────────────────────────────────
#[napi]
pub const INGRESS_ERR_NONE: u32 = output::ERR_CODE_NONE as u32;
#[napi]
pub const INGRESS_ERR_CORS_PREFLIGHT: u32 = output::ERR_CODE_CORS_PREFLIGHT as u32;
#[napi]
pub const INGRESS_ERR_RATE_LIMITED: u32 = output::ERR_CODE_RATE_LIMITED as u32;
#[napi]
pub const INGRESS_ERR_BODY_TOO_LARGE: u32 = output::ERR_CODE_BODY_TOO_LARGE as u32;
#[napi]
pub const INGRESS_ERR_INVALID_JSON: u32 = output::ERR_CODE_INVALID_JSON as u32;
#[napi]
pub const INGRESS_ERR_SCHEMA_VALIDATION: u32 = output::ERR_CODE_SCHEMA_VALIDATION as u32;
#[napi]
pub const INGRESS_ERR_BAD_REQUEST: u32 = output::ERR_CODE_BAD_REQUEST as u32;
#[napi]
pub const INGRESS_ERR_REQUEST_TOO_LARGE: u32 = output::ERR_CODE_REQUEST_TOO_LARGE as u32;
#[napi]
pub const INGRESS_ERR_INTERNAL: u32 = output::ERR_CODE_INTERNAL as u32;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingress::output;

    /// The napi projections must never drift from the single numeric source
    /// (`output.rs`). If a layout constant is changed in `output.rs` and the
    /// projection here is not updated, this test fails.
    #[test]
    fn out_constants_match_output_source() {
        assert_eq!(INGRESS_OUT_VERDICT as u32, output::OUT_VERDICT as u32);
        assert_eq!(INGRESS_OUT_ERROR_CODE as u32, output::OUT_ERROR_CODE as u32);
        assert_eq!(INGRESS_OUT_STATUS as u32, output::OUT_STATUS as u32);
        assert_eq!(INGRESS_OUT_FLAGS as u32, output::OUT_FLAGS as u32);
        assert_eq!(INGRESS_OUT_RATE_LIMIT as u32, output::OUT_RATE_LIMIT as u32);
        assert_eq!(
            INGRESS_OUT_RATE_REMAINING as u32,
            output::OUT_RATE_REMAINING as u32
        );
        assert_eq!(INGRESS_OUT_RATE_RESET as u32, output::OUT_RATE_RESET as u32);
        assert_eq!(
            INGRESS_OUT_RETRY_AFTER as u32,
            output::OUT_RETRY_AFTER as u32
        );
        assert_eq!(
            INGRESS_OUT_COOKIES_JSON_LEN as u32,
            output::OUT_COOKIES_JSON_LEN as u32
        );
        assert_eq!(
            INGRESS_OUT_QUERY_JSON_LEN as u32,
            output::OUT_QUERY_JSON_LEN as u32
        );
        assert_eq!(
            INGRESS_OUT_HEADER_VARIANT as u32,
            output::OUT_HEADER_VARIANT as u32
        );
        assert_eq!(
            INGRESS_OUT_BODY_JSON_LEN as u32,
            output::OUT_BODY_JSON_LEN as u32
        );
        assert_eq!(
            INGRESS_OUT_DATA_START as u32,
            output::OUT_DATA_START as u32
        );
    }

    #[test]
    fn flag_constants_match_output_source() {
        assert_eq!(INGRESS_FLAG_HAS_COOKIES, output::FLAG_HAS_COOKIES);
        assert_eq!(INGRESS_FLAG_HAS_QUERY, output::FLAG_HAS_QUERY);
        assert_eq!(INGRESS_FLAG_BODY_VALID_JSON, output::FLAG_BODY_VALID_JSON);
        assert_eq!(INGRESS_FLAG_SCHEMA_VALID, output::FLAG_SCHEMA_VALID);
        assert_eq!(INGRESS_FLAG_CORS_ALLOWED, output::FLAG_CORS_ALLOWED);
        assert_eq!(INGRESS_FLAG_IS_PREFLIGHT, output::FLAG_IS_PREFLIGHT);
        assert_eq!(INGRESS_FLAG_RATE_LIMITED, output::FLAG_RATE_LIMITED);
        assert_eq!(INGRESS_FLAG_HTTPS, output::FLAG_HTTPS);
        assert_eq!(INGRESS_FLAG_TRUSTED_PROXY, output::FLAG_TRUSTED_PROXY);
        assert_eq!(INGRESS_FLAG_BODY_TRUNCATED, output::FLAG_BODY_TRUNCATED);
    }

    #[test]
    fn hv_constants_match_output_source() {
        assert_eq!(INGRESS_HV_JSON as u32, output::HV_JSON as u32);
        assert_eq!(
            INGRESS_HV_CORS_SIMPLE as u32,
            output::HV_CORS_SIMPLE as u32
        );
        assert_eq!(
            INGRESS_HV_CORS_PREFLIGHT as u32,
            output::HV_CORS_PREFLIGHT as u32
        );
        assert_eq!(INGRESS_HV_RATE_ACTIVE as u32, output::HV_RATE_ACTIVE as u32);
        assert_eq!(
            INGRESS_HV_RATE_LIMITED as u32,
            output::HV_RATE_LIMITED as u32
        );
        assert_eq!(INGRESS_HV_COUNT as u32, output::HV_COUNT as u32);
    }

    #[test]
    fn err_constants_match_output_source() {
        assert_eq!(INGRESS_ERR_NONE as u32, output::ERR_CODE_NONE as u32);
        assert_eq!(
            INGRESS_ERR_CORS_PREFLIGHT as u32,
            output::ERR_CODE_CORS_PREFLIGHT as u32
        );
        assert_eq!(
            INGRESS_ERR_RATE_LIMITED as u32,
            output::ERR_CODE_RATE_LIMITED as u32
        );
        assert_eq!(
            INGRESS_ERR_BODY_TOO_LARGE as u32,
            output::ERR_CODE_BODY_TOO_LARGE as u32
        );
        assert_eq!(
            INGRESS_ERR_INVALID_JSON as u32,
            output::ERR_CODE_INVALID_JSON as u32
        );
        assert_eq!(
            INGRESS_ERR_SCHEMA_VALIDATION as u32,
            output::ERR_CODE_SCHEMA_VALIDATION as u32
        );
        assert_eq!(
            INGRESS_ERR_BAD_REQUEST as u32,
            output::ERR_CODE_BAD_REQUEST as u32
        );
        assert_eq!(
            INGRESS_ERR_REQUEST_TOO_LARGE as u32,
            output::ERR_CODE_REQUEST_TOO_LARGE as u32
        );
        assert_eq!(INGRESS_ERR_INTERNAL as u32, output::ERR_CODE_INTERNAL as u32);
    }
}
