// src/ingress/constants.ts — SINGLE SOURCE OF TRUTH for ingress binary layout constants
// These are read from the Rust native addon to eliminate duplication across:
//   - src/ingress/index.ts
//   - bench/servers/ingress-server.ts
//   - Any future consumers
//
// IMPORTANT: Do NOT hardcode these values. They come from Rust's ingress_constants.rs
// and are typed on the NativeAddon interface (src/native/index.ts).

import { getAddon } from "../native";

// Read eagerly at module load: these constants are the ingress layout source
// of truth and are needed as soon as the ingress API is used.
const addon = getAddon();

// ── Output buffer layout ───────────────────────────────────
export const OUT_VERDICT: number = addon.INGRESS_OUT_VERDICT;
export const OUT_ERROR_CODE: number = addon.INGRESS_OUT_ERROR_CODE;
export const OUT_STATUS: number = addon.INGRESS_OUT_STATUS;
export const OUT_FLAGS: number = addon.INGRESS_OUT_FLAGS;
export const OUT_RATE_LIMIT: number = addon.INGRESS_OUT_RATE_LIMIT;
export const OUT_RATE_REMAINING: number = addon.INGRESS_OUT_RATE_REMAINING;
export const OUT_RATE_RESET: number = addon.INGRESS_OUT_RATE_RESET;
export const OUT_RETRY_AFTER: number = addon.INGRESS_OUT_RETRY_AFTER;
export const OUT_COOKIES_JSON_LEN: number = addon.INGRESS_OUT_COOKIES_JSON_LEN;
export const OUT_QUERY_JSON_LEN: number = addon.INGRESS_OUT_QUERY_JSON_LEN;
export const OUT_HEADER_VARIANT: number = addon.INGRESS_OUT_HEADER_VARIANT;
export const OUT_BODY_JSON_LEN: number = addon.INGRESS_OUT_BODY_JSON_LEN;
export const OUT_DATA_START: number = addon.INGRESS_OUT_DATA_START;

// ── Flags ──────────────────────────────────────────────────
export const FLAG_HAS_COOKIES: number = addon.INGRESS_FLAG_HAS_COOKIES;
export const FLAG_HAS_QUERY: number = addon.INGRESS_FLAG_HAS_QUERY;
export const FLAG_BODY_VALID_JSON: number = addon.INGRESS_FLAG_BODY_VALID_JSON;
export const FLAG_SCHEMA_VALID: number = addon.INGRESS_FLAG_SCHEMA_VALID;
export const FLAG_CORS_ALLOWED: number = addon.INGRESS_FLAG_CORS_ALLOWED;
export const FLAG_IS_PREFLIGHT: number = addon.INGRESS_FLAG_IS_PREFLIGHT;
export const FLAG_RATE_LIMITED: number = addon.INGRESS_FLAG_RATE_LIMITED;
export const FLAG_HTTPS: number = addon.INGRESS_FLAG_HTTPS;
export const FLAG_TRUSTED_PROXY: number = addon.INGRESS_FLAG_TRUSTED_PROXY;
export const FLAG_BODY_TRUNCATED: number = addon.INGRESS_FLAG_BODY_TRUNCATED;

// ── Header variant bits ────────────────────────────────────
export const HV_JSON: number = addon.INGRESS_HV_JSON;
export const HV_CORS_SIMPLE: number = addon.INGRESS_HV_CORS_SIMPLE;
export const HV_CORS_PREFLIGHT: number = addon.INGRESS_HV_CORS_PREFLIGHT;
export const HV_RATE_ACTIVE: number = addon.INGRESS_HV_RATE_ACTIVE;
export const HV_RATE_LIMITED: number = addon.INGRESS_HV_RATE_LIMITED;
export const HV_COUNT: number = addon.INGRESS_HV_COUNT;

// ── Error codes ────────────────────────────────────────────
export const ERR_CODE_NONE: number = addon.INGRESS_ERR_NONE;
export const ERR_CODE_CORS_PREFLIGHT: number = addon.INGRESS_ERR_CORS_PREFLIGHT;
export const ERR_CODE_RATE_LIMITED: number = addon.INGRESS_ERR_RATE_LIMITED;
export const ERR_CODE_BODY_TOO_LARGE: number = addon.INGRESS_ERR_BODY_TOO_LARGE;
export const ERR_CODE_INVALID_JSON: number = addon.INGRESS_ERR_INVALID_JSON;
export const ERR_CODE_SCHEMA_VALIDATION: number = addon.INGRESS_ERR_SCHEMA_VALIDATION;
export const ERR_CODE_BAD_REQUEST: number = addon.INGRESS_ERR_BAD_REQUEST;
export const ERR_CODE_REQUEST_TOO_LARGE: number = addon.INGRESS_ERR_REQUEST_TOO_LARGE;
export const ERR_CODE_INTERNAL: number = addon.INGRESS_ERR_INTERNAL;
