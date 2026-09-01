// src/ingress/response/terminal.ts — Terminal (error) response builder (fast
// path).
//
// Builds the fast-path terminal response: {"error":{code,status,message,
// requestId}} with x-ratelimit-* headers. This is the fast-path wire format;
// the pre-baked path has its own builders (see ./handlers.ts) — do not unify
// them (see AGENTS.md).

import { errorCodeName, errorMessage } from '../errors'
import { headersForResult, type ResponseBuildContext } from '../headers/fast-templates'
import { safeTerminalStatus } from '../status'

/**
 * Build a terminal response for a result, or `null` when the result is not
 * terminal (the caller should serve the body instead).
 */
export function buildTerminalResponse(
  ctx: ResponseBuildContext,
  r: {
    readonly terminal: boolean
    readonly isPreflight: boolean
    readonly corsAllowed: boolean
    readonly errorCode: number
    readonly status: number
    readonly headerVariant: number
    readonly https: boolean
    readonly rateLimit: number
    readonly rateRemaining: number
    readonly rateResetMs: number
    readonly retryAfterMs: number
  },
  req: Request,
  requestId: string,
): Response | null {
  if (!r.terminal) return null

  const preflightAllowed = r.isPreflight && r.corsAllowed
  const headers = headersForResult(ctx, r, req, requestId)

  if (preflightAllowed) {
    return new Response(null, { status: 204, headers })
  }

  const status = safeTerminalStatus(r)

  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')

  const payload = JSON.stringify({
    error: {
      code: errorCodeName(r.errorCode),
      status,
      message: errorMessage(status, r.errorCode),
      requestId: requestId || undefined,
    },
  })

  return new Response(payload, { status, headers })
}
