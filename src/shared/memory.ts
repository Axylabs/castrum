// src/shared/memory.ts — Public memory-flush escape hatch.
//
// Impure boundary module: it owns no state of its own but reaches the cache
// owners (the global loader LRU and the process-wide MIME caches) to drop their
// retained entries, then optionally requests a runtime GC. The metrics registry
// is deliberately NOT flushed — an observability registry is not a cache, and
// clearing it would erase the counters an operator is watching.

import { loader } from '../loader'
import { rust } from '../rust-ffi'
import { clearMimeCaches } from '../rust-ffi/context'
import { forceGc } from './runtime'

/** Options for {@link flushMemory}. */
export interface FlushMemoryOptions {
  /**
   * When true (the default), also request a full garbage collection from the
   * runtime: `Bun.gc(true)` on Bun, `globalThis.gc?.()` on Node when the
   * process runs with `--expose-gc`. Set false to flush caches only.
   */
  gc?: boolean
}

/**
 * Flush process-level caches and (by default) request a full GC. Intended for
 * explicit memory-pressure handling — e.g. after a burst or before a snapshot.
 *
 * Clears:
 * - the global loader LRU cache (`loader.clear()`),
 * - the process-wide MIME caches (`clearMimeCaches()`),
 * - the native compiled-schema cache (`rust.clearSchemaCache()`).
 *
 * The metrics registry is intentionally left untouched.
 *
 * Idempotent, and safe to call before the native addon has ever been loaded
 * (every cache starts empty, the loader cache is a plain Map, and the native
 * schema-cache clear is a defensive no-op when the addon/symbol is absent).
 *
 * @param options - `gc: false` skips the runtime GC request. Defaults to `{}`
 *   (GC requested).
 * @example
 * ```ts
 * import { flushMemory } from 'castrum'
 *
 * flushMemory()            // drop caches + request GC
 * flushMemory({ gc: false }) // drop caches only
 * ```
 */
export function flushMemory(options: FlushMemoryOptions = {}): void {
  // Global loader LRU (createLoader() instances own their own caches and are
  // not registered globally — flush the shared singleton only).
  loader.clear()

  // Process-wide MIME caches (bytes + string forms).
  clearMimeCaches()

  // Process-wide native compiled-schema cache. Defensive: an absent or stale
  // addon (no `clearSchemaCache` symbol) must be a no-op, never a throw.
  try {
    rust.clearSchemaCache()
  } catch {
    // addon not loaded / stale build — nothing to clear.
  }

  if (options.gc !== false) {
    forceGc()
  }
}
