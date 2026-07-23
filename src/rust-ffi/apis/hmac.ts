import type { FfiRuntime } from "../runtime";

export function createHmacApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_hmac_sha256_v2,
        128,
        ptr(key),
        key.byteLength,
        ptr(data),
        data.byteLength,
      );
    },

    hmacSha256Verify(
      key: Uint8Array,
      data: Uint8Array,
      sig: Uint8Array,
    ): number {
      return symbols.rust_hmac_sha256_verify_v2(
        ptr(key),
        key.byteLength,
        ptr(data),
        data.byteLength,
        ptr(sig),
        sig.byteLength,
      ) as number;
    },
  };
}

export type HmacApi = ReturnType<typeof createHmacApi>;
