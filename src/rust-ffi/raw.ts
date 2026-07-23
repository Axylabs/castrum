import { createCookieApi } from "./apis/cookie";
import { createHashingApi } from "./apis/hashing";
import { createHmacApi } from "./apis/hmac";
import { createHttpApi } from "./apis/http";
import { createJsonApi } from "./apis/json";
import { createJsonPatchApi } from "./apis/json-patch";
import { createMimeApi } from "./apis/mime";
import { createQueryApi } from "./apis/query";
import { createTokenApi } from "./apis/token";
import { createUrlApi } from "./apis/url";
import { createValidationApi } from "./apis/validation";
import { createWebSocketApi } from "./apis/websocket";
import { createFfiRuntime, type FfiRuntime } from "./runtime";

/**
 * Raw Rust FFI client.
 *
 * This client is used by benchmarks so Rust implementations can continue to be
 * measured even if the public optimized client overrides some methods with
 * native implementations.
 */
export function createRawRustClient(runtime: FfiRuntime = createFfiRuntime()) {
  return {
    ...createJsonApi(runtime),
    ...createHttpApi(runtime),
    ...createQueryApi(runtime),
    ...createCookieApi(runtime),
    ...createTokenApi(runtime),
    ...createWebSocketApi(runtime),
    ...createJsonPatchApi(runtime),
    ...createHmacApi(runtime),
    ...createValidationApi(runtime),
    ...createHashingApi(runtime),
    ...createMimeApi(runtime),
    ...createUrlApi(runtime),
  };
}

export type RawRustClient = ReturnType<typeof createRawRustClient>;
export const rust = createRawRustClient();
