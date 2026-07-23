import type { FfiRuntime } from "../runtime";

export function createWebSocketApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    wsAcceptKey(key: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_ws_accept_key_v2,
        128,
        ptr(key),
        key.byteLength,
      );
    },
  };
}

export type WebSocketApi = ReturnType<typeof createWebSocketApi>;
