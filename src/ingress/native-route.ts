// src/ingress/native-route.ts — public per-route native stack factory.
//
// `createNativeRoute` compiles a route-wire v3 descriptor ONCE (via the
// `castrum_route_*` C-ABI / napi `Route` surface over `rust/ingress/
// native_route.rs`) and runs each request frame in ONE native call — the same
// lean per-route stack `@ignex/native`'s `createNativeRoute` consumes. This
// brings that stack into castrum itself: routes that only need query/cookie
// parse + `requireJsonBody`/`validateBody` verdicts (no CORS/rate-limit/
// security/IP/metadata envelope) get the leanest possible per-request path —
// measured `bench/cost/native-route-vs-router.ts`: ~551ns full JS-glue path
// vs ~1131ns router `run()` on a parseQuery+parseCookies route (−580ns).
//
// IMPURE by design (dlopen + FFI): it lives at the boundary like
// `handlers.ts`/`server.ts`; the byte wire helpers it uses are the PURE
// `src/ingress/packing/route-wire.ts`.

import { getBunFFI } from '../native/ffi'
import { getAddon } from '../native'
import type { BunFFI } from '../native/ffi/types'
import {
  ROUTE_PART,
  ROUTE_STAGE,
  decodeRouteResult,
  encodeRouteDescriptor,
  packRouteFrame,
  type RouteStageTag,
  type RouteWireLimits,
  type RouteWireResult,
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
  /** Max body bytes before `requireJsonBody`/`validateBody` fail (default 2 MiB). */
  maxBodyBytes?: number
  /** Max query bytes before the parse VALID bit clears (default 8192). */
  maxQueryBytes?: number
  /** Max cookie bytes before the parse VALID bit clears (default 8192). */
  maxCookieBytes?: number
  /** Max pairs per section (0 = unlimited; default 0). */
  maxPairs?: number
}

/** A compiled per-route native stack (route-wire v3). */
export interface NativeRoute {
  /** Whether the plan compiled `parseQuery` (the result carries a query section). */
  readonly parseQuery: boolean
  /** Whether the plan compiled `parseCookies` (the result carries a cookie section). */
  readonly parseCookies: boolean
  /**
   * Run one request frame through the compiled stack and return the decoded
   * verdict. The frame is `[flags u32][qLen][query][cLen][cookie]([bLen][body])`
   * — build it with {@link packRouteFrame}. Reuses one growable output buffer
   * (the needed-size convention: `0` = real error → throws; `> out.length` =
   * exact required size → retry once).
   */
  runFrame(frame: Uint8Array): RouteWireResult
  /** Convenience: pack a `(query, cookie, body)` frame then {@link runFrame}. */
  run(query: string, cookie: string, body: Uint8Array | null): RouteWireResult
  /** Free the native handle (idempotent; safe to call once at shutdown). */
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

  const descriptor = encodeRouteDescriptor(stages, schemas, limits)
  const parseQuery = plan.parseQuery === true
  const parseCookies = plan.parseCookies === true

  // Transport: bun:ffi PRIMARY on Bun; napi `Route` on Node / fallback. The
  // compiled route owns exactly one handle; `destroy` frees it.
  const bunFFI: BunFFI | null = getBunFFI()
  const ffiHandle = bunFFI !== null ? compileFfi(bunFFI, descriptor) : 0
  const napiRoute = bunFFI === null ? compileNapi(descriptor) : null

  // Reusable output buffer for the needed-size convention (grow once, retry).
  let out = new Uint8Array(256)

  const runFrame = (frame: Uint8Array): RouteWireResult => {
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

  return {
    parseQuery,
    parseCookies,
    runFrame,
    run: (query, cookie, body) => runFrame(packRouteFrame(query, cookie, body)),
    destroy: () => {
      if (ffiHandle !== 0 && bunFFI !== null) {
        bunFFI.routeDestroy(ffiHandle)
      }
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
function compileNapi(descriptor: Uint8Array): { run: (frame: Uint8Array, out: Uint8Array) => number } | null {
  const addon = getAddon()
  const Route = (addon as { Route?: new (d: Uint8Array) => { run: (f: Uint8Array, o: Uint8Array) => number } }).Route
  if (typeof Route !== 'function') {
    return null // addon without the route stack (pre-rebuild) — caller falls back
  }
  try {
    return new Route(descriptor)
  } catch {
    return null
  }
}
