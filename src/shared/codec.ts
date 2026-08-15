// src/shared/codec.ts — runtime-native UTF-8 codec (Bun transfer, Node fallback).
//
// On Bun, string↔bytes conversion goes through Bun's native transfer machinery
// instead of `TextEncoder`/`TextDecoder`:
//   - encode:     `Bun.ArrayBufferSink` (native UTF-8 writer; flushed to a
//                 fresh `Uint8Array`, buffer reset on flush so the sink is
//                 reused).
//   - encodeInto: a zero-copy `Buffer` view over the caller's backing store +
//                 the native `.write(s, 0, 'utf8')` — the Bun-implemented
//                 equivalent of `TextEncoder.encodeInto` (writes as much as
//                 fits without splitting a multibyte char; returns bytes
//                 written).
//   - decode:     `new CString(ptr(bytes), 0, len)` from `bun:ffi` — a
//                 JSC-native UTF-8 clone of an EXACT-length region (never
//                 NUL-truncated when `byteLength` is supplied).
// Under Node the standard `TextEncoder`/`TextDecoder` are the fallback. Shared
// runtime code routes through here so no `TextEncoder`/`TextDecoder` executes
// on the Bun path. Do NOT add TextEncoder/TextDecoder calls outside the Node
// branches below.

import { isBun } from './runtime'

let nodeEncoder: TextEncoder | null = null
let nodeDecoder: TextDecoder | null = null
let nodeFatalDecoder: TextDecoder | null = null
let bunSink: Bun.ArrayBufferSink | null = null

function getNodeEncoder(): TextEncoder {
  if (nodeEncoder === null) {
    nodeEncoder = new TextEncoder()
  }
  return nodeEncoder
}

function getNodeDecoder(): TextDecoder {
  if (nodeDecoder === null) {
    nodeDecoder = new TextDecoder()
  }
  return nodeDecoder
}

function getNodeFatalDecoder(): TextDecoder {
  if (nodeFatalDecoder === null) {
    nodeFatalDecoder = new TextDecoder('utf-8', { fatal: true })
  }
  return nodeFatalDecoder
}

/**
 * Encode a string to UTF-8 bytes.
 *
 * On Bun this uses `Bun.ArrayBufferSink` (native UTF-8 writing — no
 * `TextEncoder`). Under Node it falls back to the standard `TextEncoder`.
 *
 * @param s - The string to encode to UTF-8 bytes.
 * @returns A fresh `Uint8Array` of the UTF-8 encoding of `s`.
 *
 * @example
 * ```ts
 * encodeUtf8('hello') // Uint8Array [104, 101, 108, 108, 111]
 * ```
 */
export function encodeUtf8(s: string): Uint8Array {
  if (isBun()) {
    if (bunSink === null) {
      bunSink = new Bun.ArrayBufferSink()
    }
    const sink = bunSink
    // `stream` resets the buffer on flush (so the singleton is reusable) and
    // makes `flush()` return the written data; `asUint8Array` returns a
    // `Uint8Array` rather than an `ArrayBuffer`.
    sink.start({ asUint8Array: true, stream: true })
    sink.write(s)
    return sink.flush() as Uint8Array
  }
  return getNodeEncoder().encode(s)
}

/**
 * Encode a string into `dest` starting at `offset`, returning bytes written.
 *
 * On Bun this writes through a zero-copy `Buffer` view over `dest`'s backing
 * store (native `.write` — the Bun-implemented equivalent of
 * `TextEncoder.encodeInto`; it never writes past the end of `dest` and never
 * splits a multibyte character). Under Node it uses
 * `TextEncoder.prototype.encodeInto`.
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
export function encodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
  if (isBun()) {
    const view = Buffer.from(dest.buffer, dest.byteOffset + offset, dest.byteLength - offset)
    return view.write(s, 0, 'utf8')
  }
  return getNodeEncoder().encodeInto(s, dest.subarray(offset)).written
}

/**
 * Decode UTF-8 bytes to a string.
 *
 * On Bun this uses `new CString(ptr(bytes), 0, len)` from `bun:ffi` — a
 * JSC-native UTF-8 clone of exactly `bytes.byteLength` bytes (never
 * NUL-truncated, since a length is supplied). Under Node it falls back to the
 * standard `TextDecoder`.
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
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return ''
  }
  if (isBun()) {
    // Lazily require `bun:ffi` — the module does not exist under Node, and this
    // branch only executes on Bun (same pattern as src/native/ffi.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ptr, CString } = require('bun:ffi') as typeof import('bun:ffi')
    return new CString(ptr(bytes), 0, bytes.byteLength).toString()
  }
  return getNodeDecoder().decode(bytes)
}

/**
 * Decode UTF-8 bytes to a string, throwing on invalid UTF-8.
 *
 * Used where a strict (fatal) decode is required (napi `url_decode` parity).
 * On Bun the strictness is normally enforced by the native `castrum_utf8_valid`
 * C-ABI probe (callers check it first via `getBunFFI()`); this fallback only
 * runs when the ffi transport is unavailable, in which case it uses the codec's
 * replacement-mode decode (documented limitation — Bun's `CString` is
 * replacement-mode). Under Node it uses a fatal `TextDecoder`.
 *
 * @param bytes - The UTF-8 bytes to decode.
 * @returns The decoded string (throws on invalid UTF-8 under Node).
 */
export function decodeUtf8Fatal(bytes: Uint8Array): string {
  if (isBun()) {
    return decodeUtf8(bytes)
  }
  return getNodeFatalDecoder().decode(bytes)
}
