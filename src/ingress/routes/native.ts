// src/ingress/routes/native.ts — lean per-route native-stack route factory.
//
// A `RouteHandler` backed by the route-wire v6 stack (`createNativeRoute`)
// instead of the full 8-stage `IngressInner`: the native side runs ONLY the
// stages the plan compiled (parseQuery/parseCookies/requireJsonBody/
// validateBody) and returns a packed verdict + either pair sections or a
// response-class projection. A route with no native `response` projection
// hands the decoded snapshot to the JS responder for the 2xx; a projection
// route serves the assembled native response directly (v6). This is the
// leanest per-request path — measured `bench/cost/native-route-vs-router.ts`:
// ~551ns full JS-glue path vs ~1131ns router `run()` on a parseQuery+
// parseCookies route (−580ns).
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
import { abortResponse, isAbortError } from '../abort'
import { readBodyWithLimit } from '../body'
import type { NativeRoute } from '../native-route'
import type { RouteFramePre, RouteWireResult } from '../packing/route-wire'
import type { RouteHandler } from '../server'
import {
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
} from '../shared'
import type { NativeRequestContext, NativeResponder } from '../types'
import type { BakedHandlerOptions } from './common'
import { resolveIp } from './common'
import { assignOwn, safeRecord } from './safe-record'

/** Options for {@link nativeRouteHandler}. */
export interface NativeRouteHandlerOptions extends BakedHandlerOptions {
  /** Read the request body and pass it for `requireJsonBody`/`validateBody`. */
  readBody?: boolean
}

/**
 * Build a prototype-safe record from native packed pairs. The `+`-to-space /
 * `%XX` decoding is done natively; keys are last-wins. Keys are written as OWN
 * data via {@link assignOwn}: `__proto__` is defined (never routed through the
 * inherited setter), and other keys — including `constructor` / `prototype` —
 * are plain own shadowing properties. The record keeps `Object.prototype`.
 *
 * Exported for the prototype-pollution tests.
 *
 * @param pairs - Decoded `[key, value]` pairs from the native route stack.
 * @returns A record with `Object.prototype` preserved (last value wins per key).
 */
export function pairsToRecord(pairs: ReadonlyArray<[string, string]>): Record<string, string> {
  const out = safeRecord()
  for (const [k, v] of pairs) assignOwn(out, k, v)
  return out as Record<string, string>
}

/**
 * Build the native pre-effect frame inputs (method / IP / selected request
 * headers / https) for a program route. Only the headers `HeaderRefs` reads are
 * gathered, and only when present.
 */
function requestPre(req: Request, ip: string): RouteFramePre {
  const headers: Array<[string, string]> = []
  const origin = req.headers.get('origin')
  if (origin !== null) headers.push(['origin', origin])
  const acrm = req.headers.get('access-control-request-method')
  if (acrm !== null) headers.push(['access-control-request-method', acrm])
  const acrh = req.headers.get('access-control-request-headers')
  if (acrh !== null) headers.push(['access-control-request-headers', acrh])
  const xff = req.headers.get('x-forwarded-for')
  if (xff !== null) headers.push(['x-forwarded-for', xff])
  const xri = req.headers.get('x-real-ip')
  if (xri !== null) headers.push(['x-real-ip', xri])
  const xfp = req.headers.get('x-forwarded-proto')
  if (xfp !== null) headers.push(['x-forwarded-proto', xfp])
  let https = false
  try {
    https = new URL(req.url).protocol === 'https:'
  } catch {
    https = xfp === 'https'
  }
  return { methodKind: METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN, ip, headers, https }
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
    // Client already gone: no request-id work, body read, or native run.
    if (req.signal?.aborted) return abortResponse()
    // A projection route echoes the request id through the native substitution
    // section, so pass the generated BYTES straight into the frame (no
    // decode→re-encode). A JS-responder route still needs the string.
    const requestIdBytes = generateRequestId()
    const requestId = route.hasResponse ? '' : decoder.decode(requestIdBytes)

    let body: Uint8Array | null = null
    if (readBody) {
      try {
        body = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs)
      } catch (err) {
        // Client disconnect: the cancelled response, never a 400/408/413.
        if (isAbortError(err)) return abortResponse()
        const code = (err as Error & { code?: string }).code
        const status = code === 'REQUEST_TIMEOUT' ? 408 : code === 'BODY_TOO_LARGE' ? 413 : 400
        return terminal(status, 'BAD_REQUEST', 'Request body read failed')
      }
      // Disconnect while the body was streaming in.
      if (req.signal?.aborted) return abortResponse()
    }

    // Extract the query substring + Cookie header (the only request inputs the
    // native stack reads) and run the tiny frame in ONE native call. Program
    // routes also receive the method/ip/headers pre-effect inputs.
    const url = req.url
    const qIndex = url.indexOf('?')
    const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : ''
    const cookieStr = req.headers.get('cookie') ?? ''
    const pre: RouteFramePre | null = route.hasResponse ? requestPre(req, ip ?? '') : null

    let result: RouteWireResult
    try {
      result = route.run(queryStr, cookieStr, body, pre, requestIdBytes)
    } catch {
      return terminal(500, 'INTERNAL', 'Native route run failed')
    }

    // v6: a response-mode result already carries the selected class +
    // substitution values — assemble and serve the projection directly (this
    // covers OK, CORS preflight, rate-limit and body-verdict classes).
    const served = route.assembleResponse(result)
    if (served !== null) return served

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
