// src/ingress/routes/responder.ts — JS responder bridge over the native
// pipeline ("native decides, JS formats the 2xx").
//
// The responder bridge is the castrum foundation for delegating a WHOLE
// request to the per-route native `IngressInner` while keeping the 2xx body in
// JS: the native pipeline runs parse/validate/CORS/rate-limit/limits and either
// produces a terminal (rejection) response — in the configured envelope style —
// or hands a decoded snapshot to a `NativeResponder` that builds the 2xx.
//
// The sync/async boundary is deliberate: `OptimizedIngressHandler.run()` is
// SYNC-only (`assertSyncCallback` rejects thenables), so the factory captures
// the decoded snapshot (requestId/query/cookies/body/verdicts) INSIDE the sync
// callback and calls the async `responder` OUTSIDE it, after the pooled output
// buffer has been released. `result.body` is the caller-provided request body
// (never the pooled output buffer), so the snapshot's `body` is safe to hold.

import { decoder } from '../../shared/bytes'
import { generateRequestId } from '../../shared/request-id'
import { readBodyWithLimit } from '../body'
import type { BakedIngressResult } from '../decode/baked-result'
import { errorCodeName, errorMessage } from '../errors'
import type { RouteHandler } from '../server'
import { DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from '../shared'
import { safeTerminalStatus } from '../status'
import type {
  BakedContext,
  NativeRequestContext,
  NativeResponder,
  OptimizedIngressHandler,
  TerminalStyle,
} from '../types'
import { type BakedHandlerOptions, resolveIp } from './common'

/** Options for {@link nativeResponderRoute}. */
export interface ResponderRouteOptions extends BakedHandlerOptions {
  /** Terminal envelope style. Default: `'castrum'` (the pre-baked wire). */
  terminalStyle?: TerminalStyle
  /**
   * Read the request body and pass it to the native pipeline for validation
   * (`requireJsonBody`/schema). Default `false` — the framework owns the body
   * (the responder reads it via `ctx.body`); native only needs the bytes when
   * a body stage is enabled in the route's `IngressHandlerOptions`.
   */
  readBody?: boolean
}

/** ignex framework security posture for terminal responses. */
const IGNGEX_SECURITY_HEADERS: [string, string][] = [
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
]

/** Build the ignex-framework terminal envelope (`{error,status,code}` + security headers). */
function buildIgngexTerminal(result: BakedIngressResult, _ctx: BakedContext): Response {
  const preflightAllowed = result.isPreflight && result.corsAllowed
  if (preflightAllowed) {
    return new Response(null, { status: 204, headers: IGNGEX_SECURITY_HEADERS })
  }
  const status = safeTerminalStatus(result)
  const body = JSON.stringify({
    error: errorMessage(status, result.errorCode),
    status,
    code: errorCodeName(result.errorCode),
  })
  const headers = new Headers(IGNGEX_SECURITY_HEADERS)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(body, { status, headers })
}

/** Parse a `queryJson()`/`cookiesJson()` section into an object (empty on failure). */
function parseSection(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Build a responder route: native pipeline decides + rejects (terminal
 * response in the chosen style); on success the JS `responder` builds the 2xx.
 * Returns an async `RouteHandler` (`(req, srv?, params?) => Promise<Response>`).
 */
export function nativeResponderRoute(
  ingress: OptimizedIngressHandler,
  responder: NativeResponder,
  opts: ResponderRouteOptions = {},
): RouteHandler {
  const terminalStyle: TerminalStyle = opts.terminalStyle ?? 'castrum'
  const readBody = opts.readBody ?? false
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS

  return async (req, srv, _params) => {
    const ip = resolveIp(req, srv, opts)
    // The request-id the framework surfaces (same source as the pre-baked path's
    // `ctx.requestIdHeader`): the baked result does not carry it, so generate it
    // here — the native pipeline uses the same rid for its internal frame.
    const requestId = decoder.decode(generateRequestId())
    // Read the body ONLY when native validation needs it (the framework owns
    // the body otherwise). A `BODY_TOO_LARGE`/`REQUEST_TIMEOUT` throw becomes
    // a terminal 413/408 from the native path.
    let body: Uint8Array | null = null
    if (readBody) {
      try {
        body = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs)
      } catch (err) {
        const code = (err as Error & { code?: string }).code
        const status = code === 'REQUEST_TIMEOUT' ? 408 : code === 'BODY_TOO_LARGE' ? 413 : 400
        const payload = JSON.stringify({ error: 'Bad Request', status, code: 'BAD_REQUEST' })
        const headers = new Headers(IGNGEX_SECURITY_HEADERS)
        headers.set('content-type', 'application/json; charset=utf-8')
        return new Response(payload, { status, headers })
      }
    }

    let terminal: Response | null = null
    let snapshot: NativeRequestContext | null = null

    // Sync callback (never returns a thenable). Captures the decoded snapshot
    // or the terminal response, then the async responder runs outside `run()`.
    ingress.run<null>(req, ip, body, (result, ctx) => {
      if (result.terminal || !result.ok) {
        terminal =
          terminalStyle === 'ignex'
            ? buildIgngexTerminal(result, ctx)
            : ingress.terminalResponse(req, result, ctx)
        return null
      }
      const query = parseSection(result.queryJson())
      const cookies = parseSection(result.cookiesJson())
      snapshot = {
        requestId,
        status: result.status,
        rateLimited: result.rateLimited,
        retryAfterMs: result.retryAfterMs,
        query: query as Record<string, string | string[]>,
        cookies: cookies as Record<string, string>,
        body: body ?? new Uint8Array(0),
        ip,
        req,
      }
      return null
    })

    if (terminal !== null) {
      return terminal
    }
    if (snapshot === null) {
      // Native internal error (setInternalError) — the result was never OK.
      return ingress.internalErrorResponse({ requestIdHeader: null, origin: null })
    }
    return responder(snapshot)
  }
}
