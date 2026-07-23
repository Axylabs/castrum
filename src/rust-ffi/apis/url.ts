import type { FfiRuntime } from "../runtime";

export function createUrlApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    urlEncode(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_url_encode_v2,
        bytes.byteLength * 3 + 64,
        ptr(bytes),
        bytes.byteLength,
      );
    },

    urlDecode(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_url_decode_v2,
        bytes.byteLength + 64,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type UrlApi = ReturnType<typeof createUrlApi>;
