// src/ingress/response/baked-response.ts — pre-baked response builders (path 2)
//
// The seven response-builder methods of `OptimizedIngressHandler`, extracted
// from createIngressHandler (handlers.ts) so the factory stays focused on
// packing + pooling. Mirrors fast.ts's response/terminal.ts split — but emits
// the BENCH wire format (`{"ok":false,"error":{...}}` + `ratelimit-*` headers),
// NOT the fast path's `x-ratelimit-*` shape (see AGENTS.md — do not unify).
//
// The builders are bound to a handler's configuration (header templates,
// request-id emission, CORS cache) plus a shared mutable `BakedResponseState`
// that `run()` in handlers.ts owns: `zeroCopyResponse` marks the pooled
// output buffer as borrowed so `run()` does not release it before the body is
// consumed.

import type { PooledBuffer } from '../../shared/buffer-pool'
import { encoder } from '../../shared/bytes'
import { pooledBodyResponse } from '../../shared/response'
import {
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
  HV_CORS_PREFLIGHT,
  HV_CORS_SIMPLE,
  HV_JSON,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
} from '../constants'
import type { BakedIngressResult } from '../decode/baked-result'
import { secondsFromMs } from '../shared'
import { safeTerminalStatus } from '../status'
import type { BakedContext, OptimizedIngressHandler } from '../types'
import { ERROR_BODIES, ERROR_CODE_BODIES, rateLimitedBody } from './error-bodies'

const EMPTY_BODY = new Uint8Array(0)

/** Shared per-request state between `run()` (handlers.ts) and the builders. */
export interface BakedResponseState {
  /** The pooled output buffer backing the current `run()` (null outside one). */
  currentHandle: PooledBuffer | null
  /** True when a zero-copy Response claimed the buffer (run() must not release). */
  responseBorrowsBuffer: boolean
}

/** Configuration the builder factory needs from a handler. */
export interface BakedResponseBuildersDeps {
  /** Variant-indexed pre-baked header templates (regular responses). */
  headerTemplates: ReadonlyArray<ReadonlyArray<[string, string]>>
  /** Variant-indexed pre-baked terminal templates (JSON + no-store). */
  terminalTemplates: ReadonlyArray<ReadonlyArray<[string, string]>>
  /** Emit an `x-request-id` header on responses. */
  emitRequestIdHeader: boolean
  /** Abandonment guard (ms) for zero-copy responses. */
  zeroCopyTimeoutMs: number
  /** Cache of Origin-augmented header arrays keyed by `variant\u0000origin`. */
  originHeaderCache: Map<string, [string, string][]>
  /** Shared per-request state (owned by `run()` in handlers.ts). */
  state: BakedResponseState
}

/**
 * Build the seven response-builder methods of `OptimizedIngressHandler`
 * (everything except `run`), bound to this handler's header templates and
 * request-id policy. The returned methods are the exact bodies that lived in
 * `createIngressHandler`.
 */
export function buildBakedResponseBuilders(
  deps: BakedResponseBuildersDeps,
): Omit<OptimizedIngressHandler, 'run'> {
  const {
    headerTemplates,
    terminalTemplates,
    emitRequestIdHeader,
    zeroCopyTimeoutMs,
    originHeaderCache,
    state,
  } = deps

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
    if (state.currentHandle === null) {
      // `zeroCopyResponse` must only run inside a live `run()` callback (a
      // pooled output buffer must be in flight). Called outside `run()` the
      // result has already been invalidated and `result.bodyJson` is empty —
      // throw instead of silently serving an empty body.
      throw new Error(
        'zeroCopyResponse() can only be called from within a run() callback ' +
          '(the pooled output buffer is only live during run()).',
      )
    }
    state.responseBorrowsBuffer = true
    return pooledBodyResponse(state.currentHandle, result.bodyJson(false), init, zeroCopyTimeoutMs)
  }

  return {
    responseHeaders,
    terminalHeaders,
    terminalResponse,
    errorResponse,
    internalErrorResponse,
    withContentType,
    zeroCopyResponse,
  }
}
