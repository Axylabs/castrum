// src/ingress/shared.ts — Constants and types shared by BOTH ingress paths
// (the fast packed-input path and the pre-baked handler path).
//
// Binary-layout constants read from Rust live in ./constants.ts (the single
// numeric source of truth). This module holds the JS-level constants and types
// that both ingress paths rely on, so neither path needs to depend on the
// other's implementation module.

/** Default maximum request body size in bytes. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Default native ingress output-buffer size (bytes) for the FAST path
 * (`createIngressFast`).
 *
 * The fast path allocates a fresh output buffer per `run()` call, so a larger
 * default reduces reallocation on large responses. Perf-sensitive — change
 * only with benchmarking.
 */
export const DEFAULT_FAST_OUTPUT_BUFFER_SIZE = 262_144;

/**
 * Default native ingress output-buffer size (bytes) for the PRE-BAKED path
 * (`createIngressHandler`).
 *
 * The pre-baked path POOLS output buffers across requests (`BufferPool`), so
 * a smaller default keeps peak memory lower. Perf-sensitive — change only
 * with benchmarking. The two paths intentionally differ (see above).
 */
export const DEFAULT_BAKED_OUTPUT_BUFFER_SIZE = 131_072;

/**
 * Default overall deadline (ms) for reading a request body. Non-zero so the
 * async `createIngress` / route handlers are protected against slowloris and
 * trickling bodies by default. Set `bodyTimeoutMs: 0` to disable.
 */
export const DEFAULT_BODY_TIMEOUT_MS = 30_000;

/**
 * Convert a millisecond duration to whole seconds, rounding UP.
 *
 * Used everywhere a `ratelimit-reset` / `Retry-After` value is emitted: the
 * native pipeline reports millisecond resolution, and HTTP rate-limit headers
 * are whole-second integers (a partial second must not report 0).
 */
export function secondsFromMs(ms: number): number {
  return Math.ceil(ms / 1000);
}

/** Maps HTTP methods to the native Ingress method-kind enum. */
export const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

/** Method-kind value for methods not present in {@link METHOD_KIND}. */
export const METHOD_KIND_UNKNOWN = 7;

/** Which request headers to extract into the packed input. */
export interface HeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

/**
 * Build the `HeaderPlan` for an ingress options object. Shared by BOTH ingress
 * paths (`createIngressFast` and `createIngressHandler`) so the cookie/cors/
 * proxy/proto extraction decisions can never silently diverge between them.
 *
 * Proxy headers (X-Forwarded-For / X-Real-IP) are requested when either
 * `trustProxy` is true or `trustedProxies.enabled` is true — this is driven by
 * the trust configuration alone, NOT by whether rate limiting is enabled.
 * `proto` (https detection) follows the same trust rule and only applies when
 * `https` is not pinned explicitly.
 */
export function buildHeaderPlan(options: {
  parseCookies?: boolean;
  cors?: unknown;
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean };
  https?: boolean;
}): HeaderPlan {
  const trust =
    options.trustProxy === true || options.trustedProxies?.enabled === true;
  return {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust,
    proto: trust && options.https === undefined,
  };
}

/**
 * Assert that a handler callback returned a synchronous (non-thenable) value.
 *
 * The ingress result objects are invalidated once `run()` returns, so an async
 * callback would observe a stale/zeroed result. Throw instead of silently
 * returning a broken value. `label` is used in the error message, e.g.
 * `"createIngressFast().run()"`.
 */
export function assertSyncCallback<T>(out: T, label: string): void {
  if (
    out !== null &&
    (typeof out === "object" || typeof out === "function") &&
    typeof (out as { then?: unknown }).then === "function"
  ) {
    throw new Error(`${label} callback must be synchronous.`);
  }
}
