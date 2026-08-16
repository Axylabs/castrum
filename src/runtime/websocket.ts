// src/runtime/websocket.ts — platform WebSocket upgrade adapter.
//
// `createWebSocketUpgrade` returns the RFC 6455 101 handshake on Bun (whose
// `Response` can carry status 101) and throws a clear Bun-only error on Node
// (whose fetch `Response` rejects 101 — Node users must use the server-node
// `upgrade` option instead). The handshake computation lives in
// `src/integration/websocket.ts`; this adapter owns the runtime branch.

import type { WebSocketUpgradeOptions, WebSocketUpgradeResult } from '../integration/websocket'
import { createWebSocketUpgrade as buildBunUpgrade } from '../integration/websocket'
import { detectedRuntime } from './detect'
import type { WebsocketAdapter } from './types'

const BUN_ONLY_ERROR =
  "createWebSocketUpgrade is Bun-only: Node's Response cannot carry status 101. " +
  "On Node, use createIngressServerNode's `upgrade` option and compute the " +
  'accept key with rust.text.wsAcceptKey().'

/** The shared websocket adapter for the detected host runtime. */
export const runtimeWebsocket: WebsocketAdapter = {
  createWebSocketUpgrade(
    req: Request,
    opts?: WebSocketUpgradeOptions,
  ): WebSocketUpgradeResult | null {
    if (detectedRuntime !== 'bun') {
      throw new Error(BUN_ONLY_ERROR)
    }
    return buildBunUpgrade(req, opts)
  },
}
