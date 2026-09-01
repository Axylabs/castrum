// src/ingress/routes/read.ts — Pre-baked GET read handler.

import type { BakedIngressResult } from '../decode/baked-result'
import type { BakedContext, OptimizedIngressHandler } from '../types'
import { type BakedHandlerOptions, buildSuccessInit, runBaked } from './common'

/**
 * Pre-baked GET read handler: returns the ingress body JSON on success.
 */
export function readHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  const copyBody = opts.copyBody !== false

  // Result→Response callback, built ONCE per handler (it depends only on the
  // ingress handle + config, never on the per-request `req`), so the hot path
  // allocates no fresh closure per request.
  const respond = (result: BakedIngressResult, ctx: BakedContext): Response => {
    const terminal = ingress.terminalResponse(undefined, result, ctx)
    if (terminal) return terminal

    if (result.bodyTruncated) {
      return ingress.internalErrorResponse(ctx, result)
    }

    const init = buildSuccessInit(ingress, result, ctx)

    return copyBody
      ? new Response(result.bodyJson(true), init)
      : ingress.zeroCopyResponse(result, ctx, init)
  }

  return runBaked(ingress, opts, respond)
}
