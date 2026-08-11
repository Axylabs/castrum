// src/ingress/server.ts — Bun.serve builder over pre-baked route handlers.

import {
  readHandler,
  headHandler,
  jsonWriteHandler,
  echoHandler,
  fallbackHandler,
} from "./routes";
import type { BakedHandlerOptions } from "./routes/common";
import type { OptimizedIngressHandler } from "./types";

/** Server-level default for the socket request-body cap (16 MiB). */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 16 * 1024 * 1024;

/** Route spec for the Bun.serve builder. */
export interface BakedRoute {
  /** Wires GET + HEAD read handlers. */
  read?: OptimizedIngressHandler;
  /** Wires POST/PUT/PATCH JSON-write handlers (and OPTIONS fallback). */
  write?: OptimizedIngressHandler;
  /** Wires a POST echo handler. */
  echo?: OptimizedIngressHandler;
  /** Wires a GET read handler (cookies-style route). */
  cookies?: OptimizedIngressHandler;
  /** Overrides `maxBodyBytes` for this route's write/echo handlers. */
  maxBodyBytes?: number;
  /**
   * Overall deadline (ms) for reading the request body on this route's
   * write/echo handlers. Default: 0 (disabled).
   */
  bodyTimeoutMs?: number;
}

/** Options for {@link createIngressServer}. */
export interface CreateIngressServerOptions {
  port: number;
  hostname?: string;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  reusePort?: boolean;
  copyBody?: boolean;
  getIp?: (req: Request, srv: unknown) => string | undefined;
  routes: Record<string, BakedRoute>;
  fallback?: OptimizedIngressHandler;
  /**
   * Invoked when an unhandled error escapes a request handler (currently wired
   * on the Node adapter; the Bun path uses runtime.onResponse). Never throws —
   * hook failures are swallowed.
   */
  onError?: (info: { error: Error; request?: Request }) => void;
  /** Node adapter only: ms to receive the complete request (headers + body).
   *  Guards slowloris/trickling requests. Default: 30_000. */
  requestTimeoutMs?: number;
  /** Node adapter only: ms to receive the request headers. Default: 30_000. */
  headersTimeoutMs?: number;
  /** Node adapter only: max requests per keep-alive socket before Node forces
   *  a fresh connection (bounds long-lived socket reuse). Default: 1000. */
  maxRequestsPerSocket?: number;
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
  port?: number;
  /** Force-stop the server. Bun semantics: `true` drops active connections. */
  stop(force?: boolean): void;
}

/** A running server instance plus a stop helper. */
export interface BakedServer {
  server: ServerHandle;
  stop(): void;
  port: number;
}

export interface GracefulShutdownOptions {
  /** Grace period (ms) to drain in-flight requests before force-closing. */
  timeoutMs?: number;
  /** Signals to listen for. Default: SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[];
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
  const timeoutMs = options.timeoutMs ?? 5_000;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];

  let shuttingDown = false;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Soft stop: stop accepting new work and drain in-flight requests.
    for (const h of handles) {
      try {
        h.stop(false);
      } catch {
        // ignore already-stopped handles
      }
    }
    // Force-close after the grace period.
    const timer = setTimeout(() => {
      for (const h of handles) {
        try {
          h.stop(true);
        } catch {
          // ignore
        }
      }
    }, timeoutMs);
    timer.unref?.();
  };

  for (const sig of signals) {
    process.on(sig, handler);
  }

  return () => {
    for (const sig of signals) {
      process.removeListener(sig, handler);
    }
  };
}

/**
 * Build the route → { method → handler } map from a server spec.
 *
 * Shared by `createIngressServer` (Bun.serve) and `createIngressServerNode`
 * (node:http) so both runtimes wire the exact same route handlers.
 */

/** Options `buildRouteHandlers` actually consumes (a subset of the server
 *  options — it does not need `port` or the Node-only server fields). */
export type BuildRouteHandlersOptions = Pick<
  CreateIngressServerOptions,
  "routes" | "fallback" | "getIp" | "copyBody"
>;

export function buildRouteHandlers(options: BuildRouteHandlersOptions): {
  routes: Record<string, Record<string, unknown>>;
  baseOpts: BakedHandlerOptions;
} {
  const baseOpts: BakedHandlerOptions = {
    getIp: options.getIp,
    copyBody: options.copyBody,
  };

  const serverRoutes: Record<string, Record<string, unknown>> = {};

  for (const [path, spec] of Object.entries(options.routes)) {
    const routeOpts: BakedHandlerOptions = {
      ...baseOpts,
      maxBodyBytes: spec.maxBodyBytes,
      bodyTimeoutMs: spec.bodyTimeoutMs,
    };
    const methods: Record<string, unknown> = {};

    if (spec.read) {
      methods.GET = readHandler(spec.read, routeOpts);
      methods.HEAD = headHandler(spec.read, routeOpts);
    }

    if (spec.write) {
      const writeOpts: BakedHandlerOptions = {
        ...routeOpts,
        fallback: options.fallback ?? spec.write,
      };
      methods.POST = jsonWriteHandler(spec.write, writeOpts);
      methods.PUT = jsonWriteHandler(spec.write, writeOpts);
      methods.PATCH = jsonWriteHandler(spec.write, writeOpts);
      if (options.fallback) {
        methods.OPTIONS = fallbackHandler(options.fallback, routeOpts);
      }
    }

    if (spec.echo) {
      methods.POST = echoHandler(spec.echo, routeOpts);
    }

    if (spec.cookies) {
      methods.GET = readHandler(spec.cookies, routeOpts);
    }

    serverRoutes[path] = methods;
  }

  return { routes: serverRoutes, baseOpts };
}

/** Typed options forwarded to `Bun.serve`. */
interface BunServerOptions {
  hostname: string;
  port: number;
  idleTimeout: number;
  routes: Record<string, Record<string, unknown>>;
  maxRequestBodySize: number;
  reusePort?: boolean;
  fetch?: (req: Request) => Response | Promise<Response>;
}

/** Build a Bun.serve config from pre-baked route handlers. */
export function createIngressServer(
  options: CreateIngressServerOptions,
): BakedServer {
  const { routes: serverRoutes, baseOpts } = buildRouteHandlers(options);

  const serverOptions: BunServerOptions = {
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    idleTimeout: options.idleTimeout ?? 30,
    routes: serverRoutes,
    // Socket-level request-size guard. Bun's default is ~128 MiB; we default
    // to 16 MiB so an oversized request is rejected at the socket without ever
    // being buffered (route handlers enforce the tighter `maxBodyBytes`).
    maxRequestBodySize:
      options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
  };
  if (options.reusePort) {
    serverOptions.reusePort = true;
  }
  if (options.fallback) {
    serverOptions.fetch = fallbackHandler(options.fallback, baseOpts);
  }

  // Narrow bridge to Bun's (version-dependent) Serve type — Bun's Routes /
  // FetchHandler shapes are complex, so we cast once instead of `as any`.
  let server: ReturnType<typeof Bun.serve>;
  const init = serverOptions as Parameters<typeof Bun.serve>[0];
  try {
    server = Bun.serve(init);
  } catch (err) {
    if (options.reusePort) {
      delete serverOptions.reusePort;
      server = Bun.serve(serverOptions as Parameters<typeof Bun.serve>[0]);
    } else {
      throw err;
    }
  }

  return {
    server,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        // already stopped
      }
    },
    port: options.port,
  };
}
