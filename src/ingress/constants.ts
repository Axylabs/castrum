// src/ingress/constants.ts — SINGLE SOURCE OF TRUTH for ingress binary layout constants
// These are read from the Rust native addon to eliminate duplication across:
//   - src/ingress/index.ts
//   - bench/servers/ingress-server.ts
//   - Any future consumers
//
// IMPORTANT: Do NOT hardcode these values. They come from Rust's ingress_constants.rs.

import addon from "../native";

// ── Output buffer layout ───────────────────────────────────
export const OUT_VERDICT: number = (addon as any).INGRESS_OUT_VERDICT as number;
export const OUT_ERROR_CODE: number = (addon as any).INGRESS_OUT_ERROR_CODE as number;
export const OUT_STATUS: number = (addon as any).INGRESS_OUT_STATUS as number;
export const OUT_FLAGS: number = (addon as any).INGRESS_OUT_FLAGS as number;
export const OUT_RATE_LIMIT: number = (addon as any).INGRESS_OUT_RATE_LIMIT as number;
export const OUT_RATE_REMAINING: number = (addon as any).INGRESS_OUT_RATE_REMAINING as number;
export const OUT_RATE_RESET: number = (addon as any).INGRESS_OUT_RATE_RESET as number;
export const OUT_RETRY_AFTER: number = (addon as any).INGRESS_OUT_RETRY_AFTER as number;
export const OUT_COOKIES_JSON_LEN: number = (addon as any).INGRESS_OUT_COOKIES_JSON_LEN as number;
export const OUT_QUERY_JSON_LEN: number = (addon as any).INGRESS_OUT_QUERY_JSON_LEN as number;
export const OUT_HEADER_VARIANT: number = (addon as any).INGRESS_OUT_HEADER_VARIANT as number;
export const OUT_BODY_JSON_LEN: number = (addon as any).INGRESS_OUT_BODY_JSON_LEN as number;
export const OUT_DATA_START: number = (addon as any).INGRESS_OUT_DATA_START as number;

// ── Flags ──────────────────────────────────────────────────
export const FLAG_HAS_COOKIES: number = (addon as any).INGRESS_FLAG_HAS_COOKIES as number;
export const FLAG_HAS_QUERY: number = (addon as any).INGRESS_FLAG_HAS_QUERY as number;
export const FLAG_BODY_VALID_JSON: number = (addon as any).INGRESS_FLAG_BODY_VALID_JSON as number;
export const FLAG_SCHEMA_VALID: number = (addon as any).INGRESS_FLAG_SCHEMA_VALID as number;
export const FLAG_CORS_ALLOWED: number = (addon as any).INGRESS_FLAG_CORS_ALLOWED as number;
export const FLAG_IS_PREFLIGHT: number = (addon as any).INGRESS_FLAG_IS_PREFLIGHT as number;
export const FLAG_RATE_LIMITED: number = (addon as any).INGRESS_FLAG_RATE_LIMITED as number;
export const FLAG_HTTPS: number = (addon as any).INGRESS_FLAG_HTTPS as number;
export const FLAG_TRUSTED_PROXY: number = (addon as any).INGRESS_FLAG_TRUSTED_PROXY as number;
export const FLAG_BODY_TRUNCATED: number = (addon as any).INGRESS_FLAG_BODY_TRUNCATED as number;

// ── Header variant bits ────────────────────────────────────
export const HV_JSON: number = (addon as any).INGRESS_HV_JSON as number;
export const HV_CORS_SIMPLE: number = (addon as any).INGRESS_HV_CORS_SIMPLE as number;
export const HV_CORS_PREFLIGHT: number = (addon as any).INGRESS_HV_CORS_PREFLIGHT as number;
export const HV_RATE_ACTIVE: number = (addon as any).INGRESS_HV_RATE_ACTIVE as number;
export const HV_RATE_LIMITED: number = (addon as any).INGRESS_HV_RATE_LIMITED as number;
export const HV_COUNT: number = (addon as any).INGRESS_HV_COUNT as number;

// ── Error codes ────────────────────────────────────────────
export const ERR_CODE_NONE: number = (addon as any).INGRESS_ERR_NONE as number;
export const ERR_CODE_CORS_PREFLIGHT: number = (addon as any).INGRESS_ERR_CORS_PREFLIGHT as number;
export const ERR_CODE_RATE_LIMITED: number = (addon as any).INGRESS_ERR_RATE_LIMITED as number;
export const ERR_CODE_BODY_TOO_LARGE: number = (addon as any).INGRESS_ERR_BODY_TOO_LARGE as number;
export const ERR_CODE_INVALID_JSON: number = (addon as any).INGRESS_ERR_INVALID_JSON as number;
export const ERR_CODE_SCHEMA_VALIDATION: number = (addon as any).INGRESS_ERR_SCHEMA_VALIDATION as number;
export const ERR_CODE_BAD_REQUEST: number = (addon as any).INGRESS_ERR_BAD_REQUEST as number;
export const ERR_CODE_REQUEST_TOO_LARGE: number = (addon as any).INGRESS_ERR_REQUEST_TOO_LARGE as number;
export const ERR_CODE_INTERNAL: number = (addon as any).INGRESS_ERR_INTERNAL as number;