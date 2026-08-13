/**
 * Shared TextEncoder instance for encoding strings to UTF-8 bytes.
 *
 * Reusing a single encoder avoids allocation overhead in hot paths.
 */
export const encoder = new TextEncoder()

/**
 * Shared TextDecoder instance for decoding UTF-8 bytes to strings.
 *
 * Reusing a single decoder avoids allocation overhead in hot paths.
 */
export const decoder = new TextDecoder()

/**
 * Cache of `DataView`s keyed by their backing buffer + creation offset.
 */
const dataViewCache = new WeakMap<ArrayBufferLike, { offset: number; view: DataView }>()

/**
 * Returns a `DataView` over `buffer` starting at `byteOffset`, creating and
 * caching it once per (backing buffer, byteOffset) pair.
 *
 * Hot ingress paths decode the native packed output through a `DataView` on
 * every request. The pooled/fixed output buffers are long-lived `Uint8Array`s
 * over stable `ArrayBuffer`s at `byteOffset` 0, so a single view per buffer is
 * reused across requests — eliminating one allocation per request. A
 * nonzero-offset subarray (e.g. a written-prefix view over a shared backing
 * buffer) gets its own view so reads stay aligned to the caller's start.
 *
 * @param buffer - The backing buffer to create (or reuse) a view for.
 * @param byteOffset - The start of the view within `buffer`. Default 0.
 * @returns A cached `DataView` over `buffer` starting at `byteOffset`.
 */
export function viewForArrayBuffer(buffer: ArrayBufferLike, byteOffset = 0): DataView {
  const cached = dataViewCache.get(buffer)
  if (cached !== undefined && cached.offset === byteOffset) {
    return cached.view
  }
  const view = new DataView(buffer, byteOffset)
  dataViewCache.set(buffer, { offset: byteOffset, view })
  return view
}

/**
 * Creates an independent copy of a Uint8Array.
 *
 * This ensures the returned buffer has its own backing store, decoupled
 * from the original. Useful when the original buffer is a view (subarray)
 * that may be reused or mutated.
 *
 * @param bytes - The source buffer to copy
 * @returns A new Uint8Array with an independent backing store
 *
 * @example
 * ```ts
 * const original = new Uint8Array([1, 2, 3]);
 * const copy = toPlainBuffer(original);
 * copy[0] = 99; // does not affect original
 * ```
 */
export function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}
