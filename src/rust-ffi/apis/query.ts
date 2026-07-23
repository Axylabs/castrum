import type { FfiRuntime } from "../runtime";

export function createQueryApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    queryParse(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_query_parse_v2,
        64 * 1024,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type QueryApi = ReturnType<typeof createQueryApi>;
