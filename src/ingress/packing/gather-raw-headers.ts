// src/ingress/packing/gather-raw-headers.ts — Raw header gathering (pre-baked
// path).
//
// The pre-baked path passes headers to the native addon as a plain
// [name, value][] array (the addon packs them internally in Rust). This module
// extracts exactly the headers selected by a HeaderPlan, with per-header size
// guards so oversized values are dropped rather than forwarded.

import type { HeaderPlan } from '../shared'
import { writeHeaderPair } from './header-packing'
import { forEachSelectedHeader } from './select-headers'
import { getHeaderBuf } from './scratch'

// Shared per-header size guards (single source of truth in scratch.ts).
// Re-exported for back-compat with imports that referenced them here.
export {
  MAX_COOKIE_HEADER_BYTES,
  MAX_SMALL_HEADER_BYTES,
  MAX_XFF_HEADER_BYTES,
} from './scratch'

/**
 * Gather the request headers selected by `plan` as a packed byte block
 * (`[u16 count] { [u16 name_len][name][u32 val_len][value] }`) written into a
 * reusable thread-local buffer.
 *
 * This is the zero-intermediate-string equivalent of the legacy string-array
 * header gathering (a test-local reference in header-packing.test.ts) for the
 * packed-input pipeline: identical header selection and per-header size
 * guards, but no `[string, string][]` array and no napi string marshaling.
 * The returned view is valid only until the next call on this call site.
 *
 * @param originValue - When provided (non-undefined), the already-fetched
 *   `Origin` header value to pack, avoiding a second `req.headers.get('origin')`
 *   native→JS string conversion per request on the hot path (the caller, e.g.
 *   `handlers.ts::run`, already fetched it once for `ctx.origin`). When
 *   omitted, the origin is fetched here as before (back-compat). The same
 *   `MAX_SMALL_HEADER_BYTES` size guard still applies either way.
 */
export function gatherRawHeadersPacked(
  req: Request,
  plan: HeaderPlan,
  methodKind: number,
  originValue?: string | null,
): Uint8Array {
  let [buf, view] = getHeaderBuf()
  let pos = 2
  let count = 0

  const write = (name: Uint8Array, value: string): void => {
    ;[pos, buf, view] = writeHeaderPair(buf, view, pos, name, value)
    count++
  }

  forEachSelectedHeader(req, plan, methodKind, originValue, write)

  view.setUint16(0, count, true)
  return buf.subarray(0, pos)
}
