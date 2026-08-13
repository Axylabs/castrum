// src/ingress/constants.ts — SINGLE SOURCE OF TRUTH for ingress binary layout constants
// These are read from Rust to eliminate duplication across:
//   - src/ingress/index.ts
//   - bench/servers/ingress-server.ts
//   - Any future consumers
//
// IMPORTANT: Do NOT hardcode these values. They come from Rust's
// `ingress/output.rs` (the single numeric source), projected to JS via either
// `ingress_constants.rs` (NAPI) or the C-ABI layout blob `rust/ffi.rs`
// `IngressLayout` (`castrum_ingress_layout`). Both read the same numbers, so
// they cannot drift.

import { getAddon } from '../native'
import { getBunFFI, type BunFFI } from '../native/ffi'

// Transport: bun:ffi is PRIMARY on Bun, so the layout is read through the
// C-ABI blob WITHOUT dlopening the napi addon. Node — or forced
// `CASTRUM_FFI_MODE=napi`, a missing symbol, or a failed bind-time self-test —
// falls back to the napi addon. This is the ONE module that touches native at
// import time; everything else in the package stays lazy.
const ffi = getBunFFI()

// Slot order mirrors the `#[repr(C)] IngressLayout` struct in rust/ffi.rs
// (38 × u32 LE). Drift is guarded by the Rust unit test
// `ingress_layout_c_abi_matches_output_source` and by the pinned values in the
// bun:ffi bind-time self-test (a reorder → self-test fails → napi fallback).
const SLOT = {
  OUT_VERDICT: 0,
  OUT_ERROR_CODE: 1,
  OUT_STATUS: 2,
  OUT_FLAGS: 3,
  OUT_RATE_LIMIT: 4,
  OUT_RATE_REMAINING: 5,
  OUT_RATE_RESET: 6,
  OUT_RETRY_AFTER: 7,
  OUT_COOKIES_JSON_LEN: 8,
  OUT_QUERY_JSON_LEN: 9,
  OUT_HEADER_VARIANT: 10,
  OUT_BODY_JSON_LEN: 11,
  OUT_DATA_START: 12,
  FLAG_HAS_COOKIES: 13,
  FLAG_HAS_QUERY: 14,
  FLAG_BODY_VALID_JSON: 15,
  FLAG_SCHEMA_VALID: 16,
  FLAG_CORS_ALLOWED: 17,
  FLAG_IS_PREFLIGHT: 18,
  FLAG_RATE_LIMITED: 19,
  FLAG_HTTPS: 20,
  FLAG_TRUSTED_PROXY: 21,
  FLAG_BODY_TRUNCATED: 22,
  HV_JSON: 23,
  HV_CORS_SIMPLE: 24,
  HV_CORS_PREFLIGHT: 25,
  HV_RATE_ACTIVE: 26,
  HV_RATE_LIMITED: 27,
  HV_COUNT: 28,
  ERR_NONE: 29,
  ERR_CORS_PREFLIGHT: 30,
  ERR_RATE_LIMITED: 31,
  ERR_BODY_TOO_LARGE: 32,
  ERR_INVALID_JSON: 33,
  ERR_SCHEMA_VALIDATION: 34,
  ERR_BAD_REQUEST: 35,
  ERR_REQUEST_TOO_LARGE: 36,
  ERR_INTERNAL: 37,
} as const

type Layout = Record<keyof typeof SLOT, number>

/** Read the layout via the bun:ffi C-ABI blob (Bun primary path). */
function readLayoutViaFfi(ffiLive: BunFFI): Layout {
  const buf = new Uint8Array(38 * 4)
  ffiLive.ingressLayout(buf)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = {} as Layout
  for (const key of Object.keys(SLOT) as (keyof typeof SLOT)[]) {
    out[key] = view.getUint32(SLOT[key] * 4, true)
  }
  return out
}

/** Read the layout via the napi addon (Node / fallback). */
function readLayoutViaNapi(): Layout {
  const addon = getAddon()
  return {
    OUT_VERDICT: addon.INGRESS_OUT_VERDICT,
    OUT_ERROR_CODE: addon.INGRESS_OUT_ERROR_CODE,
    OUT_STATUS: addon.INGRESS_OUT_STATUS,
    OUT_FLAGS: addon.INGRESS_OUT_FLAGS,
    OUT_RATE_LIMIT: addon.INGRESS_OUT_RATE_LIMIT,
    OUT_RATE_REMAINING: addon.INGRESS_OUT_RATE_REMAINING,
    OUT_RATE_RESET: addon.INGRESS_OUT_RATE_RESET,
    OUT_RETRY_AFTER: addon.INGRESS_OUT_RETRY_AFTER,
    OUT_COOKIES_JSON_LEN: addon.INGRESS_OUT_COOKIES_JSON_LEN,
    OUT_QUERY_JSON_LEN: addon.INGRESS_OUT_QUERY_JSON_LEN,
    OUT_HEADER_VARIANT: addon.INGRESS_OUT_HEADER_VARIANT,
    OUT_BODY_JSON_LEN: addon.INGRESS_OUT_BODY_JSON_LEN,
    OUT_DATA_START: addon.INGRESS_OUT_DATA_START,
    FLAG_HAS_COOKIES: addon.INGRESS_FLAG_HAS_COOKIES,
    FLAG_HAS_QUERY: addon.INGRESS_FLAG_HAS_QUERY,
    FLAG_BODY_VALID_JSON: addon.INGRESS_FLAG_BODY_VALID_JSON,
    FLAG_SCHEMA_VALID: addon.INGRESS_FLAG_SCHEMA_VALID,
    FLAG_CORS_ALLOWED: addon.INGRESS_FLAG_CORS_ALLOWED,
    FLAG_IS_PREFLIGHT: addon.INGRESS_FLAG_IS_PREFLIGHT,
    FLAG_RATE_LIMITED: addon.INGRESS_FLAG_RATE_LIMITED,
    FLAG_HTTPS: addon.INGRESS_FLAG_HTTPS,
    FLAG_TRUSTED_PROXY: addon.INGRESS_FLAG_TRUSTED_PROXY,
    FLAG_BODY_TRUNCATED: addon.INGRESS_FLAG_BODY_TRUNCATED,
    HV_JSON: addon.INGRESS_HV_JSON,
    HV_CORS_SIMPLE: addon.INGRESS_HV_CORS_SIMPLE,
    HV_CORS_PREFLIGHT: addon.INGRESS_HV_CORS_PREFLIGHT,
    HV_RATE_ACTIVE: addon.INGRESS_HV_RATE_ACTIVE,
    HV_RATE_LIMITED: addon.INGRESS_HV_RATE_LIMITED,
    HV_COUNT: addon.INGRESS_HV_COUNT,
    ERR_NONE: addon.INGRESS_ERR_NONE,
    ERR_CORS_PREFLIGHT: addon.INGRESS_ERR_CORS_PREFLIGHT,
    ERR_RATE_LIMITED: addon.INGRESS_ERR_RATE_LIMITED,
    ERR_BODY_TOO_LARGE: addon.INGRESS_ERR_BODY_TOO_LARGE,
    ERR_INVALID_JSON: addon.INGRESS_ERR_INVALID_JSON,
    ERR_SCHEMA_VALIDATION: addon.INGRESS_ERR_SCHEMA_VALIDATION,
    ERR_BAD_REQUEST: addon.INGRESS_ERR_BAD_REQUEST,
    ERR_REQUEST_TOO_LARGE: addon.INGRESS_ERR_REQUEST_TOO_LARGE,
    ERR_INTERNAL: addon.INGRESS_ERR_INTERNAL,
  }
}

const L: Layout = ffi !== null ? readLayoutViaFfi(ffi) : readLayoutViaNapi()

// ── Output buffer layout ───────────────────────────────────
// Byte offsets into the fixed header of the native ingress OUTPUT buffer.
// The header occupies [0, OUT_DATA_START); the cookie/query/body JSON sections
// follow at OUT_DATA_START (see decode/packed-sections.ts). Read through the
// C-ABI layout blob (Bun) or napi (Node) — never hardcoded.

/** Offset of the verdict byte (0 = accepted, nonzero = terminal error). */
export const OUT_VERDICT: number = L.OUT_VERDICT
/** Offset of the error-code byte (see ERR_CODE_* below). */
export const OUT_ERROR_CODE: number = L.OUT_ERROR_CODE
/** Offset of the raw u16 status. */
export const OUT_STATUS: number = L.OUT_STATUS
/** Offset of the u32 flags word (see FLAG_* below). */
export const OUT_FLAGS: number = L.OUT_FLAGS
/** Offset of the u32 rate-limit budget (U32_MAX = disabled). */
export const OUT_RATE_LIMIT: number = L.OUT_RATE_LIMIT
/** Offset of the u32 rate-limit remaining count. */
export const OUT_RATE_REMAINING: number = L.OUT_RATE_REMAINING
/** Offset of the u64 rate-limit window reset (ms epoch). */
export const OUT_RATE_RESET: number = L.OUT_RATE_RESET
/** Offset of the u64 Retry-After value (ms). */
export const OUT_RETRY_AFTER: number = L.OUT_RETRY_AFTER
/** Offset of the u32 cookies-JSON section length. */
export const OUT_COOKIES_JSON_LEN: number = L.OUT_COOKIES_JSON_LEN
/** Offset of the u32 query-JSON section length. */
export const OUT_QUERY_JSON_LEN: number = L.OUT_QUERY_JSON_LEN
/** Offset of the header-template variant byte (see HV_* below). */
export const OUT_HEADER_VARIANT: number = L.OUT_HEADER_VARIANT
/** Offset of the u32 body-JSON section length. */
export const OUT_BODY_JSON_LEN: number = L.OUT_BODY_JSON_LEN
/** Byte offset where the variable-length JSON sections begin. */
export const OUT_DATA_START: number = L.OUT_DATA_START

// ── Flags (bits within the OUT_FLAGS u32) ──────────────────
/** Request carried a cookie header (cookie-JSON section present). */
export const FLAG_HAS_COOKIES: number = L.FLAG_HAS_COOKIES
/** Request carried a query string (query-JSON section present). */
export const FLAG_HAS_QUERY: number = L.FLAG_HAS_QUERY
/** The request body parsed as valid JSON. */
export const FLAG_BODY_VALID_JSON: number = L.FLAG_BODY_VALID_JSON
/** The request body validated against the ingress schema. */
export const FLAG_SCHEMA_VALID: number = L.FLAG_SCHEMA_VALID
/** The CORS engine allowed the request origin. */
export const FLAG_CORS_ALLOWED: number = L.FLAG_CORS_ALLOWED
/** The request was a CORS preflight (OPTIONS + request-method). */
export const FLAG_IS_PREFLIGHT: number = L.FLAG_IS_PREFLIGHT
/** The request was rate-limited. */
export const FLAG_RATE_LIMITED: number = L.FLAG_RATE_LIMITED
/** The request arrived over HTTPS (trusted-proxy scheme). */
export const FLAG_HTTPS: number = L.FLAG_HTTPS
/** The request came from a trusted proxy (per the proxy config). */
export const FLAG_TRUSTED_PROXY: number = L.FLAG_TRUSTED_PROXY
/** A declared output section overran the buffer (truncated). */
export const FLAG_BODY_TRUNCATED: number = L.FLAG_BODY_TRUNCATED

// ── Header variant bits (bits within the OUT_HEADER_VARIANT byte) ──
/** Response body is JSON (`content-type: application/json`). */
export const HV_JSON: number = L.HV_JSON
/** CORS simple-request variant (Origin echoed + vary headers). */
export const HV_CORS_SIMPLE: number = L.HV_CORS_SIMPLE
/** CORS preflight variant (allow-methods/headers/max-age). */
export const HV_CORS_PREFLIGHT: number = L.HV_CORS_PREFLIGHT
/** Rate-limit active variant (`ratelimit-limit` header). */
export const HV_RATE_ACTIVE: number = L.HV_RATE_ACTIVE
/** Rate-limited variant (Retry-After emitted). */
export const HV_RATE_LIMITED: number = L.HV_RATE_LIMITED
/** Total number of header-variant combinations (32). */
export const HV_COUNT: number = L.HV_COUNT

// ── Error codes (bytes in OUT_ERROR_CODE) ──────────────────
/** No error (accepted). */
export const ERR_CODE_NONE: number = L.ERR_NONE
/** CORS preflight rejected. */
export const ERR_CODE_CORS_PREFLIGHT: number = L.ERR_CORS_PREFLIGHT
/** Rate limit exceeded. */
export const ERR_CODE_RATE_LIMITED: number = L.ERR_RATE_LIMITED
/** Request body exceeded the size guard. */
export const ERR_CODE_BODY_TOO_LARGE: number = L.ERR_BODY_TOO_LARGE
/** Request body is not valid JSON. */
export const ERR_CODE_INVALID_JSON: number = L.ERR_INVALID_JSON
/** Request body failed schema validation. */
export const ERR_CODE_SCHEMA_VALIDATION: number = L.ERR_SCHEMA_VALIDATION
/** Malformed request (bad request line / headers). */
export const ERR_CODE_BAD_REQUEST: number = L.ERR_BAD_REQUEST
/** Request headers/URL exceeded the configured limits. */
export const ERR_CODE_REQUEST_TOO_LARGE: number = L.ERR_REQUEST_TOO_LARGE
/** Internal pipeline failure (maps to 500). */
export const ERR_CODE_INTERNAL: number = L.ERR_INTERNAL

/**
 * JS-only error-code sentinel for a request-body read timeout in the async
 * `createIngress` path.
 *
 * The native pipeline never emits this value — it is a JS body-reader error
 * (`REQUEST_TIMEOUT` from `readBodyWithLimit`) mapped onto the numeric
 * error-code contract so the shared status/name/message helpers stay
 * consistent. Deliberately not sourced from Rust (see the header comment:
 * numeric layout values come from the addon; this one is a JS-level error).
 */
export const ERR_CODE_REQUEST_TIMEOUT: number = -1
