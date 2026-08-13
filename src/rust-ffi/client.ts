// src/rust-ffi/client.ts — Rust client factory + default instance.
//
// Composes the per-namespace builders (scalar / text / batch / packed) over a
// shared per-instance context (./context.ts) and exposes `configure`.

import { createContext } from './context'
import { buildText, type RustText } from './text'
import { buildBatch, type RustBatch } from './batch'
import { buildPacked, type RustPacked } from './packed'
import { buildScalar, type RustScalar } from './scalar'
import { getBunFFI } from '../native/ffi'
import type { RustOptions } from './options'

/** The full Rust FFI client (scalar methods + namespaces + configuration). */
export interface RustClient extends RustScalar {
  // ── Namespaces ──
  text: RustText
  batch: RustBatch
  packed: RustPacked

  // ── Transport introspection ──
  /**
   * Resolve the native transport in use on this runtime: `"ffi"` (bun:ffi —
   * the PRIMARY transport under Bun) or `"napi"` (Node, forced
   * `CASTRUM_FFI_MODE=napi`, or a failed ffi bind-time self-test).
   */
  transport(): 'ffi' | 'napi'
  /** Whether the bun:ffi transport is live (equivalent to `transport() === "ffi"`). */
  ffiActive(): boolean

  // ── Configuration ──
  /**
   * Update defaults on this instance. `mimeCache` / `hmacCache` apply
   * immediately (per-instance). `rayonThreads` is applied only if the
   * process-wide pool is not yet initialized (see {@link RustOptions}).
   */
  configure(options: RustOptions): void
}

/**
 * Create an isolated Rust client with the given defaults.
 *
 * `mimeCache` / `hmacCache` are per-instance. `rayonThreads` only applies
 * before the process-wide rayon pool is initialized (once per process — see
 * {@link RustOptions.rayonThreads}); the pool defaults to the env var or
 * `max(1, hardwareConcurrency - 1)` otherwise.
 */
export function createRust(options: RustOptions = {}): RustClient {
  const ctx = createContext(options)

  return {
    ...buildScalar(ctx),
    text: buildText(ctx),
    batch: buildBatch(ctx),
    packed: buildPacked(ctx),

    // ── Transport introspection (FFI-primary on Bun; napi is the fallback) ──
    transport() {
      return getBunFFI() !== null ? 'ffi' : 'napi'
    },
    ffiActive() {
      return getBunFFI() !== null
    },

    // ── Configuration ──
    configure(next) {
      // rayonThreads only takes effect BEFORE the pool is first used.
      if (next.rayonThreads !== undefined && !ctx.isPoolInitialized()) {
        ctx.setPendingThreads(next.rayonThreads)
      }

      if (next.mimeCache !== undefined) {
        ctx.state.mimeCache = next.mimeCache
      }

      if (next.hmacCache !== undefined) {
        ctx.state.hmacCache = next.hmacCache
      }
    },
  }
}

/**
 * The default, ready-to-use `RustClient` created with no options (resolves
 * rayon threads from the host automatically). Most consumers just do
 * `import { rust } from "castrum"` and call `rust.<fn>(...)` directly.
 */
export const rust = createRust()
