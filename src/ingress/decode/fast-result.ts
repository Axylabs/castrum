// src/ingress/decode/fast-result.ts — Zero-alloc result decoder (fast path).
//
// Decodes the native Ingress packed output (OUT_* layout in ./constants.ts)
// lazily: slices are stored, strings are decoded only on demand via
// cookiesJson()/queryJson()/bodyJson().
//
// NOTE: this is the fast-path decoder ({"error":{...}} wire format). The
// pre-baked path has its own decoder (./baked-result.ts) with a different
// wire format and status normalization — do not unify them (see AGENTS.md).
// The two decoders DO share their section/rate-limit plumbing via
// ./result-base.ts.

import { viewForArrayBuffer } from '../../shared/bytes'
import {
  OUT_VERDICT,
  OUT_ERROR_CODE,
  OUT_STATUS,
  OUT_FLAGS,
  OUT_RATE_LIMIT,
  OUT_RATE_REMAINING,
  OUT_COOKIES_JSON_LEN,
  OUT_QUERY_JSON_LEN,
  OUT_HEADER_VARIANT,
  OUT_BODY_JSON_LEN,
  OUT_DATA_START,
  FLAG_HAS_COOKIES,
  FLAG_HAS_QUERY,
  FLAG_BODY_VALID_JSON,
  FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED,
  FLAG_IS_PREFLIGHT,
  FLAG_RATE_LIMITED,
  FLAG_HTTPS,
  FLAG_TRUSTED_PROXY,
  FLAG_BODY_TRUNCATED,
  ERR_CODE_INTERNAL,
} from '../constants'
import { normalizeResponseStatus } from '../status'
import { sectionLayout } from './packed-sections'
import { IngressResultBase } from './result-base'

/** Zero-alloc, lazy-decoding view over a native Ingress output buffer. */
export class FastIngressResult extends IngressResultBase {
  // Fast path's empty state is an internal-error shape (500 / verdict 1 /
  // internal error-code). The baked decoder's empty state is neutral (0/0/0).
  override status = 500
  override verdict = 1
  override errorCode = ERR_CODE_INTERNAL
  flags = 0
  https = false
  hasCookies = false
  hasQuery = false
  rateLimit = 0
  requestId = ''

  refresh(buf: Uint8Array, body: Uint8Array, requestId: string): void {
    // Defensive: the native core always writes the full fixed header
    // (>= OUT_DATA_START bytes) before returning `written`. The cached
    // whole-buffer DataView below would otherwise decode stale bytes if this
    // contract is ever violated — treat it as an internal error instead.
    if (buf.byteLength < OUT_DATA_START) {
      this.setInternalError(requestId)
      return
    }
    this._buf = buf
    this.body = body
    this.requestId = requestId

    // Cached per-ArrayBuffer DataView (respects the subarray byteOffset): no
    // per-request view alloc on the offset-0 production buffers.
    const dv = viewForArrayBuffer(buf.buffer, buf.byteOffset)

    const rawVerdict = dv.getUint8(OUT_VERDICT)
    const rawErrorCode = dv.getUint8(OUT_ERROR_CODE)
    const rawStatus = dv.getUint16(OUT_STATUS, true)
    const flags = dv.getUint32(OUT_FLAGS, true)

    const rateLimit = dv.getUint32(OUT_RATE_LIMIT, true)
    const rateRemaining = dv.getUint32(OUT_RATE_REMAINING, true)

    const cookiesJsonLen = dv.getUint32(OUT_COOKIES_JSON_LEN, true)
    const queryJsonLen = dv.getUint32(OUT_QUERY_JSON_LEN, true)

    const headerVariant = dv.getUint8(OUT_HEADER_VARIANT)
    const bodyJsonLen = dv.getUint32(OUT_BODY_JSON_LEN, true)

    const preflightAllowed = (flags & FLAG_IS_PREFLIGHT) !== 0 && (flags & FLAG_CORS_ALLOWED) !== 0

    const normalizedStatus = normalizeResponseStatus(rawStatus, rawErrorCode, preflightAllowed)

    const uninitialized = rawVerdict === 0 && rawErrorCode === 0 && rawStatus === 0 && flags === 0

    if (uninitialized) {
      this.status = 500
      this.verdict = 1
      this.errorCode = ERR_CODE_INTERNAL
    } else {
      this.status = normalizedStatus
      this.verdict = rawVerdict
      this.errorCode = rawErrorCode
    }

    this.flags = flags
    this.rateLimit = rateLimit
    this.rateRemaining = rateRemaining

    this.setRateWindow(rateLimit, (flags & FLAG_RATE_LIMITED) !== 0, dv)

    this.headerVariant = headerVariant

    this.updateOkTerminal()

    this.https = (flags & FLAG_HTTPS) !== 0
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0
    this.hasCookies = (flags & FLAG_HAS_COOKIES) !== 0
    this.hasQuery = (flags & FLAG_HAS_QUERY) !== 0
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0
    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0

    // Bounds-checked section offsets shared with the pre-baked decoder: a
    // malformed/truncated buffer can never produce slices past its end.
    const layout = sectionLayout(buf.byteLength, cookiesJsonLen, queryJsonLen, bodyJsonLen)

    // Store slices for lazy decode instead of eagerly decoding strings. The
    // fast path trusts the RAW declared body length and re-checks bounds on
    // read (bodyJson()), so pass the raw declared length here.
    this.setSections(buf, layout, bodyJsonLen)

    // Parity with the baked decoder: any declared section (cookies, query,
    // OR body) that overran the buffer counts as truncated.
    this.bodyTruncated = (flags & FLAG_BODY_TRUNCATED) !== 0 || layout.truncated
  }

  invalidate(): void {
    this.resetShared()
    // Fast path's empty state is an internal-error shape (500/1/internal).
    this.status = 500
    this.verdict = 1
    this.errorCode = ERR_CODE_INTERNAL
    this.flags = 0
    this.https = false
    this.hasCookies = false
    this.hasQuery = false
    this.rateLimit = 0
    this.requestId = ''
  }

  setInternalError(requestId: string): void {
    this.invalidate()
    this.requestId = requestId
  }

  /** Bounds-checked body-JSON section, or an empty view when absent. */
  bodyJson(): Uint8Array {
    return this.bodyJsonSlice()
  }
}
