// src/ingress/router.ts — createIngressRouter: per-route compiled ingress.
//
// The "one super solution" over the existing ingress core. Instead of one
// global `IngressInner` serving every path (with a superset of options), each
// route in the table carries its OWN `IngressHandlerOptions` and compiles a
// DEDICATED native `IngressInner` (via `createIngressHandler`) — so the native
// pipeline prunes to exactly that route's stages (parseCookies, parseQuery,
// schema, cors, rateLimit, limits...), and `buildHeaderPlan` (inside
// `createIngressHandler`) produces a per-route header plan that reads ZERO
// headers for routes that need none. All routes share the same wire format
// (the existing packed `handle_request_packed`), the shared process-wide rate
// limiter budgets, and pre-warm on construction (`warmOnCreate`).
//
// This is the completion of what `rust/route.rs` (now deleted — it was dead,
// external-project wire) attempted: per-route native stage pruning, WITHOUT a
// second/third wire format. The route factories (`readHandler`,
// `jsonWriteHandler`, ...) and the dispatch machinery (`buildRouteHandlers` /
// `buildPathMatcher`) are reused unchanged. The per-route native-compile idea
// is ALSO exposed as the standalone per-route stack in
// `rust/ingress/native_route.rs` (the `castrum_route_*`/napi `Route` surface
// consumed by `@ignex/native`'s `createNativeRoute` — the LIVE successor to
// the deleted dead wire).

import type { BakedIngressResult } from './decode/baked-result'
import { type BakedIngressRuntime, createIngressHandler } from './handlers'
import type { IngressHandlerOptions } from './options'
import type { BakedRoute, PathMatch, RouteHandler } from './server'
import { buildPathMatcher, buildRouteHandlers } from './server'
import type { BakedContext, NativeResponder, OptimizedIngressHandler, TerminalStyle } from './types'

/** Per-route spec for {@link createIngressRouter}. */
export interface RouterRouteSpec {
  /**
   * Per-route ingress options — compiled into a DEDICATED native `IngressInner`
   * for this route (parseCookies, parseQuery, schema, cors, rateLimit, limits,
   * requireJsonBody, ...). This is what makes the pipeline prune per route.
   */
  options?: IngressHandlerOptions
  /** Wire GET + HEAD read handlers over this route's compiled handler. */
  read?: boolean
  /** Wire POST/PUT/PATCH JSON-write handlers over this route's compiled handler. */
  write?: boolean
  /** Wire a POST echo handler over this route's compiled handler. */
  echo?: boolean
  /** Wire a GET read handler (cookies-style) over this route's compiled handler. */
  cookies?: boolean
  /** Wire a DELETE read-style handler over this route's compiled handler. */
  delete?: boolean
  /**
   * A JS responder route: the native pipeline decides + rejects (terminal
   * response in {@link terminalStyle}); on success the responder builds the
   * 2xx body (async OK) from a decoded snapshot. Wired for `methods`
   * (default `['GET']`). When set, the standard `read`/`write`/etc. flags for
   * this route are ignored.
   */
  responder?: {
    handler: NativeResponder
    /** HTTP methods to wire (default `['GET']`). */
    methods?: ReadonlyArray<string>
    /** Read the body for native validation (default false — framework owns it). */
    readBody?: boolean
  }
  /** Terminal envelope style for this route's responder (default: router-level
   *  `terminalStyle` or `'castrum'`). */
  terminalStyle?: TerminalStyle
  /**
   * A raw request→Response handler served directly for GET, OUTSIDE the
   * ingress pipeline (health/metrics probes, /metrics). When set, `read`/
   * `write`/etc. for this route are ignored.
   */
  raw?: RouteHandler
  /** Overrides `maxBodyBytes` for this route's write/echo handlers. */
  maxBodyBytes?: number
  /** Overrides `bodyTimeoutMs` for this route's write/echo handlers. */
  bodyTimeoutMs?: number
}

/** Options for {@link createIngressRouter}. */
export interface CreateIngressRouterOptions {
  /** Route table: path → per-route spec. */
  routes: Record<string, RouterRouteSpec>
  /** Shared runtime hooks (onRequest/onResponse/onError, security headers,
   *  output buffer size) applied to EVERY compiled route handler. */
  runtime?: BakedIngressRuntime
  /** Shared `getIp` resolver for route handlers. */
  getIp?: (req: Request, srv: unknown) => string | undefined
  /** Shared `copyBody` default for route handlers. */
  copyBody?: boolean
  /** Default terminal envelope style for responder routes (`'castrum'`). */
  terminalStyle?: TerminalStyle
  /** Pre-warm every compiled route at construction (JIT the packed pipeline +
   *  the FFI ingress call before the first real request). Default: false. */
  warmOnCreate?: boolean
}

/** A compiled per-route router. */
export interface IngressRouter {
  /** The per-route compiled handlers keyed by path (for custom route wiring). */
  routeHandlers: Record<string, OptimizedIngressHandler>
  /** The route → method → handler map (compatible with Bun.serve `routes` and
   *  `createIngressServerNode`). */
  routes: Record<string, Record<string, unknown>>
  /** The path matcher (`:param`/`*` dynamic routes). */
  match: (pathname: string) => PathMatch | undefined
  /** A fetch-style dispatcher: match path + method → the route's handler. */
  fetch: (req: Request, srv?: unknown) => Response | Promise<Response>
  /** Pre-warm every compiled route (JIT the packed pipeline + FFI call). */
  prewarm: () => void
}

/**
 * Compile a route table into per-route native ingress instances.
 *
 * Each route with a pipeline-backed spec (`read`/`write`/`echo`/`cookies`/
 * `delete`) compiles its OWN `createIngressHandler(options)` — a dedicated
 * `IngressInner` pruned to that route's stages + a per-route header plan.
 * Routes that need nothing (a bare `read` with no cookies/query/cors) therefore
 * gather zero headers and run a near-empty native pipeline. All routes share
 * the same wire format and the shared process-wide rate-limiter budgets.
 *
 * @example
 * ```ts
 * const router = createIngressRouter({
 *   warmOnCreate: true,
 *   runtime: ingressMetrics?.runtime,
 *   routes: {
 *     '/health': { read: true, options: { parseCookies: false, parseQuery: false } },
 *     '/api/users': {
 *       read: true,
 *       write: true,
 *       options: { parseCookies: true, parseQuery: true, schema: USER_SCHEMA_BYTES },
 *     },
 *     '/metrics': { raw: metricsHandler(ingressMetrics) },
 *   },
 * })
 * const server = Bun.serve({ routes: router.routes }) // or router.fetch
 * ```
 */
export function createIngressRouter(options: CreateIngressRouterOptions): IngressRouter {
  const runtime = options.runtime ?? {}

  // Per-route compiled handlers + the BakedRoute table the shared wiring reads.
  const compiled: Record<string, OptimizedIngressHandler> = {}
  const bakedRoutes: Record<string, BakedRoute> = {}
  const baseOpts: {
    getIp?: (req: Request, srv: unknown) => string | undefined
    copyBody?: boolean
  } = {}
  if (options.getIp !== undefined) baseOpts.getIp = options.getIp
  if (options.copyBody !== undefined) baseOpts.copyBody = options.copyBody

  for (const [path, spec] of Object.entries(options.routes)) {
    if (spec.raw) {
      // Raw handler: served directly, outside the pipeline.
      bakedRoutes[path] = { read: spec.raw as RouteHandler }
      continue
    }
    // Compile a dedicated native instance for this route's options.
    const handler = createIngressHandler(spec.options ?? {}, runtime)
    compiled[path] = handler

    if (spec.responder) {
      // Responder route: native decides + rejects; JS builds the 2xx.
      bakedRoutes[path] = {
        responder: {
          ingress: handler,
          handler: spec.responder.handler,
          methods: spec.responder.methods,
          terminalStyle: spec.terminalStyle ?? options.terminalStyle,
          readBody: spec.responder.readBody,
        },
        maxBodyBytes: spec.maxBodyBytes,
        bodyTimeoutMs: spec.bodyTimeoutMs,
      }
      continue
    }

    const routeSpec: BakedRoute = {
      read: spec.read ? handler : undefined,
      write: spec.write ? handler : undefined,
      echo: spec.echo ? handler : undefined,
      cookies: spec.cookies ? handler : undefined,
      delete: spec.delete ? handler : undefined,
      maxBodyBytes: spec.maxBodyBytes,
      bodyTimeoutMs: spec.bodyTimeoutMs,
    }
    bakedRoutes[path] = routeSpec
  }

  const { routes } = buildRouteHandlers({ ...baseOpts, routes: bakedRoutes })
  const matcher = buildPathMatcher(routes)

  const prewarm = (): void => {
    // Run one probe GET through each compiled handler so the packed pipeline,
    // header plan and FFI ingress call are JIT-warmed before the first real
    // request. `run` never throws for a bad request (native failures become a
    // 500 via setInternalError), so this is safe on any handler.
    for (const handler of Object.values(compiled)) {
      const probe = new Request('http://localhost:0/prewarm', { method: 'GET' })
      handler.run<unknown>(
        probe,
        '127.0.0.1',
        null,
        (_result: BakedIngressResult, _ctx: BakedContext) => 0,
      )
    }
  }

  if (options.warmOnCreate === true) {
    prewarm()
  }

  const fetch = (req: Request, srv?: unknown): Response | Promise<Response> => {
    let pathname: string
    try {
      pathname = new URL(req.url).pathname
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const matched = matcher(pathname)
    if (!matched) {
      return new Response('Not Found', { status: 404 })
    }
    const methodHandler = matched.methods[req.method]
    if (typeof methodHandler === 'function') {
      return (methodHandler as RouteHandler)(req, srv, matched.params)
    }
    // A route matched but this method isn't wired — 405, or a bare OPTIONS 204
    // when the route answers preflights.
    if (req.method === 'OPTIONS' && typeof matched.methods.OPTIONS === 'function') {
      return (matched.methods.OPTIONS as RouteHandler)(req, srv, matched.params)
    }
    return new Response('Method Not Allowed', { status: 405 })
  }

  return { routeHandlers: compiled, routes, match: matcher, fetch, prewarm }
}
