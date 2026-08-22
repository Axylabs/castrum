// src/ingress/routes/native.ts — lean per-route native-stack route factory.
//
// A `RouteHandler` backed by the route-wire v3 stack (`createNativeRoute`)
// instead of the full 8-stage `IngressInner`: the native side runs ONLY the
// stages the plan compiled (parseQuery/parseCookies/requireJsonBody/
// validateBody) and returns a packed verdict + pair sections; the responder
// builds the 2xx from the decoded snapshot. This is the leanest per-request
// path — measured `bench/cost/native-route-vs-router.ts`: ~551ns full JS-glue
// path vs ~1131ns router `run()` on a parseQuery+parseCookies route (−580ns).
//
// PURE: the compiled `NativeRoute` is injected (dependency injection across
// the purity boundary) — this factory never touches the dlopen layer itself;
// the impure `createNativeRoute(plan)` call happens in the boundary
// (`router.ts` / `server.ts` `buildRouteHandlers`).
//
// Trade-off (deliberate): the native route stack does NOT do CORS, rate
// limiting, security headers, IP trust, or the castrum metadata envelope — a
// route that needs those must use the full pipeline (`readHandler` /
// `nativeResponderRoute`). This factory is for routes where the framework
// owns the response body and only needs parse + verdict.

import { decoder } from '../../shared/bytes'
import { generateRequestId } from '../../shared/request-id'
import { readBodyWithLimit } from '../body'
import type { NativeRoute } from '../native-route'
import type { RouteHandler } from '../server'
import { DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from '../shared'
import type { NativeRequestContext, NativeResponder } from '../types'
import type { BakedHandlerOptions } from './common'
import { resolveIp } from './common'

/** Options for {@link nativeRouteHandler}. */
export interface NativeRouteHandlerOptions extends BakedHandlerOptions {
  /** Read the request body and pass it for `requireJsonBody`/`validateBody`. */
  readBody?: boolean
}

/** The `+`-to-space / `%XX` decoding is done natively; keys are last-wins. */
function pairsToRecord(pairs: ReadonlyArray<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of pairs) out[k] = v
  return out
}

/**
 * Build a lean native-stack route handler over a COMPILED route (injected —
 * compile via `createNativeRoute` in the boundary, then pass the route here).
 *
 * Terminal verdicts (`errorCode !== 0`) become JSON rejections: 400 for
 * `requireJsonBody` (missing / non-JSON body), 422 for `validateBody` schema
 * failure. On success the responder builds the 2xx from the snapshot.
 *
 * @example
 * ```ts
 * const route = createNativeRoute({ parseQuery: true, parseCookies: true })
 * const handler = nativeRouteHandler(route, (snap) =>
 *   Response.json({ ok: true, query: snap.query, cookies: snap.cookies }),
 * )
 * ```
 */
export function nativeRouteHandler(
  route: NativeRoute,
  responder: NativeResponder,
  opts: NativeRouteHandlerOptions = {},
): RouteHandler {
  const readBody = opts.readBody ?? false
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS
  const parseQuery = route.parseQuery
  const parseCookies = route.parseCookies

  const terminal = (status: number, code: string, message: string): Response =>
    Response.json(
      { ok: false, error: { code, message } },
      { status, headers: { 'content-type': 'application/json' } },
    )

  return async (req, srv, _params) => {
    const ip = resolveIp(req, srv, opts)
    const requestId = decoder.decode(generateRequestId())

    let body: Uint8Array | null = null
    if (readBody) {
      try {
        body = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs)
      } catch (err) {
        const code = (err as Error & { code?: string }).code
        const status = code === 'REQUEST_TIMEOUT' ? 408 : code === 'BODY_TOO_LARGE' ? 413 : 400
        return terminal(status, 'BAD_REQUEST', 'Request body read failed')
      }
    }

    // Extract the query substring + Cookie header (the only request inputs the
    // native stack reads) and run the tiny frame in ONE native call.
    const url = req.url
    const qIndex = url.indexOf('?')
    const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : ''
    const cookieStr = req.headers.get('cookie') ?? ''

    let result
    try {
      result = route.run(queryStr, cookieStr, body)
    } catch {
      return terminal(500, 'INTERNAL', 'Native route run failed')
    }

    if (result.errorCode !== 0) {
      if (result.errorCode === 400) {
        return terminal(400, 'INVALID_JSON', 'Request body must be valid JSON')
      }
      if (result.errorCode === 422) {
        return terminal(422, 'VALIDATION_FAILED', 'Request body failed schema validation')
      }
      return terminal(400, 'BAD_REQUEST', 'Bad request')
    }

    const snapshot: NativeRequestContext = {
      requestId,
      status: 200,
      rateLimited: false,
      retryAfterMs: 0,
      query: parseQuery ? pairsToRecord(result.query) : {},
      cookies: parseCookies ? pairsToRecord(result.cookie) : {},
      body: body ?? new Uint8Array(0),
      ip,
      req,
    }
    return responder(snapshot)
  }
}
