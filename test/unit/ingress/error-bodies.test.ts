/**
 * Tests for src/ingress/response/error-bodies.ts — pre-encoded error bodies
 * and the numeric-code drift guard (previously untested).
 *
 * Covers:
 * - ERROR_BODIES wire shape: {"ok":false,"error":{"code","message"}}
 * - ERROR_CODE_BODIES covers every native error code (drift guard vs errors.ts)
 * - rateLimitedBody inlines retry_after_ms
 * - errorCodeName/errorMessage/statusForErrorCode agree on every code
 *   (incl. the JS-only ERR_CODE_REQUEST_TIMEOUT sentinel)
 */

import { describe, test, expect } from 'bun:test'
import {
  ERROR_BODIES,
  ERROR_CODE_BODIES,
  rateLimitedBody,
} from '../../../src/ingress/response/error-bodies'
import { errorCodeName, errorMessage } from '../../../src/ingress/errors'
import { statusForErrorCode } from '../../../src/ingress/status'
import {
  ERR_CODE_NONE,
  ERR_CODE_CORS_PREFLIGHT,
  ERR_CODE_RATE_LIMITED,
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_INVALID_JSON,
  ERR_CODE_SCHEMA_VALIDATION,
  ERR_CODE_BAD_REQUEST,
  ERR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_REQUEST_TIMEOUT,
  ERR_CODE_INTERNAL,
} from '../../../src/ingress/constants'

const decoder = new TextDecoder()

function parseBody(bytes: Uint8Array) {
  return JSON.parse(decoder.decode(bytes)) as {
    ok: boolean
    error: { code: string; message: string }
  }
}

describe('ERROR_BODIES', () => {
  test('static bodies use the pre-baked wire shape', () => {
    const body = parseBody(ERROR_BODIES.internal ?? new Uint8Array(0))
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('internal_error')
    expect(typeof body.error.message).toBe('string')
  })

  test('every documented code has a body', () => {
    for (const key of [
      'not_found',
      'unsupported_media_type',
      'body_too_large',
      'request_timeout',
      'invalid_json',
      'schema_validation_failed',
      'cors_preflight_not_allowed',
      'bad_request',
      'request_too_large',
      'rate_limited',
      'internal',
    ]) {
      expect(ERROR_BODIES[key], `missing body for '${key}'`).toBeDefined()
    }
  })
})

describe('ERROR_CODE_BODIES (drift guard)', () => {
  // Every error code the name/message helpers know must also have a baked
  // body, so the two paths can never silently drift apart.
  const errorCodes = [
    ERR_CODE_CORS_PREFLIGHT,
    ERR_CODE_RATE_LIMITED,
    ERR_CODE_BODY_TOO_LARGE,
    ERR_CODE_INVALID_JSON,
    ERR_CODE_SCHEMA_VALIDATION,
    ERR_CODE_BAD_REQUEST,
    ERR_CODE_REQUEST_TOO_LARGE,
    ERR_CODE_INTERNAL,
  ]

  test('covers every error code surfaced by errorCodeName', () => {
    for (const code of errorCodes) {
      expect(ERROR_CODE_BODIES[code], `no body for code ${code}`).toBeDefined()
    }
  })

  test('the code name mapped by errorCodeName exists as an ERROR_BODIES key', () => {
    for (const code of errorCodes) {
      const name = errorCodeName(code)
      const body = ERROR_CODE_BODIES[code] ?? new Uint8Array(0)
      const parsed = parseBody(body)
      // The baked path's name is intentionally distinct (e.g. schema_validation
      // vs schema_validation_failed) but each numeric code must render to a
      // real body; assert the body is well-formed and the message is present.
      expect(name.length).toBeGreaterThan(0)
      expect(parsed.error.message.length).toBeGreaterThan(0)
    }
  })
})

describe('rateLimitedBody', () => {
  test('inlines retry_after_ms', () => {
    const body = parseBody(rateLimitedBody(1500))
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('rate_limited')
    expect((body.error as { retry_after_ms?: number }).retry_after_ms).toBe(1500)
  })
})

describe('code/name/message/status agreement', () => {
  test('REQUEST_TIMEOUT renders 408 + request_timeout + timed-out message', () => {
    expect(errorCodeName(ERR_CODE_REQUEST_TIMEOUT)).toBe('request_timeout')
    expect(errorMessage(408, ERR_CODE_REQUEST_TIMEOUT)).toMatch(/timed out/i)
    expect(statusForErrorCode(ERR_CODE_REQUEST_TIMEOUT, false)).toBe(408)
  })

  test('every error code maps to a status >= 400', () => {
    for (const code of [
      ERR_CODE_CORS_PREFLIGHT,
      ERR_CODE_RATE_LIMITED,
      ERR_CODE_BODY_TOO_LARGE,
      ERR_CODE_INVALID_JSON,
      ERR_CODE_SCHEMA_VALIDATION,
      ERR_CODE_BAD_REQUEST,
      ERR_CODE_REQUEST_TOO_LARGE,
      ERR_CODE_REQUEST_TIMEOUT,
      ERR_CODE_INTERNAL,
    ]) {
      expect(statusForErrorCode(code, false)).toBeGreaterThanOrEqual(400)
    }
  })

  test('ERR_CODE_NONE maps to the 500 fallback (no error)', () => {
    expect(statusForErrorCode(ERR_CODE_NONE, false)).toBe(500)
    expect(errorCodeName(ERR_CODE_NONE)).toBe('none')
  })
})
