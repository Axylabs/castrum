// src/ingress/server.ts — Bun.serve builder over pre-baked route handlers.

import { isBun } from '../shared/runtime'
import {
  deleteHandler,
  echoHandler,
  fallbackHandler,
  headHandler,
  jsonWriteHandler,
  optionsHandler,
  readHandler,
} from './routes'
import type { BakedHandlerOptions } from './routes/common'
import { nativeRouteHandler } from './routes/native'
import { nativeResponderRoute } from './routes/responder'
import { createNativeRoute } from './native-route'
import type { NativeRoutePlan } from './native-route'
import type { NativeResponder, OptimizedIngressHandler, TerminalStyle } from './types'

/** Server-level default for the socket request-body cap (16 MiB). */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 16 * 1024 * 1024

/** A raw web-standard route handler (`Request` → `Response`), e.g. the
 *  health/metrics probes (`livenessHandler`, `readinessHandler`,
 *  `healthHandler`, `metricsHandler`). Accepted as `BakedRoute.read` and
 *  served for GET directly, outside the ingress pipeline. The optional third
 *  arg carries the matched dynamic path params (`:param`/`*`) on the Node
 *  adapter (Bun's native router handles matching; the ingress pipeline does
 *  not echo params in its response). */
export type RouteHandler = (
  req: Request,
  srv?: unknown,
  params?: Record<string, string>,
) => Response | Promise<Response>

/** Route spec for the Bun.serve builder. */
export interface BakedRoute {
  /**
   * Wires GET + HEAD read handlers. Accepts an optimized ingress handler OR a
   * raw `RouteHandler` function (health/metrics probes are raw — see
   * src/ingress/health.ts). A raw handler is served for GET only.
   */
  read?: OptimizedIngressHandler | RouteHandler
  /** Wires POST/PUT/PATCH JSON-write handlers (and OPTIONS fallback). */
  write?: OptimizedIngressHandler
  /** Wires a POST echo handler. */
  echo?: OptimizedIngressHandler
  /** Wires a GET read handler (cookies-style route). */
  cookies?: OptimizedIngressHandler
  /** Wires a DELETE read-style handler. */
  delete?: OptimizedIngressHandler
  /**
   * A JS responder route: the native pipeline owns parse/validate/CORS/
   * rate-limit + terminal rejections; the responder builds the 2xx body
   * (async OK). Wired for `methods` (default GET). Built by
   * `nativeResponderRoute` (src/ingress/routes/responder.ts).
   */
  responder?: {
    /** The route's compiled native `IngressInner`. */
    ingress: OptimizedIngressHandler
    /** The JS 2xx builder. */
    handler: NativeResponder
    /** HTTP methods to wire (default `['GET']`). */
    methods?: ReadonlyArray<string>
    /** Terminal envelope style (`'castrum'` default / `'ignex'`). */
    terminalStyle?: TerminalStyle
    /** Read the body for native validation (default false — framework owns it). */
    readBody?: boolean
  }
  /**
   * A LEAN native-stack responder route: the route-wire v3 per-route stack
   * (`createNativeRoute`) runs ONLY the plan's stages in ONE native call —
   * no CORS/rate-limit/security/IP/metadata envelope. Wired for `methods`
   * (default GET) by `nativeRouteHandler` (src/ingress/routes/native.ts).
   */
  native?: {
    /** The route-wire v3 plan (parse/validate stages + limits). */
    plan: NativeRoutePlan
    /** The JS 2xx builder. */
    handler: NativeResponder
    /** HTTP methods to wire (default `['GET']`). */
    methods?: ReadonlyArray<string>
    /** Read the body for `requireJsonBody`/`validateBody` (default false). */
    readBody?: boolean
  }
  /** Overrides `maxBodyBytes` for this route's write/echo handlers. */
  maxBodyBytes?: number
  /**
   * Overall deadline (ms) for reading the request body on this route's
   * write/echo handlers. Default: 30_000 (`DEFAULT_BODY_TIMEOUT_MS`).
   * Set 0 to disable.
   */
  bodyTimeoutMs?: number
}

/** RFC 6455 handshake values returned by `CreateIngressServerOptions.upgrade`. */
export interface NodeUpgradeHandshake {
  /** `Sec-WebSocket-Accept` value (compute via `rust.text.wsAcceptKey`). */
  accept: string
  /** Optional negotiated subprotocol (`Sec-WebSocket-Protocol`). */
  protocol?: string
}

/** Options for {@link createIngressServer}. */
export interface CreateIngressServerOptions {
  port: number
  hostname?: string
  idleTimeout?: number
  maxRequestBodySize?: number
  reusePort?: boolean
  copyBody?: boolean
  getIp?: (req: Request, srv: unknown) => string | undefined
  routes: Record<string, BakedRoute>
  fallback?: OptimizedIngressHandler
  /**
   * Invoked when an unhandled error escapes a request handler (currently wired
   * on the Node adapter; the Bun path uses runtime.onResponse). Never throws —
   * hook failures are swallowed.
   */
  onError?: (info: { error: Error; request?: Request }) => void
  /** Node adapter only: ms to receive the complete request (headers + body).
   *  Guards slowloris/trickling requests. Default: 30_000. */
  requestTimeoutMs?: number
  /** Node adapter only: ms to receive the request headers. Default: 30_000. */
  headersTimeoutMs?: number
  /** Node adapter only: max requests per keep-alive socket before Node forces
   *  a fresh connection (bounds long-lived socket reuse). Default: 1000. */
  maxRequestsPerSocket?: number
  /** Node adapter only: optional WebSocket upgrade handler. Return the RFC 6455
   *  handshake values (see {@link NodeUpgradeHandshake}) to complete the
   *  handshake on the hijacked socket; return null/undefined to decline the
   *  upgrade. Ignored by the Bun server. (`createWebSocketUpgrade` is Bun-only
   *  — Node's Response cannot carry a 101.) */
  upgrade?: (req: Request) => NodeUpgradeHandshake | null | undefined
  /** Node adapter only: called after a WebSocket upgrade handshake completes
   *  (the 101 response was accepted), with the hijacked socket so the caller
   *  can attach a frame codec/message loop (e.g. the `ws` library). Ignored by
   *  the Bun server. */
  onUpgrade?: (socket: import('node:stream').Duplex, req: unknown, head: Buffer) => void
}

/**
 * Minimal surface of the running server that castrum relies on.
 *
 * This is intentionally NOT `ReturnType<typeof Bun.serve>` so that the public
 * types stay runtime-agnostic — Node.js TypeScript consumers don't need
 * `@types/bun` just to import castrum's types. Bun's server exposes far more
 * fields; treat the handle as opaque.
 */
export interface ServerHandle {
  /** The port the server is bound to, when known (Bun exposes it; Node's
   *  http.Server does not — use `BakedServer.port` instead). */
  port?: number
  /** Force-stop the server. Bun semantics: `true` drops active connections. */
  stop(force?: boolean): void
}

/** A running server instance plus a stop helper. */
export interface BakedServer {
  server: ServerHandle
  stop(): void
  port: number
}

/** Options for `gracefulShutdown` (drain grace period + signals). */
export interface GracefulShutdownOptions {
  /** Grace period (ms) to drain in-flight requests before force-closing. */
  timeoutMs?: number
  /** Signals to listen for. Default: SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[]
}

/**
 * Wire SIGTERM/SIGINT to a graceful shutdown: soft-stop (drain in-flight
 * requests) then force-close after `timeoutMs`. Works with both the Bun and
 * Node server handles (both expose `stop(force?)`).
 *
 * Returns a cleanup function that removes the signal listeners. Call it (or
 * `process.exit`) to tear down without hanging.
 */
export function gracefulShutdown(
  handles: ReadonlyArray<ServerHandle>,
  options: GracefulShutdownOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 5_000
  const signals = options.signals ?? ['SIGTERM', 'SIGINT']

  let shuttingDown = false
  const handler = () => {
    if (shuttingDown) return
    shuttingDown = true
    // Soft stop: stop accepting new work and drain in-flight requests.
    for (const h of handles) {
      try {
        h.stop(false)
      } catch {
        // ignore already-stopped handles
      }
    }
    // Force-close after the grace period.
    const timer = setTimeout(() => {
      for (const h of handles) {
        try {
          h.stop(true)
        } catch {
          // ignore
        }
      }
    }, timeoutMs)
    timer.unref?.()
  }

  for (const sig of signals) {
    process.on(sig, handler)
  }

  return () => {
    for (const sig of signals) {
      process.removeListener(sig, handler)
    }
  }
}

/** Options `buildRouteHandlers` actually consumes (a subset of the server
 *  options — it does not need `port` or the Node-only server fields). */
export type BuildRouteHandlersOptions = Pick<
  CreateIngressServerOptions,
  'routes' | 'fallback' | 'getIp' | 'copyBody'
>

/**
 * Build the route → { method → handler } map from a server spec.
 *
 * Shared by `createIngressServer` (Bun.serve) and `createIngressServerNode`
 * (node:http) so both runtimes wire the exact same route handlers.
 */
export function buildRouteHandlers(options: BuildRouteHandlersOptions): {
  routes: Record<string, Record<string, unknown>>
  baseOpts: BakedHandlerOptions
} {
  const baseOpts: BakedHandlerOptions = {
    getIp: options.getIp,
    copyBody: options.copyBody,
  }

  const serverRoutes: Record<string, Record<string, unknown>> = {}

  for (const [path, spec] of Object.entries(options.routes)) {
    const routeOpts: BakedHandlerOptions = {
      ...baseOpts,
      maxBodyBytes: spec.maxBodyBytes,
      bodyTimeoutMs: spec.bodyTimeoutMs,
    }
    const methods: Record<string, unknown> = {}

    if (spec.read) {
      if (typeof spec.read === 'function') {
        // Raw request→Response handler (probes, /metrics): serve GET directly,
        // outside the ingress pipeline. HEAD is intentionally not wired (a raw
        // handler returns a body; probes use GET).
        methods.GET = spec.read
      } else {
        methods.GET = readHandler(spec.read, routeOpts)
        methods.HEAD = headHandler(spec.read, routeOpts)
      }
    }

    if (spec.write) {
      const writeOpts: BakedHandlerOptions = {
        ...routeOpts,
        fallback: options.fallback ?? spec.write,
      }
      methods.POST = jsonWriteHandler(spec.write, writeOpts)
      methods.PUT = jsonWriteHandler(spec.write, writeOpts)
      methods.PATCH = jsonWriteHandler(spec.write, writeOpts)
    }

    if (spec.echo) {
      methods.POST = echoHandler(spec.echo, routeOpts)
    }

    if (spec.cookies) {
      methods.GET = readHandler(spec.cookies, routeOpts)
    }

    if (spec.delete) {
      methods.DELETE = deleteHandler(spec.delete, routeOpts)
    }

    if (spec.responder) {
      // JS responder route: native decides + rejects; JS builds the 2xx.
      const responderRoute = nativeResponderRoute(spec.responder.ingress, spec.responder.handler, {
        ...routeOpts,
        terminalStyle: spec.responder.terminalStyle,
        readBody: spec.responder.readBody,
      })
      const responderMethods = spec.responder.methods ?? ['GET']
      for (const m of responderMethods) {
        methods[m] = responderRoute
      }
    }

    if (spec.native) {
      // LEAN native-stack responder route: route-wire v3 stack, no envelope.
      // The compiled route is injected into the pure route factory (DI across
      // the purity boundary — the compile touches the dlopen layer here).
      const nativeRoute = nativeRouteHandler(createNativeRoute(spec.native.plan), spec.native.handler, {
        ...routeOpts,
        readBody: spec.native.readBody,
      })
      const nativeMethods = spec.native.methods ?? ['GET']
      for (const m of nativeMethods) {
        methods[m] = nativeRoute
      }
    }

    // CORS preflight (OPTIONS) is served for EVERY route with a NATIVE handler
    // (not just write routes with a fallback), so read-only routes also answer
    // preflights with 204/403 from the native pipeline. Raw probe handlers
    // (plain functions) are excluded — browsers don't preflight probes.
    const primary =
      spec.delete ??
      (spec.read && typeof spec.read !== 'function' ? spec.read : undefined) ??
      spec.cookies ??
      spec.write ??
      spec.echo
    if (primary) {
      methods.OPTIONS = optionsHandler(primary, routeOpts)
    }

    serverRoutes[path] = methods
  }

  return { routes: serverRoutes, baseOpts }
}

// ── Path matching (shared with server-node.ts + router.ts) ─────────
// `buildPathMatcher` / `PathMatch` / `safeDecode` live in path-matcher.ts;
// re-exported here for back-compat (they were historically exported from this
// module).

export { buildPathMatcher, type PathMatch, safeDecode } from './path-matcher'

/** Typed options forwarded to `Bun.serve`. */
interface BunServerOptions {
  hostname: string
  port: number
  idleTimeout: number
  routes: Record<string, Record<string, unknown>>
  maxRequestBodySize: number
  reusePort?: boolean
  fetch?: (req: Request) => Response | Promise<Response>
}

/** Build a Bun.serve config from pre-baked route handlers. */
export function createIngressServer(options: CreateIngressServerOptions): BakedServer {
  // Bun-only by design: this builder targets Bun.serve's Routes API. Node
  // consumers use `createIngressServerNode` with the same route handlers
  // (sharing `buildRouteHandlers`).
  if (!isBun()) {
    throw new TypeError(
      'createIngressServer is Bun-only (it builds a Bun.serve config). ' +
        'On Node.js use createIngressServerNode with the same route handlers.',
    )
  }
  const { routes: serverRoutes, baseOpts } = buildRouteHandlers(options)

  const serverOptions: BunServerOptions = {
    hostname: options.hostname ?? '0.0.0.0',
    port: options.port,
    idleTimeout: options.idleTimeout ?? 30,
    routes: serverRoutes,
    // Socket-level request-size guard. Bun's default is ~128 MiB; we default
    // to 16 MiB so an oversized request is rejected at the socket without ever
    // being buffered (route handlers enforce the tighter `maxBodyBytes`).
    maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
  }
  if (options.reusePort) {
    serverOptions.reusePort = true
  }
  if (options.fallback) {
    serverOptions.fetch = fallbackHandler(options.fallback, baseOpts)
  }

  // Narrow bridge to Bun's (version-dependent) Serve type — Bun's Routes /
  // FetchHandler shapes are complex, so we cast once instead of `as any`.
  let server: ReturnType<typeof Bun.serve>
  const init = serverOptions as Parameters<typeof Bun.serve>[0]
  try {
    server = Bun.serve(init)
  } catch (err) {
    if (options.reusePort) {
      delete serverOptions.reusePort
      server = Bun.serve(serverOptions as Parameters<typeof Bun.serve>[0])
    } else {
      throw err
    }
  }

  return {
    server,
    stop: () => {
      try {
        server.stop(true)
      } catch {
        // already stopped
      }
    },
    // The ACTUAL bound port (not `options.port`): with `port: 0` Bun
    // auto-assigns a free port, and consumers expect the real listening port
    // (parity with the Node adapter's `ready`/port behavior).
    port: typeof server.port === 'number' ? server.port : options.port,
  }
}
