// src/ingress/native-route.ts — public per-route native stack factory.
//
// `createNativeRoute` compiles a route-wire v6 descriptor ONCE (via the
// `castrum_route_*` C-ABI / napi `Route` surface over `rust/ingress/
// native_route.rs`) and runs each request frame in ONE native call — the same
// lean per-route stack `@ignex/native`'s `createNativeRoute` consumes. This
// brings that stack into castrum itself: routes that only need query/cookie
// parse + `requireJsonBody`/`validateBody` verdicts (no CORS/rate-limit/
// security/IP/metadata envelope) get the leanest possible per-request path —
// measured `bench/cost/native-route-vs-router.ts`: ~551ns full JS-glue path
// vs ~1131ns router `run()` on a parseQuery+parseCookies route (−580ns).
//
// v6: when the plan carries a `response`/`program` projection, the native side
// returns the selected class + substitution slots only. `createNativeRoute`
// compiles the per-class templates (memoized `Headers` + pre-encoded body
// segments) and serves them with `assembleResponse(result)` — no full response
// frame is decoded on the hot path.
//
// IMPURE by design (dlopen + FFI): it lives at the boundary like
// `handlers.ts`/`server.ts`; the byte wire helpers it uses are the PURE
// `src/ingress/packing/route-wire.ts`.

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'
import type { BunFFI } from '../native/ffi/types'
import { buildProgramPlan, type ProgramPlanOptions } from './pre-effects'
import {
  assembleRouteResponse,
  compileResponseTemplate,
  compileResponseTemplates,
  decodeRouteResult,
  encodeProgram,
  encodeRouteDescriptor,
  packRawHeadersPacked,
  packRouteFrame,
  ROUTE_CLASS,
  ROUTE_FLAG,
  ROUTE_PART,
  ROUTE_STAGE,
  type RouteFramePre,
  type RouteStageTag,
  type RouteWireLimits,
  type RouteWireResponse,
  type RouteWireResult,
  type RouteWireTemplateSet,
} from './packing/route-wire'

/** Plan for a compiled native route (the stage/limit/schema surface). */
export interface NativeRoutePlan {
  /** Parse + lenient-decode the query string into pairs (stage 0). */
  parseQuery?: boolean
  /** Parse + lenient-decode the Cookie header into pairs (stage 1). */
  parseCookies?: boolean
  /** Reject a missing / non-JSON body with 400 (stage 5, first-failure-wins). */
  requireJsonBody?: boolean
  /** Validate the body against `schema` with 422 on failure (stage 4). */
  validateBody?: boolean
  /** Draft-07 JSON schema bytes for the body (`validateBody`). */
  schema?: Uint8Array
  /** Native 2xx response projection (v4 `response` part). */
  response?: RouteWireResponse
  /**
   * Native op-program config (v5 `program` part): parse, CORS / rate-limit /
   * security / IP trust, and body validation lowered to registered ops.
   * Requires `response` (the OK body/headers the class templates derive from).
   * Built with `buildProgramPlan`, which reuses the JS header/body builders.
   */
  program?: ProgramPlanOptions
  /** Max body bytes before `requireJsonBody`/`validateBody` fail (default 2 MiB). */
  maxBodyBytes?: number
  /** Max query bytes before the parse VALID bit clears (default 8192). */
  maxQueryBytes?: number
  /** Max cookie bytes before the parse VALID bit clears (default 8192). */
  maxCookieBytes?: number
  /** Max pairs per section (0 = unlimited; default 0). */
  maxPairs?: number
}

/** A compiled per-route native stack (route-wire v6). */
export interface NativeRoute {
  /** Whether the plan compiled `parseQuery` (the result carries a query section). */
  readonly parseQuery: boolean
  /** Whether the plan compiled `parseCookies` (the result carries a cookie section). */
  readonly parseCookies: boolean
  /** Whether the plan compiled a native response projection (`response`/`program`). */
  readonly hasResponse: boolean
  /**
   * Run one request frame through the compiled stack and return the decoded
   * verdict. The frame is
   * `[flags u32][qLen][query][cLen][cookie]([bLen][body])([ridLen][rid])`
   * followed by the optional v5 `[method][ip][headers]` sections — build it
   * with {@link packRouteFrame}. Reuses one growable output buffer (the
   * needed-size convention: `0` = real error → throws; `> out.length` = exact
   * required size → retry once).
   */
  runFrame(frame: Uint8Array): RouteWireResult
  /**
   * Convenience: pack a `(query, cookie, body)` frame then {@link runFrame}.
   * `pre` carries the v5 method/ip/headers inputs a program route reads.
   */
  run(
    query: string,
    cookie: string,
    body: Uint8Array | null,
    pre?: RouteFramePre | null,
    requestId?: string | Uint8Array | null,
  ): RouteWireResult
  /**
   * Assemble the native response for a response-mode result against the
   * compile-time template (v6): static headers are the memoized `Headers`,
   * dynamic headers are spliced from the native substitution slots, and the
   * body is built from the pre-encoded static segments. Returns `null` when the
   * route has no response projection (or the result is not response-mode).
   *
   * The returned `Response` owns a FRESH body buffer (not the pooled output),
   * so it is safe to serve without copying.
   */
  assembleResponse(result: RouteWireResult): Response | null
  /**
   * Free the native handle. Idempotent: a second call is a no-op. After it,
   * {@link runFrame}/{@link run} throw rather than pass a freed handle into the
   * native stack.
   */
  destroy(): void
}

/**
 * Compile a per-route native stack from a plan. Returns a compiled route whose
 * `run`/`runFrame` perform the parse + verdict in ONE native call.
 *
 * @example
 * ```ts
 * const route = createNativeRoute({ parseQuery: true, parseCookies: true })
 * const result = route.run('page=1&limit=20', 'session=abc', null)
 * // result.flags & ROUTE_FLAG.OK → parse succeeded; result.query = [['page','1'],…]
 * ```
 */
export function createNativeRoute(plan: NativeRoutePlan = {}): NativeRoute {
  const limits: RouteWireLimits = {
    maxBodyBytes: plan.maxBodyBytes ?? 2 * 1024 * 1024,
    maxQueryBytes: plan.maxQueryBytes ?? 8192,
    maxCookieBytes: plan.maxCookieBytes ?? 8192,
    maxPairs: plan.maxPairs ?? 0,
  }

  // Stage order is first-failure-wins on the native side, so the descriptor
  // pipeline mirrors the plan's semantics: parse stages first, then body
  // verdicts (validateBody before requireJsonBody per the Rust compile — it
  // emits requireJsonBody first defensively; the native side treats the pair
  // as "require then validate" and the compiler guarantees the order).
  const stages: RouteStageTag[] = []
  if (plan.parseQuery) stages.push(ROUTE_STAGE.parseQuery)
  if (plan.parseCookies) stages.push(ROUTE_STAGE.parseCookies)
  if (plan.validateBody) stages.push(ROUTE_STAGE.validateBody)
  if (plan.requireJsonBody) stages.push(ROUTE_STAGE.requireJsonBody)

  const schemas: Array<{ part: number; bytes: Uint8Array }> = []
  if (plan.validateBody && plan.schema) {
    schemas.push({ part: ROUTE_PART.body, bytes: plan.schema })
  }

  // v6 op program: lower the config + parse/validate + response projection into
  // an op program (reusing the JS header/body builders for the class
  // templates). The class templates are ALSO compiled here into JS
  // `RouteWireTemplate`s — JS assembles the `Response` against them and the
  // native result only carries the selected class + substitution slots.
  let program: Uint8Array | undefined
  let templates: RouteWireTemplateSet = new Map()
  if (plan.program) {
    if (!plan.response) {
      throw new Error('createNativeRoute: a `program` plan requires a `response` projection')
    }
    const built = buildProgramPlan(plan.program, plan.response)
    program = encodeProgram(built.consts, built.ops)
    templates = compileResponseTemplates(built.classes)
  } else if (plan.response) {
    // Standalone v4-style projection: the native side emits the response-mode
    // substitution section with class 0 (OK, no origin).
    templates = new Map([[ROUTE_CLASS.okNoOrigin, compileResponseTemplate(plan.response)]])
  }

  const descriptor = encodeRouteDescriptor(stages, schemas, limits, program)
  const parseQuery = plan.program?.parseQuery === true || plan.parseQuery === true
  const parseCookies = plan.program?.parseCookies === true || plan.parseCookies === true
  const hasResponse = plan.response !== undefined || program !== undefined

  // Transport: bun:ffi PRIMARY on Bun; napi `Route` on Node / fallback. An FFI
  // compile failure (invalid/unsupported descriptor) ALSO falls back to napi so
  // the route stays usable instead of throwing "no active transport". The
  // compiled route owns exactly one handle; `destroy` frees it.
  const bunFFI: BunFFI | null = getBunFFI()
  let ffiHandle = bunFFI !== null ? compileFfi(bunFFI, descriptor) : 0
  let napiRoute = bunFFI === null || ffiHandle === 0 ? compileNapi(descriptor) : null

  // Reusable output buffer for the needed-size convention (grow once, retry).
  let out = new Uint8Array(256)

  const runFrame = (frame: Uint8Array): RouteWireResult => {
    if (ffiHandle === 0 && napiRoute === null) {
      throw new Error('native route: already destroyed')
    }
    let written: number
    if (ffiHandle !== 0 && bunFFI !== null) {
      written = bunFFI.routeRun(ffiHandle, frame, out)
      if (written > out.byteLength) {
        // Exact required size reported — grow and retry once.
        out = new Uint8Array(written)
        written = bunFFI.routeRun(ffiHandle, frame, out)
        if (written > out.byteLength) {
          throw new Error('native route: output still too small after grow')
        }
      }
    } else if (napiRoute !== null) {
      written = napiRoute.run(frame, out)
      if (written > out.byteLength) {
        out = new Uint8Array(written)
        written = napiRoute.run(frame, out)
        if (written > out.byteLength) {
          throw new Error('native route: output still too small after grow')
        }
      }
    } else {
      throw new Error('native route: no active transport')
    }
    return decodeRouteResult(out.subarray(0, written), { query: parseQuery, cookie: parseCookies })
  }

  // The origin echoes on every CORS request, so re-packing it per request is
  // pure waste (measured ~371ns). Memoize the packed header block for a
  // repeating single-origin set in this (impure) boundary — the pure
  // `packRouteFrame` stays stateless via the `packedHeaders` field.
  const packedOriginCache = new Map<string, Uint8Array>()
  const packPre = (pre: RouteFramePre | null): RouteFramePre | null => {
    if (pre === null || pre.packedHeaders !== undefined) return pre
    const headers = pre.headers
    if (headers === undefined || headers.length !== 1 || headers[0]?.[0] !== 'origin') return pre
    const origin = headers[0][1]
    let packed = packedOriginCache.get(origin)
    if (packed === undefined) {
      packed = packRawHeadersPacked(headers)
      if (packedOriginCache.size >= 16) packedOriginCache.clear()
      packedOriginCache.set(origin, packed)
    }
    return { methodKind: pre.methodKind, ip: pre.ip, https: pre.https, packedHeaders: packed }
  }

  const assembleResponse = (result: RouteWireResult): Response | null => {
    if ((result.flags & ROUTE_FLAG.HAS_RESPONSE) === 0) return null
    const tmpl = templates.get(result.classTag)
    if (tmpl === undefined) return null
    const assembled = assembleRouteResponse(tmpl, result.slots)
    return new Response(assembled.body, { status: assembled.status, headers: assembled.headers })
  }

  return {
    parseQuery,
    parseCookies,
    hasResponse,
    runFrame,
    run: (query, cookie, body, pre, requestId) =>
      runFrame(packRouteFrame(query, cookie, body, requestId ?? null, packPre(pre ?? null))),
    assembleResponse,
    destroy: () => {
      if (ffiHandle !== 0 && bunFFI !== null) {
        bunFFI.routeDestroy(ffiHandle)
        ffiHandle = 0
      }
      napiRoute?.destroy?.()
      napiRoute = null
    },
  }
}

/** Compile through bun:ffi (`castrum_route_compile`), returning the handle (0 = error). */
function compileFfi(bunFFI: BunFFI, descriptor: Uint8Array): number {
  try {
    return bunFFI.routeCompile(descriptor)
  } catch {
    return 0 // routeCompile throws on an invalid descriptor; treat as no-handle
  }
}

/** Compile through the napi `Route` class (Node / fallback transport). */
function compileNapi(
  descriptor: Uint8Array,
): { run: (frame: Uint8Array, out: Uint8Array) => number; destroy?: () => void } | null {
  const addon = getAddon()
  const Route = (
    addon as {
      Route?: new (
        d: Uint8Array,
      ) => {
        run: (f: Uint8Array, o: Uint8Array) => number
        destroy?: () => void
      }
    }
  ).Route
  if (typeof Route !== 'function') {
    return null // addon without the route stack (pre-rebuild) — caller falls back
  }
  try {
    return new Route(descriptor)
  } catch {
    return null
  }
}
