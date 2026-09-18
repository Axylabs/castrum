// src/shared/memory.ts — Public memory-flush escape hatch.
//
// Impure boundary module: it owns no state of its own but reaches the cache
// owners (the global loader LRU and the process-wide MIME caches) to drop their
// retained entries, then optionally requests a runtime GC. The metrics registry
// is deliberately NOT flushed — an observability registry is not a cache, and
// clearing it would erase the counters an operator is watching.

import { loader } from '../loader'
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
 * - the process-wide MIME caches (`clearMimeCaches()`).
 *
 * The native schema cache is a no-op placeholder here and is wired in a later
 * task. The metrics registry is intentionally left untouched.
 *
 * Idempotent, and safe to call before the native addon has ever been loaded
 * (every cache starts empty and the loader cache is a plain Map).
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

  // Native schema cache: intentionally a no-op placeholder until the later
  // task wires its owner here.

  if (options.gc !== false) {
    forceGc()
  }
}
