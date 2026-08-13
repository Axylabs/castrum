// src/ingress/decode/baked-result.ts — Zero-alloc result decoder (pre-baked
// path).
//
// Decodes the native Ingress packed output (OUT_* layout in ./constants.ts)
// into the pre-baked handler result, which carries the benchmark wire format
// ({"ok":false,"error":{...}}).
//
// NOTE: this is the pre-baked-path decoder with its own status normalization.
// The fast path has its own decoder (./fast-result.ts) — do not unify them
// (see AGENTS.md). The two decoders DO share their section/rate-limit plumbing
// via ./result-base.ts.

import {
  OUT_VERDICT,
  OUT_FLAGS,
  OUT_RATE_LIMIT,
  OUT_RATE_REMAINING,
  OUT_COOKIES_JSON_LEN,
  OUT_QUERY_JSON_LEN,
  OUT_HEADER_VARIANT,
  OUT_BODY_JSON_LEN,
  OUT_DATA_START,
  FLAG_BODY_VALID_JSON,
  FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED,
  FLAG_IS_PREFLIGHT,
  FLAG_RATE_LIMITED,
  FLAG_TRUSTED_PROXY,
  FLAG_BODY_TRUNCATED,
  HV_JSON,
  ERR_CODE_INTERNAL as ERROR_CODE_INTERNAL,
} from '../constants'
import { sectionLayout } from './packed-sections'
import { isValidResponseStatus } from '../status'
import { IngressResultBase } from './result-base'

/** Zero-alloc, reusable result decoder for the pre-baked handler path. */
export class BakedIngressResult extends IngressResultBase {
  refresh(buf: Uint8Array, body: Uint8Array, view: DataView): void {
    // Defensive: the native core always writes the full fixed header
    // (>= OUT_DATA_START bytes) before returning `written`. The cached
    // whole-buffer DataView (see viewForArrayBuffer) would otherwise decode
    // stale bytes if this contract is ever violated — treat as internal error.
    if (buf.byteLength < OUT_DATA_START) {
      this.setInternalError()
      return
    }
    this.body = body

    const h0 = view.getUint32(OUT_VERDICT, true)
    const h1 = view.getUint32(OUT_FLAGS, true)
    const h2 = view.getUint32(OUT_RATE_LIMIT, true)
    const h3 = view.getUint32(OUT_RATE_REMAINING, true)

    const cookiesLenRaw = view.getUint32(OUT_COOKIES_JSON_LEN, true)
    const queryLenRaw = view.getUint32(OUT_QUERY_JSON_LEN, true)
    const headerVariant = view.getUint8(OUT_HEADER_VARIANT)
    const bodyJsonLenRaw = view.getUint32(OUT_BODY_JSON_LEN, true)

    // Bounds-checked section offsets shared with the fast decoder: a
    // malformed/truncated buffer can never produce slices past its end.
    const layout = sectionLayout(buf.byteLength, cookiesLenRaw, queryLenRaw, bodyJsonLenRaw)

    if (h0 === 0 && h1 === 0) {
      this.verdict = 1
      this.errorCode = ERROR_CODE_INTERNAL
      this.status = 500
    } else {
      this.verdict = h0 & 0xff
      this.errorCode = (h0 >>> 8) & 0xff

      const rawStatus = (h0 >>> 16) & 0xffff
      // Reuse the shared status-validity helper instead of re-inlining the
      // 101/200-599 check (single source of truth in ../status.ts).
      this.status = isValidResponseStatus(rawStatus) ? rawStatus : 500
    }

    const flags = h1

    this.rateRemaining = h3

    this.setRateWindow(h2, (flags & FLAG_RATE_LIMITED) !== 0, view)

    this.headerVariant = headerVariant

    // The baked path trusts the already-clamped section lengths, so pass the
    // safe body len here (the fast path re-checks bounds on read instead).
    this.setSections(buf, layout, layout.safeBodyJsonLen)

    this.updateOkTerminal()

    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0

    this.bodyTruncated = (flags & FLAG_BODY_TRUNCATED) !== 0 || layout.truncated
  }

  invalidate(): void {
    // The baked empty state is neutral (0/0/0) — exactly what resetShared sets.
    this.resetShared()
  }

  setInternalError(): void {
    this.invalidate()
    this.status = 500
    this.verdict = 1
    this.errorCode = ERROR_CODE_INTERNAL
    this.headerVariant = HV_JSON
    this.terminal = true
    this.ok = false
  }

  bodyJson(copy: boolean): Uint8Array {
    const slice = this.bodyJsonSlice()
    return (copy ? slice.slice() : slice) as Uint8Array
  }
}
