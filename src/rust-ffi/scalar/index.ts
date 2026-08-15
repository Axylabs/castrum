// src/rust-ffi/scalar/index.ts — Scalar + feature FFI methods (barrel).
//
// The byte-level single-value methods of the Rust client (crc32, hmac, json,
// jwt, password, aead, compress, ... plus the class factories and runtime
// controls). Composed into the client by ./client.ts.
//
// The `RustScalar` interface (the public surface, with its perf JSDoc) lives
// in `interface.ts`; the implementation is split into domain builders mirroring
// `rust/` (hashing, json, http, crypto, payload, factories).

import type { RustClientContext } from '../context'
import { buildCrypto } from './crypto'
import { buildFactories } from './factories'
import { buildHashing } from './hashing'
import { buildHttp } from './http'
import { buildJson } from './json'
import { buildPayload } from './payload'

export type { RustScalar } from './interface'

/** Build the scalar/feature method set for a client context. */
export function buildScalar(ctx: RustClientContext): import('./interface').RustScalar {
  return {
    ...buildHashing(ctx),
    ...buildJson(ctx),
    ...buildHttp(ctx),
    ...buildCrypto(ctx),
    ...buildPayload(ctx),
    ...buildFactories(ctx),
  }
}
