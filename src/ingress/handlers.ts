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

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'
import { BufferPool, type PooledBuffer } from '../shared/buffer-pool'
import { decoder, encoder, viewForArrayBuffer } from '../shared/bytes'
import { createStructuredLogger } from '../shared/log'
import { generateRequestId } from '../shared/request-id'
import { pooledBodyResponse } from '../shared/response'
import {
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
  HV_CORS_PREFLIGHT,
  HV_CORS_SIMPLE,
  HV_JSON,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
  OUT_DATA_START,
} from './constants'
import { BakedIngressResult } from './decode/baked-result'
import { buildBakedHeaderTemplates } from './headers/baked-templates'
import type { SecurityHeadersOptions } from './headers/hsts'
import { buildSecurityPairs } from './headers/hsts'
import {
  assertIngressOptionValues,
  assertKnownIngressOptions,
  type IngressHandlerOptions,
  warnTrustProxyDeprecated,
} from './options'
import { gatherRawHeadersPacked } from './packing/gather-raw-headers'
import { IngressInputPacker } from './packing/input-packer'
import { ERROR_BODIES, ERROR_CODE_BODIES, rateLimitedBody } from './response/error-bodies'
import {
  assertSyncCallback,
  buildHeaderPlan,
  clampIngressBufferSize,
  DEFAULT_BAKED_OUTPUT_BUFFER_SIZE,
  type HeaderPlan,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
  secondsFromMs,
} from './shared'
import { safeTerminalStatus } from './status'
import type { BakedContext, OptimizedIngressHandler } from './types'

// ── Re-exports (back-compat: preserve handlers.ts's original public surface) ──
export { BakedIngressResult } from './decode/baked-result'
export type { IngressHandlerOptions } from './options'
export { ERROR_BODIES } from './response/error-bodies'
export type { BakedHandlerOptions } from './routes'
export {
  deleteHandler,
  echoHandler,
  fallbackHandler,
  headHandler,
  jsonWriteHandler,
  optionsHandler,
  readHandler,
} from './routes'
export type {
  BakedRoute,
  BakedServer,
  CreateIngressServerOptions,
  GracefulShutdownOptions,
  ServerHandle,
} from './server'
export { createIngressServer, gracefulShutdown } from './server'
export type { RouteHandler as IngressNodeRouteHandler } from './server-node'
// Node.js HTTP adapter (same pre-baked route handlers, node:http backend).
export { createIngressServerNode } from './server-node'

const EMPTY_BODY = new Uint8Array(0)
const EMPTY_IP = '0.0.0.0'

/** Sentinel value used by Rust to mean "rate limiting disabled". */
export const RATE_LIMIT_U32_MAX = 4_294_967_295

/**
 * Consecutive `bun:ffi` ingress failures before this handler permanently
 * falls back to the napi addon (a panic that `panic_guard` contained, or a
 * bun:ffi regression that throws). Low enough to recover fast from a flaky
 * transport, high enough that a single transient failure never flips it.
 */
const MAX_FFI_FAILURES = 3

/**
 * Best-effort URL pathname extraction for log/error lines.
 *
 * This runs inside catch/finally paths, so a malformed `req.url` must never
 * throw out of the handler (an uncaught error here would bypass `onError`).
 * Falls back to the raw URL string when parsing fails.
 */
function pathForLog(req: Request): string {
  try {
    return new URL(req.url).pathname
  } catch {
    return req.url
  }
}

/**
 * Merge structured `options.security` (SecurityHeadersOptions) with raw
 * `runtime.securityHeaders` pairs into the ordered entries the baked templates
 * prepend to every response variant. Raw pairs win on name conflicts; names are
 * lowercased for the template merge.
 *
 * The structured defaults (nosniff/DENY/no-referrer) are ONLY applied when the
 * user explicitly opted into security on this path (`security !== undefined`) —
 * the baked path's long-standing default is no security headers, and silently
 * adding them would change every response.
 */
function buildBakedSecurityEntries(
  security: SecurityHeadersOptions | undefined,
  https: boolean | undefined,
  raw: ReadonlyArray<[string, string]> | undefined,
): Array<[string, string]> {
  const structured = security === undefined ? [] : buildSecurityPairs(security, https, true)

  if (raw === undefined || raw.length === 0) return structured

  const byName = new Map<string, string>()
  for (const [k, v] of structured) byName.set(k, v)
  for (const [k, v] of raw) byName.set(k.toLowerCase(), v)
  return [...byName.entries()]
}

// ── Types ────────────────────────────────────────────────────────
// `BakedContext` and `OptimizedIngressHandler` are defined in ./types.ts
// (shared with the route factories) and re-exported here for back-compat.
export type { BakedContext, OptimizedIngressHandler } from './types'

/** Runtime configuration for the pre-baked handler path (`createIngressHandler`). */
export interface BakedIngressRuntime {
  /** Emit an `x-request-id` header on responses. Default: false. */
  emitRequestIdHeader?: boolean
  /** Enable security headers on responses. Default: true. */
  enableSecurityHeaders?: boolean
  /**
   * Ordered `[name, value]` security headers (names are lowercased).
   * NOTE: this PRE-BAKED path takes RAW `[name, value]` pairs here; the
   * fast/async paths (`createIngressFast`/`createIngress`) instead take a
   * structured `security: SecurityHeadersOptions` object (CSP/HSTS builders).
   * The two paths intentionally use different option shapes (see
   * docs/INGRESS.md).
   */
  securityHeaders?: ReadonlyArray<[string, string]>
  /** Native output buffer size in bytes. Default: 131072. */
  outputBufferSize?: number
  /** Invoked before a request is processed (for tracing/context hooks). */
  onRequest?: (req: Request, requestId: string, ip: string | undefined) => void
  /** Invoked after a Response is produced (for metrics/logging hooks). */
  onResponse?: (req: Request, result: BakedIngressResult, status: number, requestId: string) => void
  /**
   * Invoked when the native pipeline fails (the request becomes a 500).
   * Native failures are otherwise silent — wire this to your error tracker.
   */
  onError?: (req: Request, requestId: string, error: Error) => void
  /**
   * Emit one structured JSON line per request/error via the built-in logger
   * (gated by `CASTRUM_LOG_LEVEL`). Default: false.
   */
  structuredLog?: boolean
  /**
   * Custom structured logger (e.g. with a custom stream or extra fields).
   * When provided, request/error lines go here instead of the built-in stderr
   * logger and `structuredLog` is implicitly enabled.
   */
  logger?: ReturnType<typeof createStructuredLogger>
  /**
   * Hard cap on concurrently borrowed output buffers (zero-copy responses not
   * yet consumed). Bounds memory when zero-copy responses are consumed
   * slowly; when exceeded, requests fail with a 500 (pool exhaustion) instead
   * of allocating unbounded temporaries. 0 (default) is unlimited — see
   * `BufferPool.maxInFlight`.
   */
  maxInFlight?: number
  /**
   * Abandonment guard (ms) for zero-copy responses: if a response body is
   * neither pulled nor cancelled within this window, its pooled buffer is
   * released and the stream closed. Bounds memory under abandoned (unread)
   * zero-copy responses. 0 (default) disables it — see `pooledBodyResponse`.
   */
  zeroCopyTimeoutMs?: number
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
  assertKnownIngressOptions(options, 'createIngressHandler')
  assertIngressOptionValues(options, 'createIngressHandler')
  if (options.trustProxy === true) {
    warnTrustProxyDeprecated()
  }
  // Lazy: the native addon is only needed once a handler is created.
  const addon = getAddon()
  const NativeIngress = addon.Ingress
  if (typeof NativeIngress !== 'function') {
    throw new Error('Native Ingress class missing. Rebuild the Rust addon.')
  }

  const handler = new NativeIngress(options)
  if (typeof handler.handleRequestPacked !== 'function') {
    throw new Error('Native Ingress.handleRequestPacked missing. Rebuild the Rust addon.')
  }

  // Bun fast path: drive the SAME native pipeline through `bun:ffi` (opaque
  // inner handle from `ingressInnerPtr`), cutting the per-request N-API
  // crossing. The handle is valid only while `handler` is alive — this closure
  // holds `handler` for the handler's lifetime, so it can never dangle. Falls
  // back to napi when ffi is unavailable, the addon lacks the pointer method,
  // or the handle is 0 (i.e. the state was dropped).
  const bunFFI = getBunFFI()
  // The opaque handle is a u64 under the 2^53 number range, so convert it to a
  // plain JS number ONCE here — bun:ffi converts a BigInt argument to a number
  // on every call anyway (and docs note BigInt is slower), so passing a number
  // removes that per-request conversion on the hottest path.
  const ingressPtr =
    bunFFI !== null && typeof handler.ingressInnerPtr === 'function'
      ? Number(handler.ingressInnerPtr())
      : 0

  const rateLimit = options.rateLimit as { limit?: number } | undefined
  const limit = rateLimit?.limit
  const rateEnabled = typeof limit === 'number' && limit !== RATE_LIMIT_U32_MAX && limit > 0

  // Shared with the fast path — proxy extraction is driven by trust config
  // (trustProxy / trustedProxies), not by whether rate limiting is enabled.
  const headerPlan: HeaderPlan = buildHeaderPlan(options)

  const emitRequestIdHeader = runtime.emitRequestIdHeader === true
  const zeroCopyTimeoutMs = runtime.zeroCopyTimeoutMs ?? 0
  const outputBufferSize = clampIngressBufferSize(
    runtime.outputBufferSize ?? DEFAULT_BAKED_OUTPUT_BUFFER_SIZE,
    OUT_DATA_START,
  )

  // Built-in structured logger (opt-in; gated by CASTRUM_LOG_LEVEL). A custom
  // `runtime.logger` overrides it and implies structuredLog:true.
  const logger =
    runtime.logger ?? (runtime.structuredLog === true ? createStructuredLogger() : null)

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
  )

  // Reusable output-buffer pool: eliminates the per-request output-buffer
  // allocation by reusing buffers across requests.
  // `maxInFlight` (when set) bounds zero-copy borrowing under slow consumers.
  const outputPool = new BufferPool({
    initialSize: outputBufferSize,
    maxInFlight: runtime.maxInFlight,
  })

  // Reusable packed-input builder (same zero-alloc discipline as the fast
  // path): the per-request frame is packed into this buffer instead of paying
  // the napi `Vec<Vec<String>>` header marshaling of the full_sync family.
  const inputPacker = new IngressInputPacker()

  // Per-call state: the output handle backing the current `run()`'s result,
  // and whether a zero-copy Response claimed it (so `run()` must not release
  // it back to the pool before the body is consumed).
  let currentHandle: PooledBuffer | null = null
  let responseBorrowsBuffer = false

  // FFI circuit breaker (defense-in-depth): the raw C ABI cannot contain
  // non-panic UB (a segfault still crashes the process), but a RECURRING
  // observable failure — a panic that `panic_guard` turned into 0 → throw, or
  // a bun:ffi regression that throws — is caught here and permanently
  // re-routed to the napi fallback (crash-safe via napi-rs catch_unwind), so a
  // flaky FFI path degrades to a correct response instead of a failure storm.
  let ffiFailures = 0
  let ffiDisabled = false

  // Cache Origin-augmented header arrays keyed by `variant\u0000origin` (the
  // steady-state CORS case: the pre-baked template + one
  // `access-control-allow-origin` row). Callers treat the returned array as
  // read-only (the `Headers`/`Response` constructors copy entries), so every
  // distinct (variant, origin) is reused after its first hit — removing the
  // per-request array alloc + copy when an Origin header is present. Only
  // ALLOWED origins reach the CORS-allowed path (the native pipeline gates the
  // variant on CORS approval), so the map stays bounded by the configured
  // allow-origin list (+ a couple of preflight variants).
  const originHeaderCache = new Map<string, [string, string][]>()

  // ── Variant-indexed header templates (precomputed once) ──
  const cors = options.cors as
    | {
        allowOrigin?: string[]
        allowMethods?: string[]
        allowHeaders?: string[]
        exposeHeaders?: string[]
        allowCredentials?: boolean
        maxAge?: number
      }
    | undefined

  // Security headers: honor the STRUCTURED `options.security`
  // (SecurityHeadersOptions — the same shape `createIngress` honors) merged
  // with raw `runtime.securityHeaders` pairs (raw wins on name conflicts).
  // This closes the historic gotcha where `options.security` was silently
  // ignored on the pre-baked path. When neither is provided, no security
  // headers are emitted (the baked path's long-standing default).
  const securityEntries: ReadonlyArray<[string, string]> =
    runtime.enableSecurityHeaders === false
      ? Object.freeze([] as [string, string][])
      : Object.freeze(
          buildBakedSecurityEntries(options.security, options.https, runtime.securityHeaders),
        )

  const corsAllowMethods = cors?.allowMethods?.join(', ') ?? ''
  const corsAllowHeaders = cors?.allowHeaders?.join(', ') ?? ''
  const corsExposeHeaders = cors?.exposeHeaders?.join(', ') ?? ''
  const corsMaxAge = cors?.maxAge != null ? String(cors.maxAge) : ''
  const rateLimitStr = rateEnabled ? String(limit) : ''

  const { regular: headerTemplates, terminal: terminalTemplates } = buildBakedHeaderTemplates({
    securityEntries,
    cors,
    corsAllowMethods,
    corsAllowHeaders,
    corsExposeHeaders,
    corsMaxAge,
    rateLimitStr,
  })

  function responseHeaders(
    variant: number,
    requestIdHeader: string | null,
    origin: string | null,
    rateRemaining?: number,
    rateResetSecs?: number,
    retryAfterSecs?: number,
  ): [string, string][] {
    const template: ReadonlyArray<[string, string]> =
      headerTemplates[variant & 31] ?? headerTemplates[0] ?? []

    const needsRequestId = emitRequestIdHeader && requestIdHeader !== null
    const needsOrigin =
      ((variant & HV_CORS_SIMPLE) !== 0 || (variant & HV_CORS_PREFLIGHT) !== 0) && origin !== null
    const needsRate = (variant & HV_RATE_ACTIVE) !== 0
    const needsRetry = (variant & HV_RATE_LIMITED) !== 0

    if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
      // Frozen-readonly → mutable: callers only ever read the baked template
      // (zero-copy steady-state path), so the widening is safe in practice.
      return template as unknown as [string, string][]
    }

    if (!needsRequestId && !needsRate && !needsRetry && needsOrigin) {
      // Steady-state CORS: only the origin varies — cache the augmented array
      // per (variant, origin) so the Origin-present case (the common
      // browser/bench case) stays allocation-free after the first hit for EACH
      // distinct origin (a single-slot memo thrashed when clients alternate
      // between allowed origins, allocating a fresh array on every switch).
      const key = `${variant & 31}\u0000${origin as string}`
      const cached = originHeaderCache.get(key)
      if (cached !== undefined) {
        return cached
      }
      const entries = new Array<[string, string]>(template.length + 1)
      let i = 0
      for (const pair of template) {
        entries[i++] = pair
      }
      entries[i] = ['access-control-allow-origin', origin as string]
      originHeaderCache.set(key, entries)
      return entries
    }

    let extra = 0
    if (needsRequestId) extra++
    if (needsOrigin) extra++
    if (needsRate) extra += 2
    if (needsRetry) extra++

    const entries = new Array<[string, string]>(template.length + extra)
    let i = 0

    for (const pair of template) {
      entries[i++] = pair
    }

    if (needsRequestId) {
      entries[i++] = ['x-request-id', requestIdHeader as string]
    }

    if (needsOrigin) {
      entries[i++] = ['access-control-allow-origin', origin as string]
    }

    if (needsRate) {
      entries[i++] = ['ratelimit-remaining', String(rateRemaining ?? 0)]
      entries[i++] = ['ratelimit-reset', String(rateResetSecs ?? 0)]
    }

    if (needsRetry) {
      entries[i++] = ['retry-after', String(retryAfterSecs ?? 0)]
    }

    return entries
  }

  function terminalHeaders(
    variant: number,
    ctx: BakedContext,
    result: BakedIngressResult | null,
  ): [string, string][] {
    const v = variant | HV_JSON
    const requestIdHeader = ctx.requestIdHeader
    const origin = ctx.origin
    const rateResetSecs =
      result && result.rateResetMs > 0 ? secondsFromMs(result.rateResetMs) : undefined
    const retryAfterSecs =
      result && result.retryAfterMs > 0 ? secondsFromMs(result.retryAfterMs) : undefined

    const needsRequestId = emitRequestIdHeader && requestIdHeader !== null
    const needsOrigin =
      ((v & HV_CORS_SIMPLE) !== 0 || (v & HV_CORS_PREFLIGHT) !== 0) && origin !== null
    const needsRate = (v & HV_RATE_ACTIVE) !== 0
    const needsRetry = (v & HV_RATE_LIMITED) !== 0

    // Steady state: no request-id/origin/rate extras — serve the pre-baked
    // terminal template (JSON + `cache-control: no-store`) directly with zero
    // per-response array allocation/copy.
    if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
      // Frozen-readonly → mutable: the baked terminal template is only read.
      return terminalTemplates[v & 31] as unknown as [string, string][]
    }

    // Rare path: extras appended after the baked entries, then `cache-control`.
    const base = responseHeaders(
      v,
      requestIdHeader,
      origin,
      result?.rateRemaining,
      rateResetSecs,
      retryAfterSecs,
    )

    const out = new Array<[string, string]>(base.length + 1)
    let i = 0
    for (const pair of base) {
      out[i++] = pair
    }
    out[base.length] = ['cache-control', 'no-store']
    return out
  }

  function terminalResponse(
    _req: Request | undefined,
    result: BakedIngressResult,
    ctx: BakedContext,
  ): Response | null {
    if (!result.terminal) {
      return null
    }

    const preflightAllowed = result.isPreflight && result.corsAllowed

    if (preflightAllowed) {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(
          result.headerVariant,
          ctx.requestIdHeader,
          ctx.origin,
          result.rateRemaining,
          result.rateResetMs > 0 ? secondsFromMs(result.rateResetMs) : undefined,
          result.retryAfterMs > 0 ? secondsFromMs(result.retryAfterMs) : undefined,
        ),
      })
    }

    const status = safeTerminalStatus(result)

    const body: Uint8Array =
      result.errorCode === ERROR_CODE_RATE_LIMITED
        ? rateLimitedBody(result.retryAfterMs)
        : (ERROR_CODE_BODIES[result.errorCode] ?? ERROR_BODIES.internal ?? EMPTY_BODY)

    return new Response(body, {
      status,
      headers: terminalHeaders(result.headerVariant, ctx, result),
    })
  }

  function errorResponse(
    _req: Request | undefined,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response {
    const body =
      ERROR_BODIES[code] ?? encoder.encode(JSON.stringify({ ok: false, error: { code, message } }))

    return new Response(body, {
      status,
      headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result),
    })
  }

  function internalErrorResponse(ctx: BakedContext, result?: BakedIngressResult): Response {
    return new Response(ERROR_BODIES.internal, {
      status: 500,
      headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result ?? null),
    })
  }

  function withContentType(
    headers: ReadonlyArray<[string, string]>,
    contentType: string,
  ): [string, string][] {
    const out = new Array<[string, string]>(headers.length + 1)
    let i = 0
    for (const pair of headers) {
      out[i++] = pair
    }
    out[headers.length] = ['content-type', contentType]
    return out
  }

  function zeroCopyResponse(
    result: BakedIngressResult,
    _ctx: BakedContext,
    init: ResponseInit,
  ): Response {
    if (currentHandle === null) {
      // `zeroCopyResponse` must only run inside a live `run()` callback (a
      // pooled output buffer must be in flight). Called outside `run()` the
      // result has already been invalidated and `result.bodyJson` is empty —
      // throw instead of silently serving an empty body.
      throw new Error(
        'zeroCopyResponse() can only be called from within a run() callback ' +
          '(the pooled output buffer is only live during run()).',
      )
    }
    responseBorrowsBuffer = true
    return pooledBodyResponse(currentHandle, result.bodyJson(false), init, zeroCopyTimeoutMs)
  }

  const result = new BakedIngressResult()
  const ctx: BakedContext = {
    requestIdHeader: null,
    origin: null,
  }

  function run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T {
    const startedAt = logger ? performance.now() : 0
    const methodKind = METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN
    const ridBytes = generateRequestId()
    const requestIdStr = needRequestIdString ? decoder.decode(ridBytes) : ''

    ctx.requestIdHeader = emitRequestIdHeader ? requestIdStr : null
    ctx.origin = headerPlan.cors ? req.headers.get('origin') : null

    runtime.onRequest?.(req, requestIdStr, ip)

    const ipStr = ip ?? EMPTY_IP

    // Pack the request frame in JS (reusing the fast path's zero-alloc packer
    // discipline) and drive the same native core as `handleRequestPacked`.
    // This removes the per-request `[name, value][]` header marshaling + napi
    // `Vec<Vec<String>>` and the request-id string re-encode that the
    // full_sync family paid on every request. The response wire format is
    // unchanged because both entries run the identical `handle_packed` core.
    let handle: PooledBuffer | null = null
    currentHandle = null
    responseBorrowsBuffer = false

    try {
      // Pack the request frame (inside the try: an unexpected packing failure
      // is reported by the escaping-error catch below — it must never leak the
      // request without accounting). `ctx.origin` was already fetched once
      // above, so pass it in to avoid a second `req.headers.get('origin')`
      // native→JS string conversion on the hot path.
      const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, ctx.origin)
      // url/ip are encoded directly into the packer buffer (no intermediate
      // `encoder.encode` Uint8Array + copy); requestId/headers are byte slices
      // copied verbatim (no decode→re-encode of the pre-encoded request id).
      const input = inputPacker.packParts(methodKind, req.url, ip, ridBytes, packedHeaders)

      try {
        // Acquire inside the try: pool exhaustion (maxInFlight) becomes a 500
        // via setInternalError — never an uncaught exception out of run().
        handle = outputPool.acquire(outputBufferSize)
        currentHandle = handle

        // Write into the pooled buffer — no per-request allocation. Under Bun
        // with a live ffi handle this runs the pipeline through `bun:ffi`
        // (identical packed wire format); otherwise the napi call. If the ffi
        // call throws (native reported 0 = error, or a panic `panic_guard`
        // contained), re-dispatch through napi once and, after repeated
        // failures, permanently disable ffi for this handler.
        let written: number
        if (bunFFI !== null && ingressPtr !== 0 && !ffiDisabled) {
          try {
            written = bunFFI.ingressHandlePacked(ingressPtr, input, body, handle.buffer)
            ffiFailures = 0
          } catch {
            ffiFailures++
            if (ffiFailures >= MAX_FFI_FAILURES) {
              ffiDisabled = true
            }
            // napi re-run: crash-safe (napi-rs catch_unwind) and semantically
            // identical — a transient ffi panic still serves the request.
            written = handler.handleRequestPacked(input, body, handle.buffer)
          }
        } else {
          written = handler.handleRequestPacked(input, body, handle.buffer)
        }

        const used = handle.buffer.subarray(0, written)
        // Cached per-ArrayBuffer DataView: no per-request view allocation.
        result.refresh(used, body ?? EMPTY_BODY, viewForArrayBuffer(used.buffer, used.byteOffset))
      } catch (err) {
        result.setInternalError()
        const error = err instanceof Error ? err : new Error(String(err))
        runtime.onError?.(req, requestIdStr, error)
        logger?.error({
          requestId: requestIdStr,
          method: req.method,
          path: pathForLog(req),
          code: 'internal',
          message: error.message,
        })
      }

      try {
        const out = fn(result, ctx)
        // The ingress result is invalidated when run() returns, so an async
        // callback would observe a stale/zeroed result — reject it up front
        // (parity with the fast path / createIngressSync).
        assertSyncCallback(out, 'createIngressHandler().run()')
        // Report observability for every outcome. Non-Response callbacks
        // (e.g. echoHandler's object return) fall back to the decoded terminal
        // status so they are not silently invisible to onResponse/logging.
        const status = out instanceof Response ? out.status : safeTerminalStatus(result)
        runtime.onResponse?.(req, result, status, requestIdStr)
        if (logger) {
          logger.request({
            requestId: requestIdStr,
            method: req.method,
            path: pathForLog(req),
            status,
            durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
            ip: ipStr,
          })
        }
        return out
      } finally {
        result.invalidate()
        ctx.requestIdHeader = null
        ctx.origin = null
      }
    } catch (err) {
      // An unexpected error escaped run() after onRequest (a packing failure
      // before the native call, or a throwing route callback). Report it so
      // request accounting completes (metrics in_flight must not leak), then
      // rethrow for the caller. The native-failure path above does NOT rethrow,
      // so this fires at most once per request.
      if (responseBorrowsBuffer && handle !== null) {
        // `zeroCopyResponse` was called but the Response never escaped (the
        // callback threw): the stream that would release the pooled buffer was
        // never delivered. Release it here so the buffer isn't stuck in flight
        // forever.
        handle.release()
        handle = null
        responseBorrowsBuffer = false
      }
      const error = err instanceof Error ? err : new Error(String(err))
      runtime.onError?.(req, requestIdStr, error)
      logger?.error({
        requestId: requestIdStr,
        method: req.method,
        path: pathForLog(req),
        code: 'internal',
        message: error.message,
      })
      throw error
    } finally {
      // A zero-copy Response owns the handle until its body is consumed; in
      // every other case (copy mode, terminal/error responses) the buffer is
      // safe to return to the pool immediately.
      if (handle !== null && !responseBorrowsBuffer) {
        handle.release()
      }
      currentHandle = null
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
  }
}
