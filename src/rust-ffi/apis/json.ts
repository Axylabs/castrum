import type { FfiRuntime } from "../runtime";

export function createJsonApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    jsonValid(bytes: Uint8Array): number {
      return symbols.rust_json_valid_v2(ptr(bytes), bytes.byteLength) as number;
    },

    jsonSumIds(bytes: Uint8Array): bigint {
      return symbols.rust_json_sum_ids_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as bigint;
    },
  };
}

export type JsonApi = ReturnType<typeof createJsonApi>;
