// src/ingress/response/error-bodies.ts — Pre-encoded static error bodies
// (pre-baked path).
//
// The pre-baked path emits the benchmark wire format:
//   {"ok":false,"error":{"code":"...","message":"..."}}
// These bodies are encoded once at module load so error responses never
// re-allocate or re-serialize on the hot path.

import { encoder } from '../../shared/bytes'
import {
  ERR_CODE_BAD_REQUEST,
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_CORS_PREFLIGHT,
  ERR_CODE_INTERNAL,
  ERR_CODE_INVALID_JSON,
  ERR_CODE_RATE_LIMITED,
  ERR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_SCHEMA_VALIDATION,
} from '../constants'

function staticErrorBody(code: string, message: string): Uint8Array {
  return encoder.encode(`{"ok":false,"error":{"code":"${code}","message":"${message}"}}`)
}

/** Pre-encoded static error bodies, keyed by error-code string name. */
export const ERROR_BODIES: Record<string, Uint8Array> = {
  not_found: staticErrorBody('not_found', 'Not found'),
  unsupported_media_type: staticErrorBody(
    'unsupported_media_type',
    'Content-Type must be application/json',
  ),
  body_too_large: staticErrorBody('body_too_large', 'Request body is too large'),
  request_timeout: staticErrorBody('request_timeout', 'Request body read timed out'),
  invalid_json: staticErrorBody('invalid_json', 'Invalid JSON body'),
  schema_validation_failed: staticErrorBody(
    'schema_validation_failed',
    'Request body failed schema validation',
  ),
  cors_preflight_not_allowed: staticErrorBody(
    'cors_preflight_not_allowed',
    'CORS preflight not allowed',
  ),
  bad_request: staticErrorBody('bad_request', 'Bad request'),
  request_too_large: staticErrorBody('request_too_large', 'Request too large'),
  rate_limited: staticErrorBody('rate_limited', 'Too Many Requests'),
  internal: staticErrorBody('internal_error', 'Internal server error'),
}

/** Error bodies indexed by numeric native error code. */
export const ERROR_CODE_BODIES: (Uint8Array | undefined)[] = []
ERROR_CODE_BODIES[ERR_CODE_CORS_PREFLIGHT] = ERROR_BODIES.cors_preflight_not_allowed
ERROR_CODE_BODIES[ERR_CODE_RATE_LIMITED] = ERROR_BODIES.rate_limited
ERROR_CODE_BODIES[ERR_CODE_BODY_TOO_LARGE] = ERROR_BODIES.body_too_large
ERROR_CODE_BODIES[ERR_CODE_INVALID_JSON] = ERROR_BODIES.invalid_json
ERROR_CODE_BODIES[ERR_CODE_SCHEMA_VALIDATION] = ERROR_BODIES.schema_validation_failed
ERROR_CODE_BODIES[ERR_CODE_BAD_REQUEST] = ERROR_BODIES.bad_request
ERROR_CODE_BODIES[ERR_CODE_REQUEST_TOO_LARGE] = ERROR_BODIES.request_too_large
ERROR_CODE_BODIES[ERR_CODE_INTERNAL] = ERROR_BODIES.internal

const RATE_LIMIT_BODY_PREFIX = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":',
)
const RATE_LIMIT_BODY_SUFFIX = encoder.encode('}}')

/** Build a rate-limited error body with the retry-after value inlined. */
export function rateLimitedBody(retryAfterMs: number): Uint8Array {
  const digits = encoder.encode(String(Math.max(0, Math.floor(retryAfterMs))))
  const out = new Uint8Array(
    RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength + RATE_LIMIT_BODY_SUFFIX.byteLength,
  )
  out.set(RATE_LIMIT_BODY_PREFIX, 0)
  out.set(digits, RATE_LIMIT_BODY_PREFIX.byteLength)
  out.set(RATE_LIMIT_BODY_SUFFIX, RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength)
  return out
}
