import type { FfiRuntime } from "../runtime";

export function createHashingApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    crc32(bytes: Uint8Array): number {
      return symbols.rust_crc32_v2(ptr(bytes), bytes.byteLength) as number;
    },

    fnv1a64(bytes: Uint8Array): bigint {
      return symbols.rust_fnv1a64_v2(ptr(bytes), bytes.byteLength) as bigint;
    },
  };
}

export type HashingApi = ReturnType<typeof createHashingApi>;
