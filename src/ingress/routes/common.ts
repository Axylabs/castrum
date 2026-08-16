// src/ingress/routes/common.ts — Shared route-handler options + helpers.

import type { BakedContext, OptimizedIngressHandler } from '../types'
import type { BakedIngressResult } from '../decode/baked-result'
import { secondsFromMs } from '../shared'

/** Options accepted by the pre-baked route factories. */
export interface BakedHandlerOptions {
  /** Resolve the client IP from the server object (e.g. `srv.requestIP`). */
  getIp?: (req: Request, srv: unknown) => string | undefined
  /** Copy body slices instead of sharing the native buffer. Default: true (safe). */
  copyBody?: boolean
  /** Maximum request body bytes for write/echo handlers. Default: 1 MiB. */
  maxBodyBytes?: number
  /**
   * Overall deadline (ms) for reading the request body. Default: 30s
   * (`DEFAULT_BODY_TIMEOUT_MS`). Set `0` to disable. Protects against
   * slowloris / trickling bodies.
   */
  bodyTimeoutMs?: number
  /** Fallback handler used for write error paths. Defaults to the write ingress. */
  fallback?: OptimizedIngressHandler
  /**
   * When true, route the JSON-validity fallback check through the higher-order
   * loader (`loader("jsonValid")`) instead of the direct native call —
   * exercising the loader's dispatch + counters on the real request path.
   * Default: false (the direct call is marginally faster for a single request;
   * the loader pays off for same-tick bursts / bulk work, see src/integration/batch.ts).
   */
  enableLoader?: boolean
}

/** Resolve the client IP for a route request via the configured getter. */
export function resolveIp(
  req: Request,
  srv: unknown,
  opts: BakedHandlerOptions,
): string | undefined {
  return opts.getIp ? opts.getIp(req, srv) : undefined
}

/**
 * Build the success `ResponseInit` (status + ratelimit headers) shared by
 * every pre-baked success path. A plain function call, so the hot path keeps
 * its single init-object allocation and nothing else.
 *
 * @param status Success status; defaults to 200.
 */
export function buildSuccessInit(
  ingress: OptimizedIngressHandler,
  result: BakedIngressResult,
  ctx: BakedContext,
  status = 200,
): ResponseInit {
  return {
    status,
    headers: ingress.responseHeaders(
      result.headerVariant,
      ctx.requestIdHeader,
      ctx.origin,
      result.rateRemaining,
      result.rateResetMs > 0 ? secondsFromMs(result.rateResetMs) : undefined,
    ),
  }
}

/**
 * Wrap a `(result, ctx) => Response` responder in the shared sync route
 * runner: resolve the client IP once and dispatch through the native pipeline
 * (`ingress.run` with a null body). Used by the read / head / fallback route
 * factories whose responder never needs the request object.
 */
export function runBaked(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions,
  respond: (result: BakedIngressResult, ctx: BakedContext) => Response,
): (req: Request, srv?: unknown) => Response {
  return (req, srv) => ingress.run<Response>(req, resolveIp(req, srv, opts), null, respond)
}
