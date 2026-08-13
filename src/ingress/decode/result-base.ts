// src/ingress/decode/result-base.ts — Shared zero-alloc decoder plumbing.
//
// Both ingress result decoders (fast-result.ts, baked-result.ts) walk the SAME
// native OUT_* layout and share: lazy cookie/query JSON section decoding, the
// bounds-checked body-JSON slice, the rate-limit window fields, and the
// flag-derived booleans. This base holds that identical plumbing so the two
// paths cannot drift on section handling.
//
// The WIRE FORMAT and STATUS NORMALIZATION intentionally differ between the
// two decoders ({"error":{...}} fast path vs {"ok":false,...} baked path) —
// those stay in the subclasses (see AGENTS.md; do not unify them).

import { decoder } from '../../shared/bytes'
import { OUT_DATA_START, OUT_RATE_RESET, OUT_RETRY_AFTER } from '../constants'
import type { PackedSectionLayout } from './packed-sections'

const EMPTY_BODY = new Uint8Array(0)

/**
 * Zero-alloc, reusable result decoder shared base.
 *
 * Holds the fields and lazy-decoding helpers that both the fast-path
 * (`FastIngressResult`) and pre-baked (`BakedIngressResult`) decoders consume
 * identically from the native OUT_* output buffer. Concrete subclasses own the
 * status normalization, the exposed extras (requestId, flags, ...) and the
 * wire-format-specific body/error accessors.
 */
export abstract class IngressResultBase {
  /** Raw native verdict byte (0 = accepted). */
  verdict = 0
  /** Raw native error-code byte. */
  errorCode = 0
  /** Normalized HTTP status. */
  status = 0
  /** Header template variant byte emitted by the native core. */
  headerVariant = 0
  /** Remaining rate-limit budget (count). */
  rateRemaining = 0
  /** Rate-limit window reset (ms epoch). */
  rateResetMs = 0
  /** Retry-After value (ms). */
  retryAfterMs = 0
  /** True when the pipeline returned a terminal (error) verdict. */
  terminal = true
  /** True when the pipeline accepted the request (verdict 0 + 2xx/3xx). */
  ok = false
  /** True when the request was a CORS preflight. */
  isPreflight = false
  /** True when the CORS engine allowed the request origin. */
  corsAllowed = false
  /** True when the request was rate-limited. */
  rateLimited = false
  /** True when the request came from a trusted proxy. */
  trustedProxy = false
  /** True when the request body parsed as valid JSON. */
  bodyValidJson = false
  /** True when the request body validated against the ingress schema. */
  schemaValid = false
  /** True when a declared output section overran the buffer. */
  bodyTruncated = false
  /** Request body bytes (may be an empty view). */
  body: Uint8Array = EMPTY_BODY

  protected _buf: Uint8Array = EMPTY_BODY
  protected _bodyJsonStart = OUT_DATA_START
  protected _bodyJsonLen = 0
  private _cookiesBuf: Uint8Array | null = null
  private _queryBuf: Uint8Array | null = null
  private _cookiesDecoded: string | null = null
  private _queryDecoded: string | null = null

  /** Reset the shared fields to their empty state (call from subclass `invalidate`). */
  protected resetShared(): void {
    this.verdict = 0
    this.errorCode = 0
    this.status = 0
    this.headerVariant = 0
    this.rateRemaining = 0
    this.rateResetMs = 0
    this.retryAfterMs = 0
    this.terminal = true
    this.ok = false
    this.isPreflight = false
    this.corsAllowed = false
    this.rateLimited = false
    this.trustedProxy = false
    this.bodyValidJson = false
    this.schemaValid = false
    this.bodyTruncated = false
    this.body = EMPTY_BODY
    this._buf = EMPTY_BODY
    this._bodyJsonStart = OUT_DATA_START
    this._bodyJsonLen = 0
    this._cookiesBuf = null
    this._queryBuf = null
    this._cookiesDecoded = null
    this._queryDecoded = null
  }

  /** Recompute `terminal`/`ok` from the (subclass-set) verdict + status. */
  protected updateOkTerminal(): void {
    this.terminal = this.verdict !== 0 || this.status >= 400
    this.ok = this.verdict === 0 && this.status >= 200 && this.status < 400
  }

  /**
   * Store the rate-limit window fields. Both decoders read the same OUT_*
   * slots and gate them on the same conditions (a positive budget OR the
   * rate-limited flag), so the read cannot drift between paths.
   */
  protected setRateWindow(rateLimit: number, rateLimited: boolean, view: DataView): void {
    if (rateLimit > 0 || rateLimited) {
      this.rateResetMs = Number(view.getBigUint64(OUT_RATE_RESET, true))
      this.retryAfterMs = Number(view.getBigUint64(OUT_RETRY_AFTER, true))
    } else {
      this.rateResetMs = 0
      this.retryAfterMs = 0
    }
  }

  /**
   * Store the bounds-checked cookie/query/body JSON sections from `layout`.
   *
   * `bodyJsonLen` is the body-JSON length to trust for `bodyJson()`: the fast
   * path passes the RAW declared length (it re-checks bounds on read), the
   * baked path passes the already-clamped `layout.safeBodyJsonLen`. Sections
   * are stored as slices and decoded lazily by `cookiesJson()`/`queryJson()`.
   */
  protected setSections(buf: Uint8Array, layout: PackedSectionLayout, bodyJsonLen: number): void {
    this._buf = buf
    this._bodyJsonStart = layout.bodyJsonStart
    this._bodyJsonLen = bodyJsonLen
    this._cookiesBuf =
      layout.safeCookiesLen > 0
        ? buf.subarray(OUT_DATA_START, OUT_DATA_START + layout.safeCookiesLen)
        : null
    this._cookiesDecoded = null
    this._queryBuf =
      layout.safeQueryLen > 0
        ? buf.subarray(layout.queryStart, layout.queryStart + layout.safeQueryLen)
        : null
    this._queryDecoded = null
  }

  /** Decoded cookies-JSON section, or `"{}"` when absent. */
  cookiesJson(): string {
    if (this._cookiesDecoded !== null) return this._cookiesDecoded
    if (this._cookiesBuf !== null) {
      this._cookiesDecoded = decoder.decode(this._cookiesBuf)
      return this._cookiesDecoded
    }
    return '{}'
  }

  /** Decoded query-JSON section, or `"{}"` when absent. */
  queryJson(): string {
    if (this._queryDecoded !== null) return this._queryDecoded
    if (this._queryBuf !== null) {
      this._queryDecoded = decoder.decode(this._queryBuf)
      return this._queryDecoded
    }
    return '{}'
  }

  /** Bounds-checked body-JSON slice (empty when absent / out of range). */
  protected bodyJsonSlice(): Uint8Array {
    if (this._bodyJsonLen === 0) return EMPTY_BODY
    const end = this._bodyJsonStart + this._bodyJsonLen
    if (end > this._buf.byteLength) return EMPTY_BODY
    return this._buf.subarray(this._bodyJsonStart, end)
  }
}
