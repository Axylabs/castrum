// src/ingress/packing/gather-raw-headers.ts — Raw header gathering (pre-baked
// path).
//
// The pre-baked path passes headers to the native addon as a plain
// [name, value][] array (the addon packs them internally in Rust). This module
// extracts exactly the headers selected by a HeaderPlan, with per-header size
// guards so oversized values are dropped rather than forwarded.

import type { HeaderPlan } from '../shared'
import { METHOD_KIND } from '../shared'
import { writeHeaderPair } from './header-packing'
import { forEachSelectedHeader, HDR_ORIGIN } from './select-headers'
import { getHeaderBuf, MAX_SMALL_HEADER_BYTES } from './scratch'

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
 * A plan that selects NO headers (no cookie/cors/proxy/proto) short-circuits
 * to a shared empty block — skipping the scratch-buffer round-robin, the
 * `setUint16` and the per-call `subarray` entirely (the common minimal-route
 * case).
 *
 * A CORS-ONLY plan on a non-preflight request (the dominant minimal-route
 * case, e.g. the benchmark server) produces a block that depends ONLY on the
 * `Origin` header value — which is constant per deployment. Such blocks are
 * cached keyed by origin, so the per-request UTF-8 encode of the origin (the
 * largest single JS packing cost) and the scratch write are skipped entirely;
 * the cache is bounded (FIFO eviction) so multi-origin deployments stay safe.
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
  if (!plan.cookie && !plan.cors && !plan.proxy && !plan.proto) {
    return EMPTY_HEADERS_BLOCK
  }

  // CORS-only fast path: the only selected header is the (typically constant)
  // Origin, so the whole packed block is a pure function of the origin string.
  // Skip the per-request encode + scratch write by returning the cached block.
  // Preflight (OPTIONS) is excluded — it also packs ACRM/ACRH and must take
  // the general path. The MAX_SMALL_HEADER_BYTES guard mirrors the general
  // path (an oversized origin is dropped → empty block, not cached).
  if (plan.cors && !plan.cookie && !plan.proxy && !plan.proto && methodKind !== METHOD_KIND.OPTIONS) {
    const origin = originValue !== undefined ? originValue : req.headers.get('origin')
    if (origin === null || origin.length > MAX_SMALL_HEADER_BYTES) {
      return EMPTY_HEADERS_BLOCK
    }
    return cachedOriginBlock(origin)
  }

  let [buf, view] = getHeaderBuf()
  let pos = 2
  let count = 0

  const write = (name: Uint8Array, value: string): void => {
    ;[pos, buf, view] = writeHeaderPair(buf, view, pos, name, value)
    count++
  }

  forEachSelectedHeader(req, plan, methodKind, originValue, write)

  // No selected header was actually present (e.g. a route with cookie+cors in
  // its plan but a request that sends neither) — return the shared empty block
  // instead of touching the scratch buffer again (setUint16 + subarray) on the
  // hot path.
  if (count === 0) {
    return EMPTY_HEADERS_BLOCK
  }

  view.setUint16(0, count, true)
  return buf.subarray(0, pos)
}

/** Shared `[0, 0]` (zero headers) block — returned when a plan selects nothing.
 *  Callers treat the result as read-only (the packers copy it verbatim). */
const EMPTY_HEADERS_BLOCK = new Uint8Array(2)

/**
 * Cached packed blocks for the CORS-only case, keyed by origin string.
 * Bounded (FIFO eviction) — a multi-origin deployment never grows it
 * unboundedly, and a single-origin deployment hits a stable single entry.
 * Module state is per-thread in Bun workers, so no cross-thread aliasing.
 */
const ORIGIN_BLOCK_CACHE = new Map<string, Uint8Array>()
const ORIGIN_CACHE_MAX = 8

/**
 * Return (building and caching on first use) the packed header block for a
 * CORS-only plan whose only selected header is `origin`.
 *
 * The block is byte-identical to what the general path would produce
 * (`[u16 1][u16 name_len]['origin'][u32 val_len][value]`), built once with the
 * shared `writeHeaderPair` and copied out of the scratch buffer into a stable
 * allocation — never aliased to the round-robin scratch, so it stays valid
 * across subsequent gathers.
 */
function cachedOriginBlock(origin: string): Uint8Array {
  const hit = ORIGIN_BLOCK_CACHE.get(origin)
  if (hit !== undefined) return hit

  let [buf, view] = getHeaderBuf()
  let pos = 2
  ;[pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ORIGIN, origin)
  view.setUint16(0, 1, true)
  const block = buf.slice(0, pos)

  if (ORIGIN_BLOCK_CACHE.size >= ORIGIN_CACHE_MAX) {
    const firstKey = ORIGIN_BLOCK_CACHE.keys().next().value
    if (firstKey !== undefined) ORIGIN_BLOCK_CACHE.delete(firstKey)
  }
  ORIGIN_BLOCK_CACHE.set(origin, block)
  return block
}
