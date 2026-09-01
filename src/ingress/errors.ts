// src/ingress/errors.ts — Fast-path error-code → name/message mapping.
//
// The pre-baked path keeps its own error bodies in ./response/error-bodies.ts
// because it emits a different wire format ({"ok":false,"error":{...}}), so
// the two mappings are intentionally not unified (see AGENTS.md).

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

/** Map a native error code to its stable string name. */
export function errorCodeName(code: number): string {
  switch (code) {
    case ERR_CODE_NONE:
      return 'none'
    case ERR_CODE_CORS_PREFLIGHT:
      return 'cors_preflight'
    case ERR_CODE_RATE_LIMITED:
      return 'rate_limited'
    case ERR_CODE_BODY_TOO_LARGE:
      return 'body_too_large'
    case ERR_CODE_INVALID_JSON:
      return 'invalid_json'
    case ERR_CODE_SCHEMA_VALIDATION:
      return 'schema_validation'
    case ERR_CODE_BAD_REQUEST:
      return 'bad_request'
    case ERR_CODE_REQUEST_TOO_LARGE:
      return 'request_too_large'
    case ERR_CODE_REQUEST_TIMEOUT:
      return 'request_timeout'
    case ERR_CODE_INTERNAL:
      return 'internal'
    default:
      return 'unknown'
  }
}

/** Map a native error code (plus status context) to a human message. */
export function errorMessage(status: number, code: number): string {
  switch (code) {
    case ERR_CODE_CORS_PREFLIGHT:
      return 'CORS preflight rejected'
    case ERR_CODE_RATE_LIMITED:
      return 'Too many requests'
    case ERR_CODE_BODY_TOO_LARGE:
      return 'Request body too large'
    case ERR_CODE_INVALID_JSON:
      return 'Invalid JSON body'
    case ERR_CODE_SCHEMA_VALIDATION:
      return 'JSON schema validation failed'
    case ERR_CODE_BAD_REQUEST:
      return 'Bad request'
    case ERR_CODE_REQUEST_TOO_LARGE:
      return 'Request too large'
    case ERR_CODE_REQUEST_TIMEOUT:
      return 'Request body read timed out'
    case ERR_CODE_INTERNAL:
      return 'Internal server error'
    default:
      return status >= 500 ? 'Internal server error' : 'Request rejected'
  }
}
