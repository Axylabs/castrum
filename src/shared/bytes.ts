// src/shared/bytes.ts — shared UTF-8 / byte helpers (encoder, decoder, toBytes, toText).

import { decodeUtf8, encodeUtf8, encodeUtf8Into } from './codec'

/**
 * Shared UTF-8 encoder (encode / encodeInto), backed by the runtime-native
 * codec (`src/shared/codec.ts`): on Bun the work is done by Bun's native
 * transfer machinery (`Bun.ArrayBufferSink` / a zero-copy `Buffer` view
 * write); under Node it falls back to `TextEncoder`. Reusing a single object
 * avoids allocation overhead in hot paths.
 *
 * `encode` accepts the string-or-bytes union the text-returning `rust.*` ops
 * surface (Bun returns strings, Node returns bytes) and normalizes to bytes —
 * a string is UTF-8 encoded, bytes pass through unchanged.
 */
export const encoder: {
  encode(s: Uint8Array | string): Uint8Array
  encodeInto(s: string, dest: Uint8Array): { read: number; written: number }
} = {
  encode(s) {
    return typeof s === 'string' ? encodeUtf8(s) : s
  },
  encodeInto(s, dest) {
    const written = encodeUtf8Into(s, dest)
    // `read` mirrors `TextEncoder.encodeInto`'s shape; callers here only use
    // `written` (a truncated write consumes the whole source in our call
    // sites), so this is a documented approximation.
    return { read: s.length, written }
  },
}

/**
 * Shared UTF-8 decoder, backed by the runtime-native codec
 * (`src/shared/codec.ts`): on Bun it uses `new CString(ptr, 0, len)` from
 * `bun:ffi` (JSC-native, exact-length clone); under Node it falls back to
 * `TextDecoder`. Reusing a single object avoids allocation overhead in hot
 * paths.
 *
 * `decode` accepts the string-or-bytes union the text-returning `rust.*` ops
 * surface and normalizes to a string — bytes are UTF-8 decoded, strings pass
 * through unchanged.
 */
export const decoder: {
  decode(bytes: Uint8Array | string): string
} = {
  decode(bytes) {
    return typeof bytes === 'string' ? bytes : decodeUtf8(bytes)
  },
}

/**
 * Normalize the string-or-bytes union (the text-returning `rust.*` ops return
 * STRINGS on the Bun path — native transfer — and bytes on the napi path) to
 * bytes. Codec-backed — no `TextEncoder` runs on the Bun path.
 *
 * @param v - A string or UTF-8 byte buffer.
 * @returns The UTF-8 bytes of `v` (identity when `v` is already bytes).
 *
 * @example
 * ```ts
 * toBytes('aGVsbG8=') // Uint8Array(8)
 * ```
 */
export function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? encodeUtf8(v) : v
}

/**
 * Normalize the string-or-bytes union to a string. Codec-backed — no
 * `TextDecoder` runs on the Bun path.
 *
 * @param v - A string or UTF-8 byte buffer.
 * @returns The decoded string (identity when `v` is already a string).
 *
 * @example
 * ```ts
 * toText(new Uint8Array([104, 105])) // 'hi'
 * ```
 */
export function toText(v: Uint8Array | string): string {
  return typeof v === 'string' ? v : decodeUtf8(v)
}

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
