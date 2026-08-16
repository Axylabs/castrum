// src/runtime/server.ts — platform HTTP server adapter (Bun.serve / node:http).
//
// The SAME pre-baked ingress route handlers (`buildRouteHandlers`) are served
// by `Bun.serve` on Bun (src/ingress/server.ts) and the `node:http` adapter on
// Node (src/ingress/server-node.ts). Historically consumers had to pick
// `createIngressServer` (Bun-only) vs `createIngressServerNode` explicitly;
// this adapter lets the public `createIngressServer` pick the backend once,
// at module load. Selected ONCE — the branch never runs in the hot path.

import type { BakedServer, CreateIngressServerOptions } from '../ingress/server'
import { createIngressServer as createIngressServerBun } from '../ingress/server'
import { createIngressServerNode } from '../ingress/server-node'
import { detectedRuntime } from './detect'
import type { ServerAdapter } from './types'

/** The shared server adapter for the detected host runtime. */
export const runtimeServer: ServerAdapter = {
  runtime: detectedRuntime === 'bun' ? 'bun' : 'node',
  createIngressServer,
}

/**
 * Create the runtime-appropriate ingress server: `Bun.serve` on Bun, the
 * `node:http` adapter on Node. Selected ONCE at module load — the branch
 * never runs in the hot path.
 */
export function createIngressServer(options: CreateIngressServerOptions): BakedServer {
  return detectedRuntime === 'bun'
    ? createIngressServerBun(options)
    : createIngressServerNode(options)
}
