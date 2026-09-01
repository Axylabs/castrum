// src/ingress/status.ts — HTTP status normalization helpers shared by both
// ingress paths (the fast path and the pre-baked handler path both normalize
// the raw status emitted by the native Ingress into a valid response status).
//
// These helpers operate on the numeric error-code contract defined in
// ./constants.ts, so they live in one place and cannot drift.

import {
  ERR_CODE_BAD_REQUEST,
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_CORS_PREFLIGHT,
  ERR_CODE_INTERNAL,
  ERR_CODE_INVALID_JSON,
  ERR_CODE_NONE,
  ERR_CODE_RATE_LIMITED,
  ERR_CODE_REQUEST_TIMEOUT,
  ERR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_SCHEMA_VALIDATION,
} from './constants'

/**
 * Whether a raw status is a legal HTTP response status for the ingress
 * pipeline (101 switch-protocol or any 2xx–5xx).
 */
export function isValidResponseStatus(status: number): boolean {
  return status === 101 || (status >= 200 && status <= 599)
}

/**
 * Map a native ingress error code to the HTTP status that should be returned.
 * A permitted CORS preflight always yields 204.
 */
export function statusForErrorCode(errorCode: number, isPreflightAllowed: boolean): number {
  if (isPreflightAllowed) return 204

  switch (errorCode) {
    case ERR_CODE_CORS_PREFLIGHT:
      return 403
    case ERR_CODE_RATE_LIMITED:
      return 429
    case ERR_CODE_BODY_TOO_LARGE:
      return 413
    case ERR_CODE_INVALID_JSON:
      return 400
    case ERR_CODE_SCHEMA_VALIDATION:
      return 422
    case ERR_CODE_BAD_REQUEST:
      return 400
    case ERR_CODE_REQUEST_TOO_LARGE:
      return 431
    case ERR_CODE_REQUEST_TIMEOUT:
      return 408
    case ERR_CODE_INTERNAL:
      return 500
    default:
      return 500
  }
}

/**
 * Normalize a raw status to a legal response status, falling back to the
 * error-code mapping when the raw status is not legal.
 */
export function normalizeResponseStatus(
  status: number,
  errorCode: number,
  isPreflightAllowed: boolean,
): number {
  if (isValidResponseStatus(status)) {
    return status
  }
  return statusForErrorCode(errorCode, isPreflightAllowed)
}

/**
 * Compute a safe terminal status for a result: a permitted CORS preflight
 * yields 204, otherwise the normalized status (or the error-code mapping).
 */
export function safeTerminalStatus(r: {
  readonly status: number
  readonly errorCode: number
  readonly isPreflight: boolean
  readonly corsAllowed: boolean
}): number {
  const preflightAllowed = r.isPreflight && r.corsAllowed
  if (preflightAllowed) return 204

  const s = normalizeResponseStatus(r.status, r.errorCode, false)

  if (s >= 400) return s

  if (r.errorCode !== ERR_CODE_NONE) {
    return statusForErrorCode(r.errorCode, false)
  }

  return 500
}
