// src/loader/state.ts — internal loader dispatch state (pure types).
//
// The per-op dispatch context, memoized op-fn entry, and the aggregate
// `LoaderState` shared by the dispatch core (index.ts). `KEY_SEP` is the
// cache-key separator for `op + '\0' + key`.

import type { LoaderCache, LoadRequest, TickCoalescer } from './batch'
import type { LoaderCostModel } from './cost'
import type { LoaderOpFn, LoaderOpName, LoaderOptions } from './types'

// ── Internal state ──────────────────────────────────────────────────────────

interface OpCounters {
  scalarCalls: number
  batchCalls: number
  itemsDispatched: number
  cachedHits: number
}


/**
 * Pre-bound per-op dispatch context — avoids Map lookups on the hot path.
 * Holds the load-aware `load()` strategy plus its cheap integer signals so
 * the single-vs-coalesce decision costs no Map lookup or allocation.
 */
interface OpDispatchCtx {
  cost: LoaderCostModel
  counters: OpCounters
  sampleEvery: number
  /** Per-op sample tick counter (advances on every dispatch). */
  counter: number
  /** Current `load()` strategy for this op. */
  mode: 'single' | 'coalesce'
  /** Consecutive single-load flushes observed (coalesce mode only). */
  singleStreak: number
  /** A single-mode load is waiting on its microtask to dispatch. */
  pendingSingle: boolean
  pendingInput: Uint8Array | null
  pendingResolve: ((value: unknown) => void) | null
  pendingReject: ((error: unknown) => void) | null
  pendingKey: string | undefined
  /** Default-key attempts (adaptive key computation). */
  keyAttempts: number
  /** Default-key cache hits observed. */
  keyHits: number
  /** Periodic re-probe counter for skipped default keys. */
  keyProbeCounter: number
}

/** A memoized op fn plus a hook to rebind its dispatch context on configure. */
interface OpFnEntry {
  op: LoaderOpName
  fn: LoaderOpFn<LoaderOpName>
  /** Rebind to a fresh context after `configure()` so dispatch + stats stay current. */
  rebind(ctx: OpDispatchCtx): void
}

interface LoaderState {
  options: Required<
    Pick<
      LoaderOptions,
      'adaptive' | 'batchMin' | 'maxCacheKeys' | 'caching' | 'sampleEvery' | 'loadStrategy'
    >
  >
  ctxs: Map<LoaderOpName, OpDispatchCtx>
  cache: LoaderCache
  coalescer: TickCoalescer
  opFns: Map<LoaderOpName, OpFnEntry>
  flushes: number
  /** Reusable packed-input scratch for the zero-alloc fast flush (grows). */
  packScratch: Uint8Array
  /** Reusable packed-output buffer for the zero-alloc fast flush (grows). */
  outScratch: Uint8Array
  /** Reusable packed-key output buffer for the batched default-key flush. */
  keyScratch: Uint8Array
}

const KEY_SEP = '\u0000'

