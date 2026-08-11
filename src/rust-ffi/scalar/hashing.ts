// src/rust-ffi/scalar/hashing.ts — Hashing scalar methods.
//
// Mirrors rust/crypto/hashing.rs + hmac_sha256.rs: crc32 / fnv1a64 / HMAC.
// (HMAC reuses the context-cached signer to avoid re-constructing the key.)

import { asBigInt, asNumber } from "../options";
import type { RustClientContext } from "../context";

/** Hashing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHashing(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    crc32(input: Uint8Array): number {
      return asNumber(addon.crc32(input) as unknown) >>> 0;
    },
    fnv1a64(input: Uint8Array): bigint {
      return asBigInt(addon.fnv1a64(input) as unknown);
    },
    xxh3(input: Uint8Array): bigint {
      return asBigInt(addon.xxh3(input) as unknown);
    },
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      return ctx.hmacSigner(key).sign(data);
    },
    hmacSha256Verify(
      key: Uint8Array,
      data: Uint8Array,
      sig: Uint8Array,
    ): boolean {
      return ctx.hmacSigner(key).verify(data, sig);
    },
  };
}
