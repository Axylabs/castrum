// src/bench/raw-native.ts — RAW addon accessors for ops whose public `rust.*`
// wrapper delegates to Bun built-ins under Bun (`BUN_WINS`).
//
// The CPU bench's `rust:` column must measure the ACTUAL addon — the same
// path the wrapper takes on Node / before Bun delegation — NOT the delegated
// Bun built-in. Otherwise the CPU report would silently start reflecting Bun
// built-ins and the PROVEN_SURFACE audit (which classifies the addon vs the
// node baseline) would drift. Each accessor replicates the pre-delegation
// FFI-first / napi-fallback path of the scalar builder it mirrors.
//
// Bench-only: this module is never shipped (src/bench is not part of the
// public entry).

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'

/** Raw addon crc32 (FFI-first, napi fallback), unsigned-32. */
export function rawCrc32(input: Uint8Array): number {
  const ffi = getBunFFI()
  if (ffi) return ffi.crc32(input) >>> 0
  return getAddon().crc32(input) >>> 0
}

/** Raw addon hmacSha256 (FFI-first, napi HmacSigner fallback), hex output. */
export function rawHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.hmacSha256(key, data)
  return new (getAddon().HmacSigner)(key).sign(data)
}

/** Raw addon gzipCompress (FFI-first, napi fallback). */
export function rawGzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.gzipCompress(data, level ?? undefined)
  return getAddon().gzipCompress(data, level ?? null)
}

/** Raw addon randomToken (FFI-first, napi fallback), hex output. */
export function rawRandomToken(byteLen: number): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.randomToken(byteLen)
  return getAddon().randomToken(byteLen)
}

/** Raw addon xxh3 (FFI-first, napi fallback), 64-bit unsigned. */
export function rawXxh3(input: Uint8Array): bigint {
  const ffi = getBunFFI()
  if (ffi) return ffi.xxh3(input)
  return getAddon().xxh3(input)
}

/** Raw addon urlEncode (FFI-first, napi fallback). */
export function rawUrlEncode(input: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.urlEncode(input)
  return getAddon().urlEncode(input)
}

/** Raw addon urlDecode (FFI-first, napi fallback). */
export function rawUrlDecode(input: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.urlDecode(input)
  return getAddon().urlDecode(input)
}

/**
 * Raw addon base64Encode (FFI-first, napi fallback). BUN_WINS delegates the
 * standard padded case to `Buffer.toString('base64')`; this measures the
 * addon path directly (same as Node / non-standard args).
 */
export function rawBase64Encode(
  input: Uint8Array,
  urlSafe?: boolean,
  padding?: boolean,
): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.base64Encode(input, urlSafe, padding)
  return getAddon().base64Encode(input, urlSafe ?? undefined, padding ?? undefined)
}

/**
 * Raw addon httpDate (napi only — there is no `castrum_*` C-ABI export for
 * HTTP dates, so this has no FFI branch; matches the pre-delegation path the
 * wrapper takes under Node).
 */
export function rawHttpDate(secs: number): Uint8Array {
  return getAddon().httpDate(secs)
}
