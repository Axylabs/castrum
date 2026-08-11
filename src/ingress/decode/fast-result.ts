// src/ingress/decode/fast-result.ts — Zero-alloc result decoder (fast path).
//
// Decodes the native Ingress packed output (OUT_* layout in ./constants.ts)
// lazily: slices are stored, strings are decoded only on demand via
// cookiesJson()/queryJson()/bodyJson().
//
// NOTE: this is the fast-path decoder ({"error":{...}} wire format). The
// pre-baked path has its own decoder (./baked-result.ts) with a different
// wire format and status normalization — do not unify them (see AGENTS.md).

import { decoder, viewForArrayBuffer } from "../../shared/bytes";
import {
  OUT_VERDICT, OUT_ERROR_CODE, OUT_STATUS, OUT_FLAGS,
  OUT_RATE_LIMIT, OUT_RATE_REMAINING, OUT_RATE_RESET, OUT_RETRY_AFTER,
  OUT_COOKIES_JSON_LEN, OUT_QUERY_JSON_LEN, OUT_HEADER_VARIANT, OUT_BODY_JSON_LEN,
  OUT_DATA_START,
  FLAG_HAS_COOKIES, FLAG_HAS_QUERY,
  FLAG_BODY_VALID_JSON, FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED, FLAG_IS_PREFLIGHT, FLAG_RATE_LIMITED,
  FLAG_HTTPS, FLAG_TRUSTED_PROXY, FLAG_BODY_TRUNCATED,
  ERR_CODE_INTERNAL,
} from "../constants";
import { normalizeResponseStatus } from "../status";
import { sectionLayout } from "./packed-sections";

const EMPTY_BODY = new Uint8Array(0);

/** Zero-alloc, lazy-decoding view over a native Ingress output buffer. */
export class FastIngressResult {
  status = 500;
  verdict = 1;
  flags = 0;
  errorCode = ERR_CODE_INTERNAL;
  terminal = true;
  ok = false;
  https = false;
  trustedProxy = false;
  hasCookies = false;
  hasQuery = false;
  bodyValidJson = false;
  schemaValid = false;
  corsAllowed = false;
  isPreflight = false;
  rateLimited = false;
  rateLimit = 0;
  rateRemaining = 0;
  rateResetMs = 0;
  retryAfterMs = 0;
  body: Uint8Array = EMPTY_BODY;
  headerVariant = 0;
  requestId = "";
  bodyTruncated = false;

  // Lazy-decoded cookie/query JSON
  private _buf: Uint8Array = EMPTY_BODY;
  private _bodyJsonStart = OUT_DATA_START;
  private _bodyJsonLen = 0;
  private _cookiesBuf: Uint8Array | null = null;
  private _queryBuf: Uint8Array | null = null;
  private _cookiesDecoded: string | null = null;
  private _queryDecoded: string | null = null;

  refresh(buf: Uint8Array, body: Uint8Array, requestId: string): void {
    // Defensive: the native core always writes the full fixed header
    // (>= OUT_DATA_START bytes) before returning `written`. The cached
    // whole-buffer DataView below would otherwise decode stale bytes if this
    // contract is ever violated — treat it as an internal error instead.
    if (buf.byteLength < OUT_DATA_START) {
      this.setInternalError(requestId);
      return;
    }
    this._buf = buf;
    this.body = body;
    this.requestId = requestId;

    // Cached per-ArrayBuffer DataView (respects the subarray byteOffset): no
    // per-request view alloc on the offset-0 production buffers.
    const dv = viewForArrayBuffer(buf.buffer, buf.byteOffset);

    const rawVerdict = dv.getUint8(OUT_VERDICT);
    const rawErrorCode = dv.getUint8(OUT_ERROR_CODE);
    const rawStatus = dv.getUint16(OUT_STATUS, true);
    const flags = dv.getUint32(OUT_FLAGS, true);

    const rateLimit = dv.getUint32(OUT_RATE_LIMIT, true);
    const rateRemaining = dv.getUint32(OUT_RATE_REMAINING, true);

    const cookiesJsonLen = dv.getUint32(OUT_COOKIES_JSON_LEN, true);
    const queryJsonLen = dv.getUint32(OUT_QUERY_JSON_LEN, true);

    const headerVariant = dv.getUint8(OUT_HEADER_VARIANT);
    const bodyJsonLen = dv.getUint32(OUT_BODY_JSON_LEN, true);

    const preflightAllowed =
      (flags & FLAG_IS_PREFLIGHT) !== 0 && (flags & FLAG_CORS_ALLOWED) !== 0;

    const normalizedStatus = normalizeResponseStatus(
      rawStatus,
      rawErrorCode,
      preflightAllowed,
    );

    const uninitialized =
      rawVerdict === 0 && rawErrorCode === 0 && rawStatus === 0 && flags === 0;

    if (uninitialized) {
      this.status = 500;
      this.verdict = 1;
      this.errorCode = ERR_CODE_INTERNAL;
    } else {
      this.status = normalizedStatus;
      this.verdict = rawVerdict;
      this.errorCode = rawErrorCode;
    }

    this.flags = flags;
    this.rateLimit = rateLimit;
    this.rateRemaining = rateRemaining;

    if (rateLimit > 0 || (flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(dv.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(dv.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }

    this.headerVariant = headerVariant;
    this._bodyJsonLen = bodyJsonLen;

    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status >= 200 && this.status < 400;

    this.https = (flags & FLAG_HTTPS) !== 0;
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0;
    this.hasCookies = (flags & FLAG_HAS_COOKIES) !== 0;
    this.hasQuery = (flags & FLAG_HAS_QUERY) !== 0;
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0;
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0;
    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0;
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0;

    // Bounds-checked section offsets shared with the pre-baked decoder: a
    // malformed/truncated buffer can never produce slices past its end.
    const layout = sectionLayout(
      buf.byteLength,
      cookiesJsonLen,
      queryJsonLen,
      bodyJsonLen,
    );

    // Store slices for lazy decode instead of eagerly decoding strings
    this._cookiesBuf = layout.safeCookiesLen > 0
      ? buf.subarray(OUT_DATA_START, OUT_DATA_START + layout.safeCookiesLen)
      : null;
    this._cookiesDecoded = null;

    this._queryBuf = layout.safeQueryLen > 0
      ? buf.subarray(layout.queryStart, layout.queryStart + layout.safeQueryLen)
      : null;
    this._queryDecoded = null;

    this._bodyJsonStart = layout.bodyJsonStart;

    // Parity with the baked decoder: any declared section (cookies, query,
    // OR body) that overran the buffer counts as truncated.
    this.bodyTruncated =
      (flags & FLAG_BODY_TRUNCATED) !== 0 || layout.truncated;
  }

  invalidate(): void {
    this.status = 500;
    this.verdict = 1;
    this.flags = 0;
    this.errorCode = ERR_CODE_INTERNAL;
    this.terminal = true;
    this.ok = false;
    this.https = false;
    this.trustedProxy = false;
    this.hasCookies = false;
    this.hasQuery = false;
    this.bodyValidJson = false;
    this.schemaValid = false;
    this.corsAllowed = false;
    this.isPreflight = false;
    this.rateLimited = false;
    this.rateLimit = 0;
    this.rateRemaining = 0;
    this.rateResetMs = 0;
    this.retryAfterMs = 0;
    this.body = EMPTY_BODY;
    this.headerVariant = 0;
    this.requestId = "";
    this.bodyTruncated = false;

    this._buf = EMPTY_BODY;
    this._bodyJsonLen = 0;
    this._bodyJsonStart = OUT_DATA_START;
    this._cookiesBuf = null;
    this._queryBuf = null;
    this._cookiesDecoded = null;
    this._queryDecoded = null;
  }

  setInternalError(requestId: string): void {
    this.invalidate();
    this.requestId = requestId;
  }

  cookiesJson(): string {
    if (this._cookiesDecoded !== null) return this._cookiesDecoded;
    if (this._cookiesBuf !== null) {
      this._cookiesDecoded = decoder.decode(this._cookiesBuf);
      return this._cookiesDecoded;
    }
    return "{}";
  }

  queryJson(): string {
    if (this._queryDecoded !== null) return this._queryDecoded;
    if (this._queryBuf !== null) {
      this._queryDecoded = decoder.decode(this._queryBuf);
      return this._queryDecoded;
    }
    return "{}";
  }

  bodyJson(): Uint8Array {
    if (this._bodyJsonLen === 0) return EMPTY_BODY;

    const end = this._bodyJsonStart + this._bodyJsonLen;

    if (end > this._buf.byteLength) {
      return EMPTY_BODY;
    }

    return this._buf.subarray(this._bodyJsonStart, end);
  }
}
