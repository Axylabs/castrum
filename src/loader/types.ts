// src/loader/types.ts — public loader type surface (pure types).
//
// The callable loader contract (`Loader`), its option/stats shapes, the
// specialized op-function type (`LoaderOpFn`), and the `load()` helpers.
// No runtime code — erased at compile time.

import type { SchemaValidator } from '../shared/packed'
import type { LoaderBulk, LoaderBulkArgs, LoaderOpArgs, LoaderOpName, LoaderScalar } from './ops'

// ── Public types ────────────────────────────────────────────────────────────

/** Options for `createLoader()` / `loader.configure()`. */
export interface LoaderOptions {
  /** Let each op adapt `batchMin` from measured dispatch cost. Default true. */
  adaptive?: boolean
  /** Initial batch threshold in [2, 8]. Default 2 (batch wins for n >= 2). */
  batchMin?: number
  /** Max cached keys (bounded LRU). 0 disables caching. Default 256. */
  maxCacheKeys?: number
  /** Default `cache` behavior for `load()`. Default true. */
  caching?: boolean
  /** Sample timing every N dispatches (hot-path cost control). Default 32. */
  sampleEvery?: number
  /**
   * `load()` dispatch strategy. `"auto"` (default) switches each op between
   * `"single"` (low load → direct scalar call, no coalescer) and
   * `"coalesce"` (rising load → one packed batch call) from observed load.
   */
  loadStrategy?: LoadStrategy
}

/** Options for `load()` / `opFn.load()`. */
export interface LoadOptions {
  /**
   * Explicit cache key. When omitted (and caching is on) the default key is
   * `fnv1a64(input)` — which costs one extra native call per load.
   */
  key?: string
  /** Override the loader-wide caching toggle for this call. Default true. */
  cache?: boolean
}

/** Per-op counters exposed on `opFn.stats`. */
export interface LoaderOpStats {
  scalarCalls: number
  batchCalls: number
  itemsDispatched: number
  cachedHits: number
  /** Current learned batch threshold for this op. */
  batchMin: number
  /** Current `load()` strategy: "single" (low load) or "coalesce" (bulk). */
  mode: 'single' | 'coalesce'
}

/** Aggregate loader statistics. */
export interface LoaderStats {
  scalarCalls: number
  batchCalls: number
  itemsDispatched: number
  flushes: number
  cachedHits: number
  cacheSize: number
  cacheEvictions: number
}

/** A specialized, pre-bound op function returned by `loader(op)`. */
export interface LoaderOpFn<K extends LoaderOpName> {
  /** Single item → scalar result. */
  (input: Uint8Array, ...rest: LoaderOpArgs[K]): LoaderScalar<K>
  /** Bulk items → ONE packed batch call; same shape as `rust.batch.<op>`. */
  (inputs: Uint8Array[], ...rest: LoaderBulkArgs<K>): LoaderBulk<K>
  readonly name: K
  readonly stats: LoaderOpStats
  clear(): void
  /** Sync cache peek (default key `fnv1a64(input)` unless `key` given). */
  cache(input: Uint8Array, key?: string): LoaderScalar<K> | undefined
  /**
   * Coalesced, cache-aware load. Unavailable (`undefined`) on ops that require
   * extra arguments (e.g. `hmacSha256`, `signCookie`) — use `run` for those.
   */
  load: K extends LoadableName ? LoaderLoadFn<K> : undefined
}

type LoaderLoadFn<K extends LoaderOpName> = (
  input: Uint8Array,
  opts?: LoadOptions,
) => Promise<LoaderScalar<K>>

/** Ops whose extra args are all optional/empty → they support `load()`. */
export type LoadableName = {
  [K in LoaderOpName]: LoaderOpArgs[K] extends
    | []
    | [unknown?]
    | [unknown?, unknown?]
    | [unknown?, unknown?, unknown?]
    ? K
    : never
}[LoaderOpName]

/** A validator-bound helper returned by `loader.schema(validator)`. */
export interface LoaderSchemaFn {
  /** Single JSON document → valid? */
  (input: Uint8Array): boolean
  /** Bulk JSON documents → bitset (1 per doc). */
  (inputs: Uint8Array[]): Uint8Array
  /** Count how many bulk documents are valid. */
  count(inputs: Uint8Array[]): number
}

/** The global callable loader. */
export interface Loader {
  /** Higher-order function: `loader(op)` → specialized hot op function. */
  <K extends LoaderOpName>(op: K): LoaderOpFn<K>
  /** Single-item dispatch. */
  run<K extends LoaderOpName>(op: K, input: Uint8Array, ...rest: LoaderOpArgs[K]): LoaderScalar<K>
  /** Bulk dispatch (one packed batch call, or adaptive scalar loop). */
  run<K extends LoaderOpName>(
    op: K,
    inputs: Uint8Array[],
    ...rest: LoaderBulkArgs<K>
  ): LoaderBulk<K>
  /** Coalesced, cache-aware load (ops with required extra args throw). */
  load<K extends LoadableName>(
    op: K,
    input: Uint8Array,
    opts?: LoadOptions,
  ): Promise<LoaderScalar<K>>
  /** Sync cache peek. */
  cache<K extends LoaderOpName>(op: K, input: Uint8Array, key?: string): LoaderScalar<K> | undefined
  /**
   * Bind a `SchemaValidator` for repeated single/bulk JSON-schema validation
   * plus a whole-batch `count`. The returned callable uses the loader's normal
   * dispatch machinery (cost model + counters).
   */
  schema(validator: SchemaValidator): LoaderSchemaFn
  /** Clear the shared cache (pending coalesced loads still flush). */
  clear(): void
  /** Update options at runtime. */
  configure(options: LoaderOptions): void
  readonly stats: LoaderStats
  readonly opNames: LoaderOpName[]
}

/** Load-dispatch strategy selector for `load()`. */
export type LoadStrategy = 'auto' | 'single' | 'coalesce'
