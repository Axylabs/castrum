// src/rust-ffi/scalar/hashing.ts — Hashing scalar methods.
//
// Mirrors rust/crypto/hashing.rs + hmac_sha256.rs: crc32 / fnv1a64 / HMAC.
// (HMAC reuses the context-cached signer to avoid re-constructing the key.)
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): the Bun
// built-in delegations (crc32/xxh3/hmacSha256) come from `builtins.has(op)`
// and the native call from `transport.resolve(op)` / `transport.ffi`
// (bun:ffi first, napi fallback) — no inline `isBun()` / `getBunFFI()`.

import { toBytes } from '../../shared/bytes'
import { memoizeFfi, type RustClientContext, resolveNative } from '../context'
import { writeInto } from '../into'
import { asBigInt, asNumber } from '../options'

/** Hashing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHashing(ctx: RustClientContext) {
  const { builtins, transport } = ctx.runtime
  // Hoist the immutable per-runtime builtin-delegation decisions into a
  // bind-time map (BUILTIN_OPS is a module constant — never mutated after
  // load) so the hot path reads object properties instead of `Set.has`.
  const HAS = {
    crc32: builtins.has('crc32'),
    xxh3: builtins.has('xxh3'),
    hmacSha256: builtins.has('hmacSha256'),
  }
  // Lazy-memoized ffi surface: binds on first call, single local read after.
  const ffi = memoizeFfi(transport)
  // bun:ffi JIT-calls the C ABI exports with ~1/4 the crossing cost of napi
  // for these sub-µs hashes; the transport resolves ffi-first and caches.
  return {
    crc32(input: Uint8Array): number {
      // Optimal by default under Bun: `Bun.hash.crc32` (native SIMD) beats the
      // rust+FFI crossing (~2.8-8.4x, decision matrix) and matches the
      // `opImpl` recommendation. Node keeps the addon.
      if (HAS.crc32) return builtins.crc32(input)
      return asNumber(resolveNative(ctx, 'crc32')(input)) >>> 0
    },
    fnv1a64(input: Uint8Array): bigint {
      return asBigInt(resolveNative(ctx, 'fnv1a64')(input))
    },
    xxh3(input: Uint8Array): bigint {
      // Optimal by default under Bun: `Bun.hash.xxHash3` beats the rust+FFI
      // crossing (~4x, decision matrix). Node keeps the addon.
      if (HAS.xxh3) return builtins.xxh3(input)
      return asBigInt(resolveNative(ctx, 'xxh3')(input))
    },
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | string {
      // Optimal by default under Bun: `Bun.CryptoHasher` (native) beats the
      // rust+FFI crossing (~1.2x, decision matrix). Bun returns the 64-char
      // lowercase-hex STRING (native transfer — no TextEncoder round-trip); the
      // addon returns the same hex as bytes. Node keeps the FFI path.
      if (HAS.hmacSha256) return builtins.hmacSha256(key, data)
      const f = ffi()
      if (f) return f.hmacSha256(key, data)
      return ctx.hmacSigner(key).sign(data)
    },
    hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number {
      const f = ffi()
      if (f) return f.hmacSha256Into(key, data, output)
      return writeInto('hmac sha256', output, ctx.hmacSigner(key).sign(data))
    },
    hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array | string): boolean {
      // `hmacSha256` returns the signature as a hex STRING under Bun (built-in
      // delegation / cstring) and as hex bytes under napi. The verifier accepts
      // both — normalize the string to hex bytes so the ffi/napi cores see the
      // same input (sign → verify is self-consistent on every transport).
      const sigBytes = toBytes(sig)
      const f = ffi()
      if (f) return f.hmacSha256Verify(key, data, sigBytes)
      return ctx.hmacSigner(key).verify(data, sigBytes)
    },
  }
}
