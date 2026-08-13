// src/ingress/packing/scratch.ts — Shared thread-local scratch header buffers.
//
// Both the fast path (`packHeaders` in header-packing.ts) and the pre-baked
// path (`gatherRawHeadersPacked` in gather-raw-headers.ts) pack request
// headers into a reusable Uint8Array. This thread-local pool isolates the
// buffer per call-site sequence and bounds the number of cached buffers,
// keeping the hot path allocation-free.

/** Scratch capacity for the reusable packed-header buffer. */
export const HEADER_BUF_SIZE = 8192

// ── Per-header size guards (SHARED by BOTH packing paths) ─────────
// A header value larger than the bound below is dropped BEFORE packing rather
// than forwarded. Without guards the fast path (`packHeaders`) forwarded any
// size, so an oversized cookie/xff/origin could push the packed block past the
// native `max_headers_bytes` (65536) and fail with a 500, while the pre-baked
// path silently dropped the same header. Both paths must share ONE policy;
// keep the Rust `max_headers_bytes` bound in mind when changing these.
/** Upper bound for the `cookie` header value. */
export const MAX_COOKIE_HEADER_BYTES = 8192
/** Upper bound for small single-value headers (origin, ACRM, ACRH, ...). */
export const MAX_SMALL_HEADER_BYTES = 2048
/** Upper bound for the `x-forwarded-for` header value. */
export const MAX_XFF_HEADER_BYTES = 8192

// Thread-local header buffer for per-call isolation (round-robin over a
// bounded pool; each buffer is only borrowed for the duration of one
// pack/gather call).
const [getHeaderBuf] = (() => {
  const tls: [Uint8Array, DataView][] = []
  const MAX_CACHED = 256
  let tlsIdx = 0

  function acquire(): [Uint8Array, DataView] {
    const cached = tls[tlsIdx]
    tlsIdx = (tlsIdx + 1) % MAX_CACHED
    if (cached) return cached

    const buf = new Uint8Array(HEADER_BUF_SIZE)
    const view = new DataView(buf.buffer)
    const pair: [Uint8Array, DataView] = [buf, view]
    tls.push(pair)
    return pair
  }

  return [acquire]
})()

/** Acquire the next scratch header buffer + view from the thread-local pool. */
export { getHeaderBuf }
