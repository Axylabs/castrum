// src/rust-ffi/scalar/hashing.ts — Hashing scalar methods.
//
// Mirrors rust/crypto/hashing.rs + hmac_sha256.rs: crc32 / fnv1a64 / HMAC.
// (HMAC reuses the context-cached signer to avoid re-constructing the key.)

import { asBigInt, asNumber } from '../options'
import { resolveNative, type RustClientContext } from '../context'
import { getBunFFI } from '../../native/ffi'
import { isBun } from '../../shared/runtime'

const hexEncoder = new TextEncoder()

/** Hashing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHashing(ctx: RustClientContext) {
  // Bun fast path: `bun:ffi` JIT-calls the C ABI exports with ~1/4 the crossing
  // cost of napi for these sub-µs hashes. `getBunFFI()` is lazy (binds on first
  // use, ~2ns cached check) and null when unavailable / self-test fails.
  return {
    crc32(input: Uint8Array): number {
      // Optimal by default under Bun: `Bun.hash.crc32` (native SIMD) beats the
      // rust+FFI crossing (~2.8-8.4x, decision matrix) and matches the
      // `BUN_WINS`/`opImpl` recommendation. Node keeps the addon.
      // `>>> 0` preserves the unsigned-32 contract.
      if (isBun()) return Bun.hash.crc32(input) >>> 0
      const ffi = getBunFFI()
      if (ffi) return ffi.crc32(input)
      return asNumber(resolveNative(ctx, 'crc32')(input)) >>> 0
    },
    fnv1a64(input: Uint8Array): bigint {
      const ffi = getBunFFI()
      if (ffi) return ffi.fnv1a64(input)
      return asBigInt(resolveNative(ctx, 'fnv1a64')(input))
    },
    xxh3(input: Uint8Array): bigint {
      // Optimal by default under Bun: `Bun.hash.xxHash3` beats the rust+FFI
      // crossing (~4x, decision matrix). Node keeps the addon.
      if (isBun()) return Bun.hash.xxHash3(input)
      const ffi = getBunFFI()
      if (ffi) return ffi.xxh3(input)
      return asBigInt(resolveNative(ctx, 'xxh3')(input))
    },
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      // Optimal by default under Bun: `Bun.CryptoHasher` (native) beats the
      // rust+FFI crossing (~1.2x, decision matrix). Re-encoded to hex to match
      // castrum's hex-return contract (64 lowercase-hex bytes — same as the
      // addon). Node keeps the FFI path (`hmacSha256` is classified "proven"
      // vs the node:crypto baseline). Napi fallback keeps the precompiled-key
      // `HmacSigner` (identity semantics).
      if (isBun()) {
        const hasher = new Bun.CryptoHasher('sha256', key)
        hasher.update(data)
        return hexEncoder.encode(Buffer.from(hasher.digest()).toString('hex'))
      }
      const ffi = getBunFFI()
      if (ffi) return ffi.hmacSha256(key, data)
      return ctx.hmacSigner(key).sign(data)
    },
    hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.hmacSha256Into(key, data, output)
      const bytes = ctx.hmacSigner(key).sign(data)
      if (output.length < bytes.length) throw new Error('hmac sha256: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.hmacSha256Verify(key, data, sig)
      return ctx.hmacSigner(key).verify(data, sig)
    },
  }
}
