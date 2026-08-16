// src/runtime/native.ts — the FFI-facing runtime seam.
//
// What the `rust-ffi` layer / selection / shared helpers consume: runtime
// detection, UTF-8 codec, uuid, env resolution, the Bun built-in delegation
// registry, and the native transport (bun:ffi vs napi). Importing this module
// does NOT eagerly bind the ffi transport (lazy) and never pulls the ingress
// graph, so `rust-ffi/*` can import it without a cycle.
//
// The FULL adapter (adding `server` + `websocket`) is composed in
// `src/runtime/index.ts` / `src/runtime/server.ts` for the public API.

import { resolveEnvVar } from '../shared/env'
import { runtimeBuiltins } from './builtins'
import { runtimeCodec } from './codec'
import { detectedRuntime } from './detect'
import { createTransport } from './transport'
import type { NativeRuntimeAdapter } from './types'
import { runtimeUuid } from './uuid'

/**
 * The shared runtime adapter (native seam) for the detected host runtime —
 * codec / uuid / env / builtins / transport. The FULL adapter (adding
 * `server` + `websocket`) is composed in `src/runtime/index.ts` for the
 * public API; the FFI layer imports THIS seam so it never pulls the ingress
 * graph.
 */
export const runtimeNative: NativeRuntimeAdapter = {
  name: detectedRuntime,
  isWebStandard: detectedRuntime === 'bun',
  codec: runtimeCodec,
  uuid: runtimeUuid,
  env: { resolveVar: resolveEnvVar },
  builtins: runtimeBuiltins,
  transport: createTransport(),
}
