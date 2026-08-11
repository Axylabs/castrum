// src/ingress/decode/baked-result.ts — Zero-alloc result decoder (pre-baked
// path).
//
// Decodes the native Ingress packed output (OUT_* layout in ./constants.ts)
// into the pre-baked handler result, which carries the benchmark wire format
// ({"ok":false,"error":{...}}).
//
// NOTE: this is the pre-baked-path decoder with its own status normalization.
// The fast path has its own decoder (./fast-result.ts) — do not unify them
// (see AGENTS.md).

import {
  OUT_VERDICT, OUT_FLAGS, OUT_RATE_LIMIT, OUT_RATE_REMAINING, OUT_RATE_RESET,
  OUT_RETRY_AFTER, OUT_COOKIES_JSON_LEN, OUT_QUERY_JSON_LEN, OUT_HEADER_VARIANT,
  OUT_BODY_JSON_LEN, OUT_DATA_START,
  FLAG_BODY_VALID_JSON, FLAG_SCHEMA_VALID, FLAG_CORS_ALLOWED, FLAG_IS_PREFLIGHT,
  FLAG_RATE_LIMITED, FLAG_TRUSTED_PROXY, FLAG_BODY_TRUNCATED,
  HV_JSON,
  ERR_CODE_INTERNAL as ERROR_CODE_INTERNAL,
} from "../constants";
import { sectionLayout } from "./packed-sections";

const EMPTY_BODY = new Uint8Array(0);

/** Zero-alloc, reusable result decoder for the pre-baked handler path. */
export class BakedIngressResult {
  status = 0;
  verdict = 0;
  errorCode = 0;
  headerVariant = 0;
  rateRemaining = 0;
  rateResetMs = 0;
  retryAfterMs = 0;
  terminal = true;
  ok = false;
  isPreflight = false;
  corsAllowed = false;
  rateLimited = false;
  trustedProxy = false;
  bodyValidJson = false;
  schemaValid = false;
  bodyTruncated = false;
  body: Uint8Array = EMPTY_BODY;

  private _buf: Uint8Array = EMPTY_BODY;
  private _bodyJsonStart = OUT_DATA_START;
  private _bodyJsonLen = 0;

  refresh(buf: Uint8Array, body: Uint8Array, view: DataView): void {
    // Defensive: the native core always writes the full fixed header
    // (>= OUT_DATA_START bytes) before returning `written`. The cached
    // whole-buffer DataView (see viewForArrayBuffer) would otherwise decode
    // stale bytes if this contract is ever violated — treat as internal error.
    if (buf.byteLength < OUT_DATA_START) {
      this.setInternalError();
      return;
    }
    this._buf = buf;
    this.body = body;

    const h0 = view.getUint32(OUT_VERDICT, true);
    const h1 = view.getUint32(OUT_FLAGS, true);
    const h2 = view.getUint32(OUT_RATE_LIMIT, true);
    const h3 = view.getUint32(OUT_RATE_REMAINING, true);

    const cookiesLenRaw = view.getUint32(OUT_COOKIES_JSON_LEN, true);
    const queryLenRaw = view.getUint32(OUT_QUERY_JSON_LEN, true);
    const headerVariant = view.getUint8(OUT_HEADER_VARIANT);
    const bodyJsonLenRaw = view.getUint32(OUT_BODY_JSON_LEN, true);

    // Bounds-checked section offsets shared with the fast decoder: a
    // malformed/truncated buffer can never produce slices past its end.
    const layout = sectionLayout(
      buf.byteLength,
      cookiesLenRaw,
      queryLenRaw,
      bodyJsonLenRaw,
    );

    if (h0 === 0 && h1 === 0) {
      this.verdict = 1;
      this.errorCode = ERROR_CODE_INTERNAL;
      this.status = 500;
    } else {
      this.verdict = h0 & 0xff;
      this.errorCode = (h0 >>> 8) & 0xff;

      const rawStatus = (h0 >>> 16) & 0xffff;
      const validStatus =
        rawStatus === 101 || (rawStatus >= 200 && rawStatus <= 599);
      this.status = validStatus ? rawStatus : 500;
    }

    const flags = h1;

    this.rateRemaining = h3;

    if (h2 > 0 || (flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(view.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(view.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }

    this.headerVariant = headerVariant;
    this._bodyJsonStart = layout.bodyJsonStart;
    this._bodyJsonLen = layout.safeBodyJsonLen;

    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status >= 200 && this.status < 400;

    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0;
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0;
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0;
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0;
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0;

    this.bodyTruncated =
      (flags & FLAG_BODY_TRUNCATED) !== 0 || layout.truncated;
  }

  invalidate(): void {
    this.status = 0;
    this.verdict = 0;
    this.errorCode = 0;
    this.headerVariant = 0;
    this.rateRemaining = 0;
    this.rateResetMs = 0;
    this.retryAfterMs = 0;
    this.terminal = true;
    this.ok = false;
    this.isPreflight = false;
    this.corsAllowed = false;
    this.rateLimited = false;
    this.trustedProxy = false;
    this.bodyValidJson = false;
    this.schemaValid = false;
    this.bodyTruncated = false;
    this.body = EMPTY_BODY;
    this._buf = EMPTY_BODY;
    this._bodyJsonStart = OUT_DATA_START;
    this._bodyJsonLen = 0;
  }

  setInternalError(): void {
    this.invalidate();
    this.status = 500;
    this.verdict = 1;
    this.errorCode = ERROR_CODE_INTERNAL;
    this.headerVariant = HV_JSON;
    this.terminal = true;
    this.ok = false;
  }

  bodyJson(copy: boolean): Uint8Array {
    if (this._bodyJsonLen === 0) {
      return EMPTY_BODY;
    }

    const end = this._bodyJsonStart + this._bodyJsonLen;
    if (end > this._buf.byteLength) {
      return EMPTY_BODY;
    }

    const slice = this._buf.subarray(this._bodyJsonStart, end);
    return (copy ? slice.slice() : slice) as Uint8Array;
  }
}
