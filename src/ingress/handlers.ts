// src/ingress/handlers.ts — Pre-baked ingress handler functions
//
// A ready-to-use convenience layer for consuming the optimized ingress pipeline
// (native Ingress.handleRequestFullSync) with zero boilerplate. Any system can
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
import { decoder } from "../shared/bytes";
import {
  HV_JSON,
  HV_CORS_SIMPLE,
  HV_CORS_PREFLIGHT,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
} from "./constants";
import { safeTerminalStatus } from "./status";
import { warnTrustProxyDeprecated } from "./options";
import { METHOD_KIND, type HeaderPlan } from "./shared";
import { BakedIngressResult } from "./decode/baked-result";
import { ERROR_BODIES, rateLimitedBody, ERROR_CODE_BODIES } from "./response/error-bodies";
import { buildBakedHeaderTemplates } from "./headers/baked-templates";
import { gatherRawHeaders } from "./packing/gather-raw-headers";

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

const DEFAULT_OUTPUT_BUF_SIZE = 131_072;

// ── Types ────────────────────────────────────────────────────────
export interface BakedContext {
  requestIdHeader: string | null;
  origin: string | null;
}

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
}

/**
 * An optimized ingress handler. `run()` is the zero-alloc pipeline entry
 * point; the response-builder methods are pre-baked and bound to this
 * handler's configuration, so consumers can build custom routes without
 * touching header templates or error bodies.
 */
export interface OptimizedIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T;

  responseHeaders(
    variant: number,
    requestIdHeader: string | null,
    origin: string | null,
    rateRemaining?: number,
    rateResetSecs?: number,
    retryAfterSecs?: number,
  ): [string, string][];

  terminalHeaders(
    variant: number,
    ctx: BakedContext,
    result: BakedIngressResult | null,
  ): [string, string][];

  terminalResponse(
    req: Request,
    result: BakedIngressResult,
    ctx: BakedContext,
  ): Response | null;

  errorResponse(
    req: Request,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response;

  internalErrorResponse(ctx: BakedContext, result?: BakedIngressResult): Response;

  withContentType(
    headers: ReadonlyArray<[string, string]>,
    contentType: string,
  ): [string, string][];

  /**
   * Build a zero-copy `Response` whose body is the request's pooled output
   * slice. The pooled buffer is returned to its pool once the body has been
   * consumed (stream closed) or the request aborted. Use when `copyBody` is
   * `false`; otherwise a copied body is released eagerly at the end of `run()`.
   */
  zeroCopyResponse(
    result: BakedIngressResult,
    ctx: BakedContext,
    init: ResponseInit,
  ): Response;
}

// ── Optimized ingress factory ─────────────────────────────────────
export function createIngressHandler(
  options: Record<string, unknown>,
  runtime: BakedIngressRuntime = {},
): OptimizedIngressHandler {
  if (options.trustProxy === true) {
    warnTrustProxyDeprecated();
  }
  // Lazy: the native addon is only needed once a handler is created.
  const addon = getAddon();
  const NativeIngress = (addon as any).Ingress;
  if (typeof NativeIngress !== "function") {
    throw new Error("Native Ingress class missing. Rebuild the Rust addon.");
  }

  const handler = new NativeIngress(options);
  if (typeof handler.handleRequestFullSync !== "function") {
    throw new Error(
      "Native Ingress.handleRequestFullSync missing. Rebuild the Rust addon.",
    );
  }

  const trust = options.trustProxy === true;
  const rateLimit = options.rateLimit as { limit?: number } | undefined;
  const limit = rateLimit?.limit;
  const rateEnabled =
    typeof limit === "number" && limit !== RATE_LIMIT_U32_MAX && limit > 0;

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust && rateEnabled,
    proto: trust && options.https === undefined,
  };

  const emitRequestIdHeader = runtime.emitRequestIdHeader === true;
  const outputBufferSize = runtime.outputBufferSize ?? DEFAULT_OUTPUT_BUF_SIZE;

  // Built-in structured logger (opt-in; gated by CASTRUM_LOG_LEVEL).
  const logger = runtime.structuredLog === true ? createStructuredLogger() : null;

  // Reusable output-buffer pool: eliminates the per-request output-buffer
  // allocation in handleRequestFullSync by reusing buffers across requests.
  const outputPool = new BufferPool({ initialSize: outputBufferSize });

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

  const headerTemplates = buildBakedHeaderTemplates({
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

    for (; i < template.length; i++) {
      entries[i] = template[i]!;
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
    const base = responseHeaders(
      variant | HV_JSON,
      ctx.requestIdHeader,
      ctx.origin,
      result?.rateRemaining,
      result && result.rateResetMs > 0
        ? Math.ceil(result.rateResetMs / 1000)
        : undefined,
      result && result.retryAfterMs > 0
        ? Math.ceil(result.retryAfterMs / 1000)
        : undefined,
    );

    const out = new Array<[string, string]>(base.length + 1);
    for (let i = 0; i < base.length; i++) {
      out[i] = base[i]!;
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
            ? Math.ceil(result.rateResetMs / 1000)
            : undefined,
          result.retryAfterMs > 0
            ? Math.ceil(result.retryAfterMs / 1000)
            : undefined,
        ),
      });
    }

    const status = safeTerminalStatus(result);

    const body: Uint8Array =
      result.errorCode === ERROR_CODE_RATE_LIMITED
        ? rateLimitedBody(result.retryAfterMs)
        : (ERROR_CODE_BODIES[result.errorCode] ?? ERROR_BODIES.internal!);

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
    for (let i = 0; i < headers.length; i++) {
      out[i] = headers[i]!;
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
    const methodKind = METHOD_KIND[req.method] ?? 7;
    const ridBytes = generateRequestId();
    const requestIdStr = decoder.decode(ridBytes);

    ctx.requestIdHeader = emitRequestIdHeader ? requestIdStr : null;
    ctx.origin = headerPlan.cors ? req.headers.get("origin") : null;

    runtime.onRequest?.(req, requestIdStr, ip);

    // Gather raw headers as [name, value][] — no binary packing in JS.
    // handleRequestFullSync packs them internally in Rust synchronously,
    // eliminating both JS-side encoding and async overhead.
    const headers = gatherRawHeaders(req, headerPlan, methodKind);

    const ipStr = ip ?? EMPTY_IP;

    const handle = outputPool.acquire(outputBufferSize);
    currentHandle = handle;
    responseBorrowsBuffer = false;

    try {
      try {
        // Write into the pooled buffer — no per-request allocation.
        const written = handler.handleRequestFullSyncInto(
          methodKind,
          req.url,
          ipStr,
          requestIdStr,
          headers,
          body,
          handle.buffer,
        );

        const used = handle.buffer.subarray(0, written);
        const outputView = new DataView(
          used.buffer,
          used.byteOffset,
          used.byteLength,
        );

        result.refresh(used, body ?? EMPTY_BODY, outputView);
      } catch (err) {
        result.setInternalError();
        const error = err instanceof Error ? err : new Error(String(err));
        runtime.onError?.(req, requestIdStr, error);
        logger?.error({
          requestId: requestIdStr,
          method: req.method,
          path: new URL(req.url).pathname,
          code: "internal",
          message: error.message,
        });
      }

      try {
        const out = fn(result, ctx);
        if (out instanceof Response) {
          const status = out.status;
          runtime.onResponse?.(req, result, status, requestIdStr);
          if (logger) {
            logger.request({
              requestId: requestIdStr,
              method: req.method,
              path: new URL(req.url).pathname,
              status,
              durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
              ip: ipStr,
            });
          }
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
      if (!responseBorrowsBuffer) {
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
