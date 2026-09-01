// src/shared/codec.ts — runtime-native UTF-8 codec (facade).
//
// The runtime-native UTF-8 codec (Bun transfer machinery vs
// `TextEncoder`/`TextDecoder`) is implemented in `src/runtime/codec.ts` and
// selected ONCE at module load by the runtime adapter. This module re-exports
// it so existing callers are unchanged. The Bun/Node branches live in
// `src/runtime/codec.ts` — do NOT add `TextEncoder`/`TextDecoder` or `bun:ffi`
// calls here.

import { runtimeCodec } from '../runtime/codec'

/**
 * Encode a string to UTF-8 bytes.
 *
 * Both runtimes use a shared native `TextEncoder` singleton (on Bun 1.4 the
 * engine-native implementation measures ~3x faster than the previous
 * `Bun.ArrayBufferSink` start/write/flush path). The implementation is
 * selected once at load via the runtime adapter.
 *
 * @param s - The string to encode to UTF-8 bytes.
 * @returns A fresh `Uint8Array` of the UTF-8 encoding of `s`.
 *
 * @example
 * ```ts
 * encodeUtf8('hello') // Uint8Array [104, 101, 108, 108, 111]
 * ```
 */
export const encodeUtf8: (s: string) => Uint8Array = runtimeCodec.encodeUtf8

/**
 * Encode a string into `dest` starting at `offset`, returning bytes written.
 *
 * On Bun this writes through a zero-copy `Buffer` view over `dest`'s backing
 * store (native `.write` — never splits a multibyte character); under Node it
 * uses `TextEncoder.prototype.encodeInto`.
 *
 * @param s - The string to encode.
 * @param dest - The destination buffer.
 * @param offset - Byte offset into `dest` at which to start writing. Default 0.
 * @returns The number of UTF-8 bytes written.
 *
 * @example
 * ```ts
 * const out = new Uint8Array(8)
 * encodeUtf8Into('hi', out) // 2; out[0..1] = 104, 105
 * ```
 */
export const encodeUtf8Into: (s: string, dest: Uint8Array, offset?: number) => number =
  runtimeCodec.encodeUtf8Into

/**
 * Decode UTF-8 bytes to a string.
 *
 * On Bun this uses `new CString(ptr(bytes), 0, len)` from `bun:ffi` (JSC-native
 * exact-length clone); under Node it falls back to the standard `TextDecoder`.
 *
 * @param bytes - The UTF-8 bytes to decode.
 * @returns The decoded string (invalid sequences decode to U+FFFD replacement
 *   characters, matching `TextDecoder` replacement mode).
 *
 * @example
 * ```ts
 * decodeUtf8(new Uint8Array([104, 105])) // 'hi'
 * ```
 */
export const decodeUtf8: (bytes: Uint8Array) => string = runtimeCodec.decodeUtf8

/**
 * Decode the byte RANGE `[start, end)` of `bytes` to a string (replacement
 * mode on invalid). Zero-copy ranged decode for packed-wire unpackers — no
 * per-field `subarray` view. ASCII ranges take a latin1 fast path (~2x on
 * Bun); multi-byte ranges fall back to real UTF-8 decoding of that range.
 *
 * @param bytes - The backing byte buffer.
 * @param start - Range start (inclusive, relative to the VIEW).
 * @param end - Range end (exclusive, relative to the VIEW).
 * @returns The decoded string.
 */
export const decodeUtf8Range: (bytes: Uint8Array, start: number, end: number) => string =
  runtimeCodec.decodeUtf8Range

/**
 * Decode UTF-8 bytes to a string, throwing on invalid UTF-8.
 *
 * Under Node this uses a fatal `TextDecoder`. On Bun (whose `CString` is
 * replacement-mode) strictness is normally enforced by the native
 * `castrum_utf8_valid` C-ABI probe (callers check it first via the transport's
 * ffi surface); this fallback uses the replacement-mode decode.
 *
 * @param bytes - The UTF-8 bytes to decode.
 * @returns The decoded string (throws on invalid UTF-8 under Node).
 */
export const decodeUtf8Fatal: (bytes: Uint8Array) => string = runtimeCodec.decodeUtf8Fatal
