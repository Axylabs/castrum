// src/ingress/server-node.ts — Node.js HTTP adapter for the pre-baked ingress
// route handlers.
//
// Bun remains the primary server target (`createIngressServer` in server.ts
// uses Bun.serve). This adapter lets the SAME pre-baked route handlers run
// under Node.js via `node:http`. Route handlers are web-standard
// (`Request` → `Response`), so the adapter only translates between Node's
// `IncomingMessage`/`ServerResponse` and the web `Request`/`Response` types.
//
// Differences vs Bun: no `reusePort`, `maxRequestBodySize` is not enforced at
// the socket level (the route handlers still enforce `maxBodyBytes` after
// reading, matching the Bun path's current behavior), and `getIp` receives the
// Node `IncomingMessage` (which exposes `socket.remoteAddress`, not
// `srv.requestIP`).

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import {
  buildRouteHandlers,
  type BakedServer,
  type CreateIngressServerOptions,
  type ServerHandle,
} from "./server";
import { fallbackHandler } from "./routes";

/**
 * Default socket-level guard for receiving request headers/body (ms). Node's
 * `requestTimeout` / `headersTimeout` default to 0 (disabled); castrum opts
 * into a 30s cap to reject slowloris/trickling sockets. Distinct from the
 * route-level `bodyTimeoutMs` (`DEFAULT_BODY_TIMEOUT_MS`), which guards the
 * body-read loop after headers arrive.
 */
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;
import type { BakedHandlerOptions } from "./routes/common";

export type RouteHandler = (
  req: Request,
  srv?: unknown,
) => Response | Promise<Response>;

/** A Node.js ingress server: {@link BakedServer} plus an async ready signal. */
export interface NodeIngressServer extends BakedServer {
  /**
   * Resolves to the actually-bound port once the server is listening
   * (`node:http` binds asynchronously; useful when `port: 0`).
   */
  ready: Promise<number>;
}

/** Convert a Node IncomingMessage into a web-standard Request. */
function nodeRequestToWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  // The fetch Request constructor forbids a body on GET/HEAD, but allows it on
  // POST/PUT/PATCH/DELETE/OPTIONS etc. Attach the body stream whenever the
  // request actually carries one (content-length > 0 or chunked), so DELETE/
  // OPTIONS-with-a-body are no longer dropped.
  const bodyForbidden = method === "GET" || method === "HEAD";
  const hasBody =
    Number(req.headers["content-length"] ?? 0) > 0 ||
    req.headers["transfer-encoding"] !== undefined;

  const init: RequestInit & { duplex?: "half" } = { method, headers };

  // Stream the request body through (the route handlers call
  // `req.arrayBuffer()` which drains this stream).
  if (hasBody && !bodyForbidden) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(url.toString(), init);
}

/** Write a web Response back to a Node ServerResponse. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  if (response.headers.has("set-cookie")) {
    res.setHeader("set-cookie", response.headers.getSetCookie());
  }
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }

  // HEAD requests must not carry a body.
  if (res.req?.method === "HEAD") {
    res.end();
    return;
  }

  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } else {
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}

/** Build a request listener that dispatches to the shared route map. */
function makeRequestListener(
  options: CreateIngressServerOptions,
  routes: Record<string, Record<string, unknown>>,
  baseOpts: BakedHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      // Socket-level body cap: reject oversized requests BEFORE any body is
      // buffered (mirrors Bun's `maxRequestBodySize` on the Node adapter).
      const contentLengthHeader = req.headers["content-length"];
      if (
        options.maxRequestBodySize !== undefined &&
        contentLengthHeader !== undefined &&
        Number(contentLengthHeader) > options.maxRequestBodySize
      ) {
        const body = JSON.stringify({
          error: { code: "body_too_large", message: "Request body is too large" },
        });
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", String(Buffer.byteLength(body)));
        res.end(body);
        return;
      }

      const webReq = nodeRequestToWebRequest(req);
      const pathname = new URL(webReq.url).pathname;
      const method = webReq.method ?? "GET";

      const route = routes[pathname];
      const handler = route?.[method] as RouteHandler | undefined;

      let response: Response;
      if (handler !== undefined) {
        response = await handler(webReq, req);
      } else if (options.fallback !== undefined) {
        const fallback = fallbackHandler(options.fallback, baseOpts);
        response = await fallback(webReq, req);
      } else {
        response = new Response("Not Found", { status: 404 });
      }

      await writeResponse(res, response);
    } catch (err) {
      // Never leave a client hanging on a handler failure.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: { code: "internal_error", message: "Internal Server Error" },
          }),
        );
      } else {
        res.destroy();
      }
      // NOTE: surfaced via the onError hook (observability phase).
      if (options.onError) {
        try {
          options.onError({
            error: err instanceof Error ? err : new Error(String(err)),
          });
        } catch {
          // hook must never crash the server
        }
      }
    }
  };
}

/**
 * Start a Node.js `node:http` server serving the same pre-baked ingress route
 * handlers as {@link createIngressServer}. Returns a {@link NodeIngressServer};
 * `stop()` drains in-flight connections (graceful) before closing, and
 * `ready` resolves to the bound port once listening.
 *
 * Requires Node.js >= 20.3 (N-API floor). Bun users should prefer
 * {@link createIngressServer} (Bun.serve).
 */
export function createIngressServerNode(
  options: CreateIngressServerOptions,
): NodeIngressServer {
  const { routes, baseOpts } = buildRouteHandlers(options);

  const server: HttpServer = createServer(
    makeRequestListener(options, routes, baseOpts),
  );

  // Map Bun-style options onto Node equivalents + harden slowloris/DoS.
  server.keepAliveTimeout = (options.idleTimeout ?? 30) * 1000;
  server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  if (server.maxRequestsPerSocket !== undefined) {
    server.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 1000;
  }

  // Malformed requests → castrum's JSON error shape (not Node's raw 400/431).
  server.on("clientError", (_err, socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = JSON.stringify({
      error: { code: "bad_request", message: "Bad request" },
    });
    socket.end(
      "HTTP/1.1 400 Bad Request\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body,
    );
  });

  const hostname = options.hostname ?? "0.0.0.0";

  const ready = new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const addr = server.address();
      resolve(
        typeof addr === "object" && addr !== null ? addr.port : options.port,
      );
    });
    server.once("error", reject);
  });

  server.listen(options.port, hostname);

  const handle: ServerHandle = {
    get port(): number {
      const addr = server.address();
      return typeof addr === "object" && addr !== null ? addr.port : options.port;
    },
    stop: (force?: boolean) => {
      if (force) {
        server.closeAllConnections?.();
      }
      // Graceful: stop accepting and drain in-flight connections.
      server.close();
    },
  };

  return {
    server: handle,
    stop: () => handle.stop(),
    port: options.port,
    ready,
  };
}
