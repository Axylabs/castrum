// src/runtime/index.ts — runtime adapter barrel (FULL adapter).
//
// Composes the FFI-facing runtime seam (`src/runtime/native.ts`) with the
// platform server / websocket adapters (`src/runtime/server.ts` +
// `websocket.ts`). The FFI layer imports the seam from `./native` (it never
// pulls the ingress graph); the public API imports the full `runtime` from
// here.

import { runtimeNative } from './native'
import { runtimeServer } from './server'
import type { RuntimeAdapter } from './types'
import { runtimeWebsocket } from './websocket'

/** The full runtime adapter for the detected host runtime (native + server + websocket). */
export const runtime: RuntimeAdapter = {
  ...runtimeNative,
  server: runtimeServer,
  websocket: runtimeWebsocket,
}

// Runtime detection (cached) — the single place `typeof Bun` is checked.
export { detectedRuntime, isBunRuntime, isNodeRuntime, nodeMajorVersion } from './detect'
export { runtimeNative } from './native'
// Runtime-driven server factory (Bun.serve on Bun, node:http on Node) — the
// public `createIngressServer` (src/ingress/index.ts) re-exports this.
export { createIngressServer } from './server'

export type { RuntimeName } from './types'
