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
//   - response/baked-response.ts   pre-baked response builders (baked wire)
//   - headers/security.ts          security header merge
//   - headers/baked-templates.ts   ratelimit-* header templates
//   - packing/gather-raw-headers.ts raw header gathering
//   - routes/*                     route factories
//   - server.ts                    Bun.serve builder

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'
import { BufferPool, type PooledBuffer } from '../shared/buffer-pool'
import { decoder, viewForArrayBuffer } from '../shared/bytes'
import { createStructuredLogger } from '../shared/log'
import { generateRequestId } from '../shared/request-id'
import { OUT_DATA_START } from './constants'
import { BakedIngressResult } from './decode/baked-result'
import { buildBakedHeaderTemplates } from './headers/baked-templates'
import { buildBakedSecurityEntries } from './headers/security'
import {
  assertIngressOptionValues,
  assertKnownIngressOptions,
  type IngressHandlerOptions,
  warnTrustProxyDeprecated,
} from './options'
import { gatherRawHeadersPacked } from './packing/gather-raw-headers'
import { IngressInputPacker } from './packing/input-packer'
import { type BakedResponseState, buildBakedResponseBuilders } from './response/baked-response'
import {
  assertSyncCallback,
  buildHeaderPlan,
  clampIngressBufferSize,
  DEFAULT_BAKED_OUTPUT_BUFFER_SIZE,
  type HeaderPlan,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
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
  nativeResponderRoute,
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

  // Minimal-processing flags: skip per-request JS UTF-8 encoding of the URL/IP
  // when the native pipeline (rust/ingress/pipeline.rs) provably cannot read
  // them — mirror its consumption exactly, and KEEP IN SYNC:
  //   - URL is consumed iff parseQuery (extract_query), emitMetadataJson
  //     (extract_path into the envelope) or https is unpinned (detect_https
  //     scans the scheme prefix). Otherwise an empty URL section is safe.
  //   - IP is consumed iff rate limiting is active (resolve_client_ip /
  //     rate_key) or a proxy-trust mode is configured (socket_is_trusted
  //     parses it). Otherwise the IP is dropped from the frame (logs/hooks
  //     still see the real `ip` — this only skips the frame encode).
  const trustEnabled = options.trustProxy === true || options.trustedProxies?.enabled === true
  const urlNeeded =
    options.parseQuery === true || options.emitMetadataJson === true || options.https === undefined
  const ipNeeded = rateEnabled || trustEnabled

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

  // Shared per-request state with the response builders
  // (response/baked-response.ts): `zeroCopyResponse` marks the pooled output
  // buffer as borrowed so `run()` must not release it before the body is
  // consumed. The result decoders share a single mutable object too, so this
  // is the same pattern — one live request per handler at a time.
  const responseState: BakedResponseState = { currentHandle: null, responseBorrowsBuffer: false }

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

  // Response builders, pre-bound to this handler's header templates, request-id
  // policy, CORS cache and shared per-request state. This is the extracted
  // response/terminal family (see response/baked-response.ts) — identical
  // bodies, now living next to response/error-bodies.ts for navigability.
  const responseBuilders = buildBakedResponseBuilders({
    headerTemplates,
    terminalTemplates,
    emitRequestIdHeader,
    zeroCopyTimeoutMs,
    originHeaderCache,
    state: responseState,
  })

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
    responseState.currentHandle = null
    responseState.responseBorrowsBuffer = false

    try {
      // Pack the request frame (inside the try: an unexpected packing failure
      // is reported by the escaping-error catch below — it must never leak the
      // request without accounting). `ctx.origin` was already fetched once
      // above, so pass it in to avoid a second `req.headers.get('origin')`
      // native→JS string conversion on the hot path.
      const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, ctx.origin)
      // Minimal processing: when the native pipeline cannot read the URL/IP
      // (see `urlNeeded`/`ipNeeded`), pass an empty URL / omit the IP so we
      // skip the per-request JS UTF-8 encode entirely (the frame still carries
      // a valid 0-length section the native bounds-checks).
      const packUrl = urlNeeded ? req.url : ''
      const packIp = ipNeeded ? ip : undefined

      try {
        // Acquire inside the try: pool exhaustion (maxInFlight) becomes a 500
        // via setInternalError — never an uncaught exception out of run().
        handle = outputPool.acquire(outputBufferSize)
        responseState.currentHandle = handle

        // Write into the pooled buffer — no per-request allocation. Bun
        // PRIMARY: the raw-components C-ABI (`castrum_ingress_handle_components`)
        // passes `url`/`ip` as `bun:ffi` `cstring` args — the engine transcodes
        // the JS strings to call-scoped UTF-8 in-engine, so we skip the JS
        // frame assembly + `Buffer.write` encode for the URL/IP (same wire
        // format: both paths run the shared `handle_components` core). Falls
        // back to the packed frame (FFI or napi) on any failure / stale addon.
        // If an ffi call throws (native reported 0 = error, or a panic
        // `panic_guard` contained), re-dispatch through napi once and, after
        // repeated failures, permanently disable ffi for this handler.
        let written: number
        if (
          bunFFI !== null &&
          ingressPtr !== 0 &&
          !ffiDisabled &&
          typeof bunFFI.ingressHandleComponents === 'function'
        ) {
          try {
            written = bunFFI.ingressHandleComponents(
              ingressPtr,
              methodKind,
              packUrl,
              packIp ?? '',
              ridBytes,
              packedHeaders,
              body,
              handle.buffer,
            )
            ffiFailures = 0
          } catch {
            ffiFailures++
            if (ffiFailures >= MAX_FFI_FAILURES) {
              ffiDisabled = true
            }
            // napi re-run: crash-safe (napi-rs catch_unwind) and semantically
            // identical — a transient ffi panic still serves the request. The
            // packed frame respects the same url/ip minimal-processing.
            const input = inputPacker.packParts(
              methodKind,
              packUrl,
              packIp,
              ridBytes,
              packedHeaders,
            )
            written = handler.handleRequestPacked(input, body, handle.buffer)
          }
        } else if (bunFFI !== null && ingressPtr !== 0 && !ffiDisabled) {
          const input = inputPacker.packParts(methodKind, packUrl, packIp, ridBytes, packedHeaders)
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
          const input = inputPacker.packParts(methodKind, packUrl, packIp, ridBytes, packedHeaders)
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
      if (responseState.responseBorrowsBuffer && handle !== null) {
        // `zeroCopyResponse` was called but the Response never escaped (the
        // callback threw): the stream that would release the pooled buffer was
        // never delivered. Release it here so the buffer isn't stuck in flight
        // forever.
        handle.release()
        handle = null
        responseState.responseBorrowsBuffer = false
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
      if (handle !== null && !responseState.responseBorrowsBuffer) {
        handle.release()
      }
      responseState.currentHandle = null
    }
  }

  // Native JSON-validity capability for the pure route factories: the zero-DOM
  // `json_valid` fast path (same one the pipeline uses), routed through the
  // primary bun:ffi transport with the napi fallback. Exposed on the handler so
  // `routes/json-write.ts` validates request bodies via DI — it must not import
  // the native layer (purity boundary).
  const nativeJsonValid = (bytes: Uint8Array): boolean =>
    bunFFI !== null && typeof bunFFI.jsonValid === 'function'
      ? bunFFI.jsonValid(bytes)
      : addon.jsonValid(bytes)

  return {
    run,
    ...responseBuilders,
    jsonValid: nativeJsonValid,
  }
}
