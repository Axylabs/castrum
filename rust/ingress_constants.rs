// rust/ingress_constants.rs — NAPI exports for ingress binary layout constants
// This is the SINGLE SOURCE OF TRUTH for the ingress output buffer format.
// TypeScript code reads these values via the native addon instead of duplicating them.

use napi_derive::napi;

// ── Output buffer layout ───────────────────────────────────
#[napi]
pub const INGRESS_OUT_VERDICT: u32 = 0;
#[napi]
pub const INGRESS_OUT_ERROR_CODE: u32 = 1;
#[napi]
pub const INGRESS_OUT_STATUS: u32 = 2;
#[napi]
pub const INGRESS_OUT_FLAGS: u32 = 4;
#[napi]
pub const INGRESS_OUT_RATE_LIMIT: u32 = 8;
#[napi]
pub const INGRESS_OUT_RATE_REMAINING: u32 = 12;
#[napi]
pub const INGRESS_OUT_RATE_RESET: u32 = 16;
#[napi]
pub const INGRESS_OUT_RETRY_AFTER: u32 = 24;
#[napi]
pub const INGRESS_OUT_COOKIES_JSON_LEN: u32 = 32;
#[napi]
pub const INGRESS_OUT_QUERY_JSON_LEN: u32 = 36;
#[napi]
pub const INGRESS_OUT_HEADER_VARIANT: u32 = 40;
#[napi]
pub const INGRESS_OUT_BODY_JSON_LEN: u32 = 44;
#[napi]
pub const INGRESS_OUT_DATA_START: u32 = 48;

// ── Flags ──────────────────────────────────────────────────
#[napi]
pub const INGRESS_FLAG_HAS_COOKIES: u32 = 1 << 0;
#[napi]
pub const INGRESS_FLAG_HAS_QUERY: u32 = 1 << 1;
#[napi]
pub const INGRESS_FLAG_BODY_VALID_JSON: u32 = 1 << 2;
#[napi]
pub const INGRESS_FLAG_SCHEMA_VALID: u32 = 1 << 3;
#[napi]
pub const INGRESS_FLAG_CORS_ALLOWED: u32 = 1 << 4;
#[napi]
pub const INGRESS_FLAG_IS_PREFLIGHT: u32 = 1 << 5;
#[napi]
pub const INGRESS_FLAG_RATE_LIMITED: u32 = 1 << 6;
#[napi]
pub const INGRESS_FLAG_HTTPS: u32 = 1 << 7;
#[napi]
pub const INGRESS_FLAG_TRUSTED_PROXY: u32 = 1 << 8;
#[napi]
pub const INGRESS_FLAG_BODY_TRUNCATED: u32 = 1 << 9;

// ── Header variant bits ────────────────────────────────────
#[napi]
pub const INGRESS_HV_JSON: u32 = 1 << 0;
#[napi]
pub const INGRESS_HV_CORS_SIMPLE: u32 = 1 << 1;
#[napi]
pub const INGRESS_HV_CORS_PREFLIGHT: u32 = 1 << 2;
#[napi]
pub const INGRESS_HV_RATE_ACTIVE: u32 = 1 << 3;
#[napi]
pub const INGRESS_HV_RATE_LIMITED: u32 = 1 << 4;
#[napi]
pub const INGRESS_HV_COUNT: u32 = 32;

// ── Error codes ────────────────────────────────────────────
#[napi]
pub const INGRESS_ERR_NONE: u32 = 0;
#[napi]
pub const INGRESS_ERR_CORS_PREFLIGHT: u32 = 1;
#[napi]
pub const INGRESS_ERR_RATE_LIMITED: u32 = 2;
#[napi]
pub const INGRESS_ERR_BODY_TOO_LARGE: u32 = 3;
#[napi]
pub const INGRESS_ERR_INVALID_JSON: u32 = 4;
#[napi]
pub const INGRESS_ERR_SCHEMA_VALIDATION: u32 = 5;
#[napi]
pub const INGRESS_ERR_BAD_REQUEST: u32 = 6;
#[napi]
pub const INGRESS_ERR_REQUEST_TOO_LARGE: u32 = 7;
#[napi]
pub const INGRESS_ERR_INTERNAL: u32 = 8;