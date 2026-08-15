// src/ingress/packing/select-headers.ts — Shared header-selection iterator.
//
// Single source of truth for "which headers does a HeaderPlan select" across
// the TWO packing paths (a string-array reference variant lives test-local in
// header-packing.test.ts):
//   - `packHeaders`             (fast path, ./header-packing.ts)
//   - `gatherRawHeadersPacked`  (pre-baked packed path, ./gather-raw-headers.ts)
//
// Both apply the SAME selection rules and the SAME per-header size guards
// (an oversized value is dropped rather than forwarded, so the packed block can
// never exceed the native `max_headers_bytes` (65536) and 500). This module
// owns that logic plus the pre-encoded header-name bytes, so a rule or size
// change cannot drift between the paths.

import { encoder } from '../../shared/bytes'
import { type HeaderPlan, METHOD_KIND } from '../shared'
import { MAX_COOKIE_HEADER_BYTES, MAX_SMALL_HEADER_BYTES, MAX_XFF_HEADER_BYTES } from './scratch'

// ── Header name constants (pre-encoded) ────────────────────────
/** Pre-encoded `cookie` header name. */
export const HDR_COOKIE = encoder.encode('cookie')
/** Pre-encoded `origin` header name. */
export const HDR_ORIGIN = encoder.encode('origin')
/** Pre-encoded `access-control-request-method` header name. */
export const HDR_ACRM = encoder.encode('access-control-request-method')
/** Pre-encoded `access-control-request-headers` header name. */
export const HDR_ACRH = encoder.encode('access-control-request-headers')
/** Pre-encoded `x-forwarded-for` header name. */
export const HDR_XFF = encoder.encode('x-forwarded-for')
/** Pre-encoded `x-real-ip` header name. */
export const HDR_XRI = encoder.encode('x-real-ip')
/** Pre-encoded `x-forwarded-proto` header name. */
export const HDR_XFP = encoder.encode('x-forwarded-proto')

/**
 * Visit every request header selected by `plan` (cookie, origin + CORS
 * preflight method/headers, proxy XFF/XRI, proto XFP), applying the shared
 * per-header size guards from scratch.ts. Callers supply `visit(name, value)`
 * with the pre-encoded header-name bytes; no intermediate array is allocated.
 *
 * @param originValue - When provided (non-undefined), the already-fetched
 *   `Origin` header value, avoiding a second `req.headers.get('origin')`
 *   native→JS conversion on the hot path (the caller, e.g. `handlers.ts::run`,
 *   already fetched it once for `ctx.origin`). When omitted, the origin is
 *   fetched here. The same `MAX_SMALL_HEADER_BYTES` guard applies either way.
 * @param visit - Invoked once per selected header with the pre-encoded name
 *   bytes and the raw value string.
 */
export function forEachSelectedHeader(
  req: Request,
  plan: HeaderPlan,
  methodKind: number,
  originValue: string | null | undefined,
  visit: (name: Uint8Array, value: string) => void,
): void {
  const h = req.headers

  if (plan.cookie) {
    const v = h.get('cookie')
    if (v !== null && v.length <= MAX_COOKIE_HEADER_BYTES) {
      visit(HDR_COOKIE, v)
    }
  }

  if (plan.cors) {
    const originV = originValue !== undefined ? originValue : h.get('origin')
    if (originV !== null && originV.length <= MAX_SMALL_HEADER_BYTES) {
      visit(HDR_ORIGIN, originV)
    }

    if (methodKind === METHOD_KIND.OPTIONS) {
      const acrm = h.get('access-control-request-method')
      if (acrm !== null && acrm.length <= MAX_SMALL_HEADER_BYTES) {
        visit(HDR_ACRM, acrm)
      }

      const acrh = h.get('access-control-request-headers')
      if (acrh !== null && acrh.length <= MAX_SMALL_HEADER_BYTES) {
        visit(HDR_ACRH, acrh)
      }
    }
  }

  if (plan.proxy) {
    const xff = h.get('x-forwarded-for')
    if (xff !== null && xff.length <= MAX_XFF_HEADER_BYTES) {
      visit(HDR_XFF, xff)
    }

    const xri = h.get('x-real-ip')
    if (xri !== null && xri.length <= MAX_SMALL_HEADER_BYTES) {
      visit(HDR_XRI, xri)
    }
  }

  if (plan.proto) {
    const xfp = h.get('x-forwarded-proto')
    if (xfp !== null && xfp.length <= MAX_SMALL_HEADER_BYTES) {
      visit(HDR_XFP, xfp)
    }
  }
}
