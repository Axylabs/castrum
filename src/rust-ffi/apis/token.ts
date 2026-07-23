import type { FfiRuntime } from "../runtime";

export function createTokenApi(runtime: FfiRuntime) {
  const { symbols, callOut } = runtime;

  return {
    randomToken(byteLen: number): Uint8Array {
      return callOut(
        symbols.rust_random_token_v2,
        byteLen * 2 + 64,
        byteLen,
      );
    },
  };
}

export type TokenApi = ReturnType<typeof createTokenApi>;
