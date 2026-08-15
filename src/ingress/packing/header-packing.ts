// src/ingress/packing/header-packing.ts — Binary header packing (fast path).
//
// Packs the request headers selected by a HeaderPlan directly into a reusable
// Uint8Array with no intermediate strings. A bounded thread-local pool of
// scratch buffers keeps this allocation-free on the hot path while isolating
// the buffers per call-site sequence.

import { encoder } from '../../shared/bytes'
import { type HeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../shared'
import { getHeaderBuf } from './scratch'
import { forEachSelectedHeader } from './select-headers'

/**
 * Write one header pair into `buf`/`view`, growing them if needed.
 *
 * IMPORTANT: the header block can exceed `HEADER_BUF_SIZE` (e.g. a very large
 * cookie or origin header). When that happens `buf`/`view` are replaced by a
 * larger buffer, so the (possibly grown) buffer + view are returned alongside
 * the new position. Callers MUST thread the returned buffer/view back into
 * subsequent writes — otherwise the grown bytes are written into a discarded
 * array and the packed output is silently corrupted.
 */
export function writeHeaderPair(
  buf: Uint8Array,
  view: DataView,
  pos: number,
  name: Uint8Array,
  value: string,
): [pos: number, buf: Uint8Array, view: DataView] {
  const needed = 2 + name.length + 4 + value.length * 3
  if (pos + needed > buf.length) {
    const next = new Uint8Array(Math.max(buf.length * 2, pos + needed))
    next.set(buf.subarray(0, pos))
    buf = next
    view = new DataView(buf.buffer)
  }

  view.setUint16(pos, name.length, true)
  buf.set(name, pos + 2)
  pos += 2 + name.length

  const valueLenPos = pos
  pos += 4

  const dest = buf.subarray(pos)
  const { written } = encoder.encodeInto(value, dest)

  view.setUint32(valueLenPos, written, true)
  pos += written

  return [pos, buf, view]
}

/** Pack the headers selected by `plan` into a reusable Uint8Array. */
export function packHeaders(req: Request, plan: HeaderPlan): Uint8Array {
  let [buf, view] = getHeaderBuf()
  let pos = 2
  let count = 0

  // Selection rules + per-header size guards live in forEachSelectedHeader
  // (single source of truth shared with the pre-baked path): an oversized
  // value is dropped rather than forwarded so the packed block can never
  // exceed the native `max_headers_bytes` (65536) and 500.
  const write = (name: Uint8Array, value: string): void => {
    ;[pos, buf, view] = writeHeaderPair(buf, view, pos, name, value)
    count++
  }

  const methodKind = METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN
  forEachSelectedHeader(req, plan, methodKind, undefined, write)

  view.setUint16(0, count, true)
  return buf.subarray(0, pos)
}
