// src/ingress/routes/common.ts — Shared route-handler options + helpers.

import type { OptimizedIngressHandler } from '../types'

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
