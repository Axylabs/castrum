// src/ingress/routes/fallback.ts — Pre-baked fallback handler.

import type { BakedContext, OptimizedIngressHandler } from '../types'
import type { BakedIngressResult } from '../decode/baked-result'
import { runBaked, type BakedHandlerOptions } from './common'

/**
 * Pre-baked fallback handler: 404 for unmatched routes / OPTIONS.
 */
export function fallbackHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  // Result→Response callback, built ONCE per handler (no per-request closure).
  const respond = (result: BakedIngressResult, ctx: BakedContext): Response => {
    const terminal = ingress.terminalResponse(undefined, result, ctx)
    if (terminal) return terminal

    return ingress.errorResponse(undefined, result, 404, 'not_found', 'Not found', ctx)
  }

  return runBaked(ingress, opts, respond)
}
