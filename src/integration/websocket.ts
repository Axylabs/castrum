// src/integration/websocket.ts — WebSocket upgrade handshake helper.

import { isBun } from '../shared/runtime'
import { rust } from '../rust-ffi'
/** Options for `createWebSocketUpgrade` (supported subprotocols). */export interface WebSocketUpgradeOptions {
  /** Subprotocols this server supports; the first client-requested match wins. */
  protocols?: ReadonlyArray<string>
}

/** The WebSocket upgrade handshake result (101 response + negotiation info). */
export interface WebSocketUpgradeResult {
  /** The 101 Switching Protocols response — return it from your fetch handler. */
  readonly response: Response
  /** The client's `Sec-WebSocket-Key` (handy for connection logging). */
  readonly key: string
  /** The negotiated subprotocol, if any. */
  readonly protocol: string | null
}

/**
 * Build a WebSocket 101 upgrade handshake response for a request.
 *
 * Validates `Sec-WebSocket-Key` presence and computes the RFC 6455 accept key
 * via the native `rust.wsAcceptKey`, optionally negotiates a subprotocol, and
 * returns a ready-to-serve `Response`. Returns `null` when the request is not a
 * valid upgrade (missing/empty key).
 *
 * This only produces the handshake — pair it with your framework's own
 * WebSocket server (Bun.serve's `websocket` handler, or a WS library), which
 * owns the subsequent frames:
 *
 * @example
 * ```ts
 * const srv = Bun.serve({
 *   port: 3000,
 *   fetch(req, server) {
 *     const up = createWebSocketUpgrade(req, { protocols: ["chat"] });
 *     if (up && server.upgrade(req, { data: { protocol: up.protocol } })) {
 *       return up.response;
 *     }
 *     return new Response("Not a websocket", { status: 400 });
 *   },
 *   websocket: {
 *     message(ws, msg) { ws.send(msg); },
 *   },
 * });
 * ```
 */
export function createWebSocketUpgrade(
  req: Request,
  opts: WebSocketUpgradeOptions = {},
): WebSocketUpgradeResult | null {
  const key = req.headers.get('sec-websocket-key')
  if (!key || key.length === 0) return null

  const accept = rust.text.wsAcceptKey(key)

  let protocol: string | null = null
  const offered = opts.protocols ?? []
  const requested = req.headers.get('sec-websocket-protocol')
  if (requested && offered.length > 0) {
    const wanted = requested
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    protocol = offered.find((p) => wanted.some((w) => w.toLowerCase() === p.toLowerCase())) ?? null
  }

  // Node's fetch `Response` rejects status 101 (undici allows only 200-599);
  // Bun permits it. This helper produces a Bun.serve-compatible 101 Response,
  // so on Node throw a clear error pointing at the Node adapter's `upgrade`
  // option (which writes the RFC 6455 handshake head directly).
  if (!isBun()) {
    throw new Error(
      "createWebSocketUpgrade is Bun-only: Node's Response cannot carry status 101. " +
        "On Node, use createIngressServerNode's `upgrade` option and compute the " +
        'accept key with rust.text.wsAcceptKey().',
    )
  }

  const headers: Record<string, string> = {
    'sec-websocket-accept': accept,
  }
  if (protocol) {
    headers['sec-websocket-protocol'] = protocol
  }

  return {
    response: new Response(null, { status: 101, headers }),
    key,
    protocol,
  }
}
