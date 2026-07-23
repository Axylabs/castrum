import type { FfiRuntime } from "../runtime";

export function createCookieApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    cookieParse(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_cookie_parse_v2,
        Math.max(256, bytes.byteLength * 6 + 256),
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type CookieApi = ReturnType<typeof createCookieApi>;
