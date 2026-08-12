// src/rust-ffi/scalar/hashing.ts — Hashing scalar methods.
//
// Mirrors rust/crypto/hashing.rs + hmac_sha256.rs: crc32 / fnv1a64 / HMAC.
// (HMAC reuses the context-cached signer to avoid re-constructing the key.)

import { asBigInt, asNumber } from "../options";
import { resolveNative, type RustClientContext } from "../context";
import { getBunFFI } from "../../native/ffi";

/** Hashing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHashing(ctx: RustClientContext) {
  // Bun fast path: `bun:ffi` JIT-calls the C ABI exports with ~1/4 the crossing
  // cost of napi for these sub-µs hashes. `getBunFFI()` is lazy (binds on first
  // use, ~2ns cached check) and null when unavailable / self-test fails.
  return {
    crc32(input: Uint8Array): number {
      const ffi = getBunFFI();
      if (ffi) return ffi.crc32(input);
      return asNumber(resolveNative(ctx, "crc32")(input)) >>> 0;
    },
    fnv1a64(input: Uint8Array): bigint {
      const ffi = getBunFFI();
      if (ffi) return ffi.fnv1a64(input);
      return asBigInt(resolveNative(ctx, "fnv1a64")(input));
    },
    xxh3(input: Uint8Array): bigint {
      const ffi = getBunFFI();
      if (ffi) return ffi.xxh3(input);
      return asBigInt(resolveNative(ctx, "xxh3")(input));
    },
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      // Bun fast path: the C ABI builds the HMAC key per call (~100ns) but
      // skips the NAPI `HmacSigner` instance construction + crossing (~300ns+),
      // so it is faster even for repeated same-key calls. Napi fallback keeps
      // the precompiled-key `HmacSigner` (identity semantics).
      const ffi = getBunFFI();
      if (ffi) return ffi.hmacSha256(key, data);
      return ctx.hmacSigner(key).sign(data);
    },
    hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI();
      if (ffi) return ffi.hmacSha256Into(key, data, output);
      const bytes = ctx.hmacSigner(key).sign(data);
      if (output.length < bytes.length) throw new Error("hmac sha256: output buffer too small");
      output.set(bytes);
      return bytes.length;
    },
    hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
      const ffi = getBunFFI();
      if (ffi) return ffi.hmacSha256Verify(key, data, sig);
      return ctx.hmacSigner(key).verify(data, sig);
    },
  };
}
