// src/bench/raw-native.ts — RAW addon accessors for ops whose public `rust.*`
// wrapper delegates to Bun built-ins under Bun (`BUN_WINS`).
//
// The CPU bench's `rust:` column must measure the ACTUAL addon — the same
// path the wrapper takes on Node / before Bun delegation — NOT the delegated
// Bun built-in. Otherwise the CPU report would silently start reflecting Bun
// built-ins instead of the addon. Each accessor replicates the
// pre-delegation FFI-first / napi-fallback path of the scalar builder it
// mirrors, using the POOLED `*Into` variants so the measured number is the
// addon's best honest cost (no string round-trips: encode→decode→encode).
//
// Bench-only: this module is never shipped (src/bench is not part of the
// public entry).

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'
import { b64Len } from '../native/ffi/build/util'

/**
 * Fresh non-zeroing output allocation sized by the caller. The native write
 * fills `[0, w)` and only that slice escapes, so skipping the memset is safe
 * (`Buffer.allocUnsafe`; plain constructor below the ~512 B crossover where
 * it measures faster).
 */
function allocRaw(n: number): Uint8Array {
  if (n >= 512) return Buffer.allocUnsafe(n)
  return new Uint8Array(n)
}

/** Raw addon crc32 (FFI-first, napi fallback), unsigned-32. */
export function rawCrc32(input: Uint8Array): number {
  const ffi = getBunFFI()
  if (ffi) return ffi.crc32(input) >>> 0
  return getAddon().crc32(input) >>> 0
}

/** Raw addon hmacSha256 (FFI-first, napi HmacSigner fallback), hex bytes. */
export function rawHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) {
    // Pooled Into: writes the 64 hex chars directly — no cstring clone +
    // re-encode round-trip through a JS string.
    const out = allocRaw(64)
    const w = ffi.hmacSha256Into(key, data, out)
    return out.subarray(0, w)
  }
  return new (getAddon().HmacSigner)(key).sign(data)
}

/** Raw addon gzipCompress (FFI-first, napi fallback). */
export function rawGzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) return ffi.gzipCompress(data, level ?? undefined)
  return getAddon().gzipCompress(data, level ?? null)
}

/** Raw addon randomToken (FFI-first, napi fallback), hex bytes. */
export function rawRandomToken(byteLen: number): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) {
    const out = allocRaw(byteLen * 2)
    const w = ffi.randomTokenInto(byteLen, out)
    return out.subarray(0, w)
  }
  return getAddon().randomToken(byteLen)
}

/** Raw addon xxh3 (FFI-first, napi fallback), 64-bit unsigned. */
export function rawXxh3(input: Uint8Array): bigint {
  const ffi = getBunFFI()
  if (ffi) return ffi.xxh3(input)
  return getAddon().xxh3(input)
}

/** Raw addon urlEncode (FFI-first, napi fallback). RFC 3986 worst case is 3x. */
export function rawUrlEncode(input: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) {
    const out = allocRaw(input.length * 3 + 16)
    const w = ffi.urlEncodeInto(input, out)
    return out.subarray(0, w)
  }
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
  if (ffi) {
    const out = allocRaw(b64Len(input.length) + 3)
    const w = ffi.base64EncodeInto(input, out, urlSafe, padding)
    return out.subarray(0, w)
  }
  return getAddon().base64Encode(input, urlSafe ?? undefined, padding ?? undefined)
}

/**
 * Raw addon httpDate (FFI-first now that `castrum_http_date_into` exists;
 * napi fallback). BUN_WINS delegates the public wrapper to Date.toUTCString
 * under Bun; this measures the addon path directly. Fixed 29-byte output.
 */
export function rawHttpDate(secs: number): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) {
    const out = allocRaw(32)
    const w = ffi.httpDateInto(secs, out)
    return out.subarray(0, w)
  }
  return getAddon().httpDate(secs)
}
/** Raw addon hexEncode (FFI-first, napi fallback). BUN_WINS delegates the
 * public wrapper to `Buffer.toString('hex')` under Bun; this measures the
 * addon path directly (same as Node).
 */
export function rawHexEncode(input: Uint8Array): Uint8Array {
  const ffi = getBunFFI()
  if (ffi) {
    const out = allocRaw(input.length * 2)
    const w = ffi.hexEncodeInto(input, out)
    return out.subarray(0, w)
  }
  return getAddon().hexEncode(input)
}
