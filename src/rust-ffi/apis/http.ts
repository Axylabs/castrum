import type { FfiRuntime } from "../runtime";

export function createHttpApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    httpParseRequest(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_http_parse_request_v2,
        Math.max(1024, bytes.byteLength * 4 + 1024),
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type HttpApi = ReturnType<typeof createHttpApi>;
