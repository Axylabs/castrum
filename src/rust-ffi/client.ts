// src/rust-ffi/client.ts — Rust client factory + default instance.
//
// Composes the per-namespace builders (scalar / text / batch / packed) over a
// shared per-instance context (./context.ts) and exposes `configure`.

import { createContext } from "./context";
import { buildText, type RustText } from "./text";
import { buildBatch, type RustBatch } from "./batch";
import { buildPacked, type RustPacked } from "./packed";
import { buildScalar, type RustScalar } from "./scalar";
import type { RustOptions } from "./options";

/** The full Rust FFI client (scalar methods + namespaces + configuration). */
export interface RustClient extends RustScalar {
  // ── Namespaces ──
  text: RustText;
  batch: RustBatch;
  packed: RustPacked;

  // ── Configuration ──
  /**
   * Update defaults on this instance. `mimeCache` / `hmacCache` apply
   * immediately (per-instance). `rayonThreads` is applied only if the
   * process-wide pool is not yet initialized (see {@link RustOptions}).
   */
  configure(options: RustOptions): void;
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
  const ctx = createContext(options);

  return {
    ...buildScalar(ctx),
    text: buildText(ctx),
    batch: buildBatch(ctx),
    packed: buildPacked(ctx),

    // ── Configuration ──
    configure(next) {
      // rayonThreads only takes effect BEFORE the pool is first used.
      if (next.rayonThreads !== undefined && !ctx.isPoolInitialized()) {
        ctx.setPendingThreads(next.rayonThreads);
      }

      if (next.mimeCache !== undefined) {
        ctx.state.mimeCache = next.mimeCache;
      }

      if (next.hmacCache !== undefined) {
        ctx.state.hmacCache = next.hmacCache;
      }
    },
  };
}

// ── Default instance (optimized defaults) ─────────────────────

export const rust = createRust();

// ── Back-compat alias (non-breaking) ───────────────────────────

/** @deprecated Use `rust.batch` (same object). */
export const rustBatch = rust.batch;
