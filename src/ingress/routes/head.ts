// src/ingress/routes/head.ts — Pre-baked HEAD read handler.

import type { BakedContext, OptimizedIngressHandler } from '../types'
import type { BakedIngressResult } from '../decode/baked-result'
import { resolveIp, type BakedHandlerOptions } from './common'
import { secondsFromMs } from '../shared'

/**
 * Pre-baked HEAD read handler: headers only, no body.
 */
export function headHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  // Result→Response callback, built ONCE per handler (no per-request closure).
  const respond = (result: BakedIngressResult, ctx: BakedContext): Response => {
    const terminal = ingress.terminalResponse(undefined, result, ctx)
    if (terminal) return terminal

    if (result.bodyTruncated) {
      return ingress.internalErrorResponse(ctx, result)
    }

    return new Response(null, {
      status: 200,
      headers: ingress.responseHeaders(
        result.headerVariant,
        ctx.requestIdHeader,
        ctx.origin,
        result.rateRemaining,
        result.rateResetMs > 0 ? secondsFromMs(result.rateResetMs) : undefined,
      ),
    })
  }

  return (req, srv) => ingress.run<Response>(req, resolveIp(req, srv, opts), null, respond)
}
