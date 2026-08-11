// src/ingress/handlers.ts — Pre-baked ingress handler functions
//
// A ready-to-use convenience layer for consuming the optimized ingress pipeline
// (native Ingress.handleRequestPacked) with zero boilerplate. Any system can
// wire up ingress in a few lines:
//
//   import {
//     createIngressHandler, readHandler, jsonWriteHandler,
//     echoHandler, fallbackHandler, createIngressServer,
//   } from "./index";
//
//   const ingress = createIngressHandler({
//     parseCookies: true,
//     parseQuery: true,
//     cors: { allowOrigin: ["https://app.example.com"] },
//   });
//
//   // Route handlers — runtime-agnostic, work with any fetch-style server:
//   const routes = {
//     "/health": { GET: readHandler(ingress) },
//     "/api/x":  { GET: readHandler(ingress), POST: jsonWriteHandler(ingress) },
//   };
//
//   // Or the full Bun.serve builder:
//   createIngressServer({ port: 3000, routes: { "/health": { read: ingress } } });
//
// This module deliberately keeps the benchmark's wire format ({"ok":false,
// "error":{...}} bodies, `ratelimit-*` headers). It does NOT reuse fast.ts's
// response builders because those emit a different payload shape.
//
// The pre-baked pipeline is decomposed into task-focused submodules:
//   - decode/baked-result.ts       BakedIngressResult (zero-alloc decode)
//   - response/error-bodies.ts     pre-encoded error bodies
//   - headers/baked-templates.ts   ratelimit-* header templates
//   - packing/gather-raw-headers.ts raw header gathering
//   - routes/*                     route factories
//   - server.ts                    Bun.serve builder

import { getAddon } from "../native";
import { BufferPool, type PooledBuffer } from "../shared/buffer-pool";
import { pooledBodyResponse } from "../shared/response";
import { generateRequestId } from "../shared/request-id";
import { createStructuredLogger } from "../shared/log";
import { decoder, viewForArrayBuffer } from "../shared/bytes";
import {
  HV_JSON,
  HV_CORS_SIMPLE,
  HV_CORS_PREFLIGHT,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
} from "./constants";
import { safeTerminalStatus } from "./status";
import {
  assertKnownIngressOptions,
  warnTrustProxyDeprecated,
  type IngressHandlerOptions,
} from "./options";
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN, secondsFromMs, DEFAULT_BAKED_OUTPUT_BUFFER_SIZE, type HeaderPlan } from "./shared";
import { BakedIngressResult } from "./decode/baked-result";
import { ERROR_BODIES, rateLimitedBody, ERROR_CODE_BODIES } from "./response/error-bodies";
import { buildBakedHeaderTemplates } from "./headers/baked-templates";
import { gatherRawHeadersPacked } from "./packing/gather-raw-headers";
import { IngressInputPacker } from "./packing/input-packer";
import type { BakedContext, OptimizedIngressHandler } from "./types";

// ── Re-exports (back-compat: preserve handlers.ts's original public surface) ──
export { BakedIngressResult } from "./decode/baked-result";
export { ERROR_BODIES } from "./response/error-bodies";
export {
  readHandler,
  headHandler,
  jsonWriteHandler,
  echoHandler,
  fallbackHandler,
} from "./routes";
export type { BakedHandlerOptions } from "./routes";
export type { IngressHandlerOptions } from "./options";
export { createIngressServer, gracefulShutdown } from "./server";
export type {
  BakedRoute,
  CreateIngressServerOptions,
  BakedServer,
  ServerHandle,
  GracefulShutdownOptions,
} from "./server";
// Node.js HTTP adapter (same pre-baked route handlers, node:http backend).
export { createIngressServerNode } from "./server-node";
export type { RouteHandler as IngressNodeRouteHandler } from "./server-node";

const encoder = new TextEncoder();
const EMPTY_BODY = new Uint8Array(0);
const EMPTY_IP = "0.0.0.0";

/** Sentinel value used by Rust to mean "rate limiting disabled". */
export const RATE_LIMIT_U32_MAX = 4_294_967_295;

/**
 * Best-effort URL pathname extraction for log/error lines.
 *
 * This runs inside catch/finally paths, so a malformed `req.url` must never
 * throw out of the handler (an uncaught error here would bypass `onError`).
 * Falls back to the raw URL string when parsing fails.
 */
function pathForLog(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return req.url;
  }
}

// ── Types ────────────────────────────────────────────────────────
// `BakedContext` and `OptimizedIngressHandler` are defined in ./types.ts
// (shared with the route factories) and re-exported here for back-compat.
export type { BakedContext, OptimizedIngressHandler } from "./types";

export interface BakedIngressRuntime {
  /** Emit an `x-request-id` header on responses. Default: false. */
  emitRequestIdHeader?: boolean;
  /** Enable security headers on responses. Default: true. */
  enableSecurityHeaders?: boolean;
  /** Ordered `[name, value]` security headers (names are lowercased). */
  securityHeaders?: ReadonlyArray<[string, string]>;
  /** Native output buffer size in bytes. Default: 131072. */
  outputBufferSize?: number;
  /** Invoked before a request is processed (for tracing/context hooks). */
  onRequest?: (req: Request, requestId: string, ip: string | undefined) => void;
  /** Invoked after a Response is produced (for metrics/logging hooks). */
  onResponse?: (
    req: Request,
    result: BakedIngressResult,
    status: number,
    requestId: string,
  ) => void;
  /**
   * Invoked when the native pipeline fails (the request becomes a 500).
   * Native failures are otherwise silent — wire this to your error tracker.
   */
  onError?: (req: Request, requestId: string, error: Error) => void;
  /**
   * Emit one structured JSON line per request/error via the built-in logger
   * (gated by `CASTRUM_LOG_LEVEL`). Default: false.
   */
  structuredLog?: boolean;
  /**
   * Custom structured logger (e.g. with a custom stream or extra fields).
   * When provided, request/error lines go here instead of the built-in stderr
   * logger and `structuredLog` is implicitly enabled.
   */
  logger?: ReturnType<typeof createStructuredLogger>;
  /**
   * Hard cap on concurrently borrowed output buffers (zero-copy responses not
   * yet consumed). Bounds memory when zero-copy responses are consumed
   * slowly; when exceeded, requests fail with a 500 (pool exhaustion) instead
   * of allocating unbounded temporaries. 0 (default) is unlimited — see
   * `BufferPool.maxInFlight`.
   */
  maxInFlight?: number;
}

// ── Optimized ingress factory ─────────────────────────────────────

/**
 * Create a pre-baked ingress handler (path 2).
 *
 * The request frame (url/ip/rid/headers) is packed in JS via `IngressInputPacker`
 * + `gatherRawHeadersPacked` and driven through the same native core as the
 * fast path (`Ingress.handleRequestPacked`), writing into a pooled output
 * buffer (no per-request allocation). Responses use the benchmark wire format
 * (`{"ok":false,"error":{...}}` + `ratelimit-*` headers) — see AGENTS.md for
 * why this differs from `createIngressFast`.
 *
 * Returns an `OptimizedIngressHandler` whose response-builder methods are
 * bound to this handler's configuration. Pair it with the route factories
 * (`readHandler`, `jsonWriteHandler`, ...) or `createIngressServer`.
 */
export function createIngressHandler(
  options: IngressHandlerOptions = {},
  runtime: BakedIngressRuntime = {},
): OptimizedIngressHandler {
  // Fail fast on a misspelled option key — same guard as the fast path.
  assertKnownIngressOptions(options, "createIngressHandler");
  if (options.trustProxy === true) {
    warnTrustProxyDeprecated();
  }
  // Lazy: the native addon is only needed once a handler is created.
  const addon = getAddon();
  const NativeIngress = addon.Ingress;
  if (typeof NativeIngress !== "function") {
    throw new Error("Native Ingress class missing. Rebuild the Rust addon.");
  }

  const handler = new NativeIngress(options);
  if (typeof handler.handleRequestPacked !== "function") {
    throw new Error(
      "Native Ingress.handleRequestPacked missing. Rebuild the Rust addon.",
    );
  }

  const rateLimit = options.rateLimit as { limit?: number } | undefined;
  const limit = rateLimit?.limit;
  const rateEnabled =
    typeof limit === "number" && limit !== RATE_LIMIT_U32_MAX && limit > 0;

  // Shared with the fast path — proxy extraction is driven by trust config
  // (trustProxy / trustedProxies), not by whether rate limiting is enabled.
  const headerPlan: HeaderPlan = buildHeaderPlan(options);

  const emitRequestIdHeader = runtime.emitRequestIdHeader === true;
  const outputBufferSize = runtime.outputBufferSize ?? DEFAULT_BAKED_OUTPUT_BUFFER_SIZE;

  // Built-in structured logger (opt-in; gated by CASTRUM_LOG_LEVEL). A custom
  // `runtime.logger` overrides it and implies structuredLog:true.
  const logger =
    runtime.logger ??
    (runtime.structuredLog === true ? createStructuredLogger() : null);

  // Only materialize the request-id string when a consumer needs it, avoiding
  // one string allocation + UTF-8 decode per request in deployments with no
  // hooks/logging. The bench wires `onResponse`, so the decode stays hot there;
  // lean servers with no hooks skip it entirely.
  const needRequestIdString = !!(
    emitRequestIdHeader ||
    runtime.onRequest ||
    runtime.onError ||
    runtime.onResponse ||
    logger
  );

  // Reusable output-buffer pool: eliminates the per-request output-buffer
  // allocation by reusing buffers across requests.
  // `maxInFlight` (when set) bounds zero-copy borrowing under slow consumers.
  const outputPool = new BufferPool({
    initialSize: outputBufferSize,
    maxInFlight: runtime.maxInFlight,
  });

  // Reusable packed-input builder (same zero-alloc discipline as the fast
  // path): the per-request frame is packed into this buffer instead of paying
  // the napi `Vec<Vec<String>>` header marshaling of the full_sync family.
  const inputPacker = new IngressInputPacker();

  // Per-call state: the output handle backing the current `run()`'s result,
  // and whether a zero-copy Response claimed it (so `run()` must not release
  // it back to the pool before the body is consumed).
  let currentHandle: PooledBuffer | null = null;
  let responseBorrowsBuffer = false;

  // ── Variant-indexed header templates (precomputed once) ──
  const cors = options.cors as
    | {
        allowOrigin?: string[];
        allowMethods?: string[];
        allowHeaders?: string[];
        exposeHeaders?: string[];
        allowCredentials?: boolean;
        maxAge?: number;
      }
    | undefined;

  const securityEntries: ReadonlyArray<[string, string]> =
    runtime.enableSecurityHeaders === false
      ? Object.freeze([] as [string, string][])
      : Object.freeze(
          (runtime.securityHeaders ?? []).map(
            ([k, v]) => [k.toLowerCase(), v] as [string, string],
          ),
        );

  const corsAllowMethods = cors?.allowMethods?.join(", ") ?? "";
  const corsAllowHeaders = cors?.allowHeaders?.join(", ") ?? "";
  const corsExposeHeaders = cors?.exposeHeaders?.join(", ") ?? "";
  const corsMaxAge = cors?.maxAge != null ? String(cors.maxAge) : "";
  const rateLimitStr = rateEnabled ? String(limit) : "";

  const { regular: headerTemplates, terminal: terminalTemplates } =
    buildBakedHeaderTemplates({
      securityEntries,
      cors,
      corsAllowMethods,
      corsAllowHeaders,
      corsExposeHeaders,
      corsMaxAge,
      rateLimitStr,
    });

  function responseHeaders(
    variant: number,
    requestIdHeader: string | null,
    origin: string | null,
    rateRemaining?: number,
    rateResetSecs?: number,
    retryAfterSecs?: number,
  ): [string, string][] {
    const template: ReadonlyArray<[string, string]> =
      headerTemplates[variant & 31] ?? headerTemplates[0] ?? [];

    const needsRequestId = emitRequestIdHeader && requestIdHeader !== null;
    const needsOrigin =
      ((variant & HV_CORS_SIMPLE) !== 0 ||
        (variant & HV_CORS_PREFLIGHT) !== 0) &&
      origin !== null;
    const needsRate = (variant & HV_RATE_ACTIVE) !== 0;
    const needsRetry = (variant & HV_RATE_LIMITED) !== 0;

    if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
      return template as unknown as [string, string][];
    }

    let extra = 0;
    if (needsRequestId) extra++;
    if (needsOrigin) extra++;
    if (needsRate) extra += 2;
    if (needsRetry) extra++;

    const entries = new Array<[string, string]>(template.length + extra);
    let i = 0;

    for (const pair of template) {
      entries[i++] = pair;
    }

    if (needsRequestId) {
      entries[i++] = ["x-request-id", requestIdHeader as string];
    }

    if (needsOrigin) {
      entries[i++] = ["access-control-allow-origin", origin as string];
    }

    if (needsRate) {
      entries[i++] = ["ratelimit-remaining", String(rateRemaining ?? 0)];
      entries[i++] = ["ratelimit-reset", String(rateResetSecs ?? 0)];
    }

    if (needsRetry) {
      entries[i++] = ["retry-after", String(retryAfterSecs ?? 0)];
    }

    return entries;
  }

  function terminalHeaders(
    variant: number,
    ctx: BakedContext,
    result: BakedIngressResult | null,
  ): [string, string][] {
    const v = variant | HV_JSON;
    const requestIdHeader = ctx.requestIdHeader;
    const origin = ctx.origin;
    const rateResetSecs =
      result && result.rateResetMs > 0
        ? secondsFromMs(result.rateResetMs)
        : undefined;
    const retryAfterSecs =
      result && result.retryAfterMs > 0
        ? secondsFromMs(result.retryAfterMs)
        : undefined;

    const needsRequestId = emitRequestIdHeader && requestIdHeader !== null;
    const needsOrigin =
      ((v & HV_CORS_SIMPLE) !== 0 || (v & HV_CORS_PREFLIGHT) !== 0) &&
      origin !== null;
    const needsRate = (v & HV_RATE_ACTIVE) !== 0;
    const needsRetry = (v & HV_RATE_LIMITED) !== 0;

    // Steady state: no request-id/origin/rate extras — serve the pre-baked
    // terminal template (JSON + `cache-control: no-store`) directly with zero
    // per-response array allocation/copy.
    if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
      return terminalTemplates[v & 31] as unknown as [string, string][];
    }

    // Rare path: extras appended after the baked entries, then `cache-control`.
    const base = responseHeaders(
      v,
      requestIdHeader,
      origin,
      result?.rateRemaining,
      rateResetSecs,
      retryAfterSecs,
    );

    const out = new Array<[string, string]>(base.length + 1);
    let i = 0;
    for (const pair of base) {
      out[i++] = pair;
    }
    out[base.length] = ["cache-control", "no-store"];
    return out;
  }

  function terminalResponse(
    _req: Request,
    result: BakedIngressResult,
    ctx: BakedContext,
  ): Response | null {
    if (!result.terminal) {
      return null;
    }

    const preflightAllowed = result.isPreflight && result.corsAllowed;

    if (preflightAllowed) {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(
          result.headerVariant,
          ctx.requestIdHeader,
          ctx.origin,
          result.rateRemaining,
          result.rateResetMs > 0
            ? secondsFromMs(result.rateResetMs)
            : undefined,
          result.retryAfterMs > 0
            ? secondsFromMs(result.retryAfterMs)
            : undefined,
        ),
      });
    }

    const status = safeTerminalStatus(result);

    const body: Uint8Array =
      result.errorCode === ERROR_CODE_RATE_LIMITED
        ? rateLimitedBody(result.retryAfterMs)
        : (ERROR_CODE_BODIES[result.errorCode] ?? ERROR_BODIES.internal ?? EMPTY_BODY);

    return new Response(body, {
      status,
      headers: terminalHeaders(result.headerVariant, ctx, result),
    });
  }

  function errorResponse(
    _req: Request,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response {
    const body =
      ERROR_BODIES[code] ??
      encoder.encode(JSON.stringify({ ok: false, error: { code, message } }));

    return new Response(body, {
      status,
      headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result),
    });
  }

  function internalErrorResponse(
    ctx: BakedContext,
    result?: BakedIngressResult,
  ): Response {
    return new Response(ERROR_BODIES.internal, {
      status: 500,
      headers: terminalHeaders(
        result?.headerVariant ?? HV_JSON,
        ctx,
        result ?? null,
      ),
    });
  }

  function withContentType(
    headers: ReadonlyArray<[string, string]>,
    contentType: string,
  ): [string, string][] {
    const out = new Array<[string, string]>(headers.length + 1);
    let i = 0;
    for (const pair of headers) {
      out[i++] = pair;
    }
    out[headers.length] = ["content-type", contentType];
    return out;
  }

  function zeroCopyResponse(
    result: BakedIngressResult,
    _ctx: BakedContext,
    init: ResponseInit,
  ): Response {
    if (currentHandle === null) {
      // Defensive: no pooled handle available — serve the slice directly.
      return new Response(result.bodyJson(false), init);
    }
    responseBorrowsBuffer = true;
    return pooledBodyResponse(currentHandle, result.bodyJson(false), init);
  }

  const result = new BakedIngressResult();
  const ctx: BakedContext = {
    requestIdHeader: null,
    origin: null,
  };

  function run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T {
    const startedAt = logger ? performance.now() : 0;
    const methodKind = METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN;
    const ridBytes = generateRequestId();
    const requestIdStr = needRequestIdString ? decoder.decode(ridBytes) : "";

    ctx.requestIdHeader = emitRequestIdHeader ? requestIdStr : null;
    ctx.origin = headerPlan.cors ? req.headers.get("origin") : null;

    runtime.onRequest?.(req, requestIdStr, ip);

    const ipStr = ip ?? EMPTY_IP;

    // Pack the request frame in JS (reusing the fast path's zero-alloc packer
    // discipline) and drive the same native core as `handleRequestPacked`.
    // This removes the per-request `[name, value][]` header marshaling + napi
    // `Vec<Vec<String>>` and the request-id string re-encode that the
    // full_sync family paid on every request. The response wire format is
    // unchanged because both entries run the identical `handle_packed` core.
    const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind);
    // url/ip are encoded directly into the packer buffer (no intermediate
    // `encoder.encode` Uint8Array + copy); requestId/headers are byte slices
    // copied verbatim (no decode→re-encode of the pre-encoded request id).
    const input = inputPacker.packParts(
      methodKind,
      req.url,
      ip,
      ridBytes,
      packedHeaders,
    );

    let handle: PooledBuffer | null = null;
    currentHandle = null;
    responseBorrowsBuffer = false;

    try {
      try {
        // Acquire inside the try: pool exhaustion (maxInFlight) becomes a 500
        // via setInternalError — never an uncaught exception out of run().
        handle = outputPool.acquire(outputBufferSize);
        currentHandle = handle;

        // Write into the pooled buffer — no per-request allocation.
        const written = handler.handleRequestPacked(
          input,
          body,
          handle.buffer,
        );

        const used = handle.buffer.subarray(0, written);
        // Cached per-ArrayBuffer DataView: no per-request view allocation.
        result.refresh(
          used,
          body ?? EMPTY_BODY,
          viewForArrayBuffer(used.buffer, used.byteOffset),
        );
      } catch (err) {
        result.setInternalError();
        const error = err instanceof Error ? err : new Error(String(err));
        runtime.onError?.(req, requestIdStr, error);
        logger?.error({
          requestId: requestIdStr,
          method: req.method,
          path: pathForLog(req),
          code: "internal",
          message: error.message,
        });
      }

      try {
        const out = fn(result, ctx);
        // Report observability for every outcome. Non-Response callbacks
        // (e.g. echoHandler's object return) fall back to the decoded terminal
        // status so they are not silently invisible to onResponse/logging.
        const status =
          out instanceof Response ? out.status : safeTerminalStatus(result);
        runtime.onResponse?.(req, result, status, requestIdStr);
        if (logger) {
          logger.request({
            requestId: requestIdStr,
            method: req.method,
            path: pathForLog(req),
            status,
            durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
            ip: ipStr,
          });
        }
        return out;
      } finally {
        result.invalidate();
        ctx.requestIdHeader = null;
        ctx.origin = null;
      }
    } finally {
      // A zero-copy Response owns the handle until its body is consumed; in
      // every other case (copy mode, terminal/error responses) the buffer is
      // safe to return to the pool immediately.
      if (handle !== null && !responseBorrowsBuffer) {
        handle.release();
      }
      currentHandle = null;
    }
  }

  return {
    run,
    responseHeaders,
    terminalHeaders,
    terminalResponse,
    errorResponse,
    internalErrorResponse,
    withContentType,
    zeroCopyResponse,
  };
}
