// src/loader/index.ts — Global higher-order-function data loader (HFC).
//
// `loader` is a CALLABLE object — a higher-order function over the curated op
// set. `loader("validateEmail")` returns a specialized, pre-bound hot function
// whose closure carries that op's spec, cost model and shared cache, so
// repeated calls do NO registry dispatch.
//
// Runtime self-optimization ("bulk or single"):
//   - single item  → scalar call (1 crossing, zero packing)
//   - bulk items   → ONE packed batch call by default; the adaptive cost model
//                    may route tiny batches to a scalar loop when measurement
//                    shows it is actually cheaper
//   - `load()`     → DataLoader-style: N calls in the same event-loop tick are
//                    coalesced into ONE packed native call (N crossings → 1);
//                    sustained LOW load drops the coalescer and dispatches
//                    singles directly, switching back to bulk on a same-tick
//                    burst (all automatic, per op)
//   - caching      → bounded LRU ("Hot Function Cache"), default key =
//                    fnv1a64(input) (skipped for sustained-unique workloads),
//                    opt-in per call via `{ key, cache }`
//
// Structure: this file is the DISPATCH CORE + factory. The pure pieces live
// beside it: `types.ts` (public type surface), `state.ts` (internal dispatch
// state), `ops.ts` (op registry), `cost.ts` (adaptive cost model), `batch.ts`
// (LRU cache + tick coalescer). Public types are re-exported below.

import {
  LOADER_OPS,
  fnvBatchKeysInto,
  type LoaderBulkArgs,
  type LoaderOpArgs,
  type LoaderOpName,
  type LoaderOpSpec,
  type LoaderScalar,
  type LoaderBulk,
} from './ops'
import { createCostModel, nowNs, type LoaderCostModel } from './cost'
import {
  createLruCache,
  createTickCoalescer,
  type LoaderCache,
  type LoadRequest,
  type TickCoalescer,
} from './batch'
import type {
  LoadOptions,
  LoaderOpFn,
  LoaderOpStats,
  LoaderOptions,
  LoaderSchemaFn,
  LoaderStats,
  LoadStrategy,
} from './types'
import { KEY_SEP } from './state'
import type { OpDispatchCtx, OpFnEntry, LoaderState } from './state'
import { rust } from '../rust-ffi'
import { viewForArrayBuffer } from '../shared/bytes'
import type { SchemaValidator } from '../shared/packed'

// Re-export the op registry + types for introspection and authoring.
export {
  LOADER_OPS,
  LOADER_OP_NAMES,
  type LoaderOpName,
  type LoaderOpArgs,
  type LoaderBulkArgs,
  type LoaderBulk,
  type LoaderScalar,
  type LoaderResultKind,
  type ScalarResult,
  type BulkResult,
} from './ops'

// Re-export the public type surface so `import type { LoaderOptions } from
// '../loader'` keeps working (existing call sites).
export * from './types'

function ctxFor(state: LoaderState, op: LoaderOpName): OpDispatchCtx {
  let ctx = state.ctxs.get(op)
  if (!ctx) {
    ctx = {
      cost: createCostModel({
        adaptive: state.options.adaptive,
        batchMin: state.options.batchMin,
      }),
      counters: { scalarCalls: 0, batchCalls: 0, itemsDispatched: 0, cachedHits: 0 },
      sampleEvery: state.options.sampleEvery,
      counter: 0,
      // Load-aware strategy: "auto" starts coalescing so bursts batch from
      // the first tick; it drops to "single" after sustained single-load
      // flushes and back to "coalesce" on a same-tick burst.
      mode: state.options.loadStrategy === 'single' ? 'single' : 'coalesce',
      singleStreak: 0,
      pendingSingle: false,
      pendingInput: null,
      pendingResolve: null,
      pendingReject: null,
      pendingKey: undefined,
      keyAttempts: 0,
      keyHits: 0,
      keyProbeCounter: 0,
    }
    state.ctxs.set(op, ctx)
  }
  return ctx
}

/** Build a bulk-shaped result by looping scalar calls (the adaptive fallback). */
function scalarLoopBulk(spec: LoaderOpSpec, items: Uint8Array[], rest: unknown[]): unknown {
  const n = items.length
  const paired = spec.pairedRest ?? []
  // For paired ops the `rest` holds per-item companion ARRAYS; split them so
  // each scalar call gets its own companion + the shared args. Non-paired ops
  // take the `rest` array directly (zero allocation on the fallback path).
  const itemRest = (i: number): unknown[] =>
    paired.length === 0
      ? rest
      : rest.map((r, idx) => (paired.includes(idx) ? (r as unknown[])[i] : r))
  switch (spec.kind) {
    case 'boolean': {
      const out = new Uint8Array(n)
      let i = 0
      // NOTE: index the output with `i` (not `i++` inline) so `itemRest(i)`
      // sees the CURRENT index — `out[i++] = f(...itemRest(i))` would read the
      // already-incremented index (undefined companions for paired ops).
      for (const item of items) {
        out[i] = spec.scalar(item, ...itemRest(i)) ? 1 : 0
        i++
      }
      return out
    }
    case 'number': {
      const out = new Uint32Array(n)
      let i = 0
      for (const item of items) {
        out[i] = spec.scalar(item, ...itemRest(i)) as number
        i++
      }
      return out
    }
    case 'bigint': {
      const out = spec.unsigned ? new BigUint64Array(n) : new BigInt64Array(n)
      let i = 0
      for (const item of items) {
        out[i] = spec.scalar(item, ...itemRest(i)) as bigint
        i++
      }
      return out
    }
    case 'bytes': {
      const out = new Array<Uint8Array>(n)
      let i = 0
      for (const item of items) {
        out[i] = spec.scalar(item, ...itemRest(i)) as Uint8Array
        i++
      }
      return out
    }
  }
}

/** Single-item dispatch — no Map lookups; timed only on sample ticks. */
function dispatchSingle(
  ctx: OpDispatchCtx,
  spec: LoaderOpSpec,
  input: Uint8Array,
  rest: unknown[],
): unknown {
  const c = ctx.counters
  c.scalarCalls++
  c.itemsDispatched++
  const t = ++ctx.counter % ctx.sampleEvery === 0 ? nowNs() : 0
  const out = rest.length === 0 ? spec.scalar(input) : spec.scalar(input, ...rest)
  if (t !== 0) ctx.cost.recordScalar(1, nowNs() - t)
  return out
}

/** Bulk dispatch — packed batch, or adaptive scalar loop for tiny batches. */
function dispatchBulk(
  ctx: OpDispatchCtx,
  spec: LoaderOpSpec,
  items: Uint8Array[],
  rest: unknown[],
): unknown {
  const n = items.length
  const c = ctx.counters
  c.itemsDispatched += n

  if (ctx.cost.decide(n)) {
    const t = ++ctx.counter % ctx.sampleEvery === 0 ? nowNs() : 0
    const out = spec.batch(items, ...rest)
    if (t !== 0) ctx.cost.recordBatch(n, nowNs() - t)
    c.batchCalls++
    return out
  }

  const t = ++ctx.counter % ctx.sampleEvery === 0 ? nowNs() : 0
  const out = scalarLoopBulk(spec, items, rest)
  if (t !== 0) ctx.cost.recordScalar(n, nowNs() - t)
  c.scalarCalls++
  return out
}

/** Write a computed value into the cache when the request opted in. */
function maybeCache(state: LoaderState, req: LoadRequest, value: unknown): void {
  if (req.key !== undefined) state.cache.set(req.key, value)
}

/** Handle a coalesced flush group for one op. */
function handleFlush(state: LoaderState, op: LoaderOpName, requests: LoadRequest[]): void {
  state.flushes++
  const ctx = ctxFor(state, op)
  const spec: LoaderOpSpec = LOADER_OPS[op]
  const n = requests.length
  if (n === 1) {
    // Low load observed. After a sustained run of single flushes, drop the
    // coalescer for this op and dispatch singles directly (mode: "single").
    if (ctx.mode === 'coalesce' && state.options.loadStrategy === 'auto') {
      ctx.singleStreak++
      if (ctx.singleStreak >= SINGLE_AFTER) ctx.mode = 'single'
    }
    const req = requests[0]
    if (req === undefined) return
    try {
      // A lone coalesce-mode load may carry a deferred default key: compute it
      // here (scalar fnv — no packed overhead for a single item), and resolve
      // straight from the cache when present so no native op compute happens.
      if (req.needsDefaultKey) {
        if (shouldComputeDefaultKey(ctx)) {
          ctx.keyAttempts++
          const k = op + KEY_SEP + String(rust.fnv1a64(req.input))
          const hit = state.cache.get(k)
          if (hit !== undefined) {
            ctx.counters.cachedHits++
            ctx.keyHits++
            req.resolve(hit)
            return
          }
          req.key = k
        }
        req.needsDefaultKey = false
      }
      const value = dispatchSingle(ctx, spec, req.input, [])
      maybeCache(state, req, value)
      req.resolve(value)
    } catch (err) {
      req.reject(err)
    }
    return
  }

  // A real burst (n >= 2) keeps coalescing; reset the single-run counter.
  ctx.singleStreak = 0

  // Zero-alloc fast flush (boolean/number/bigint ops): pack the inputs into a
  // reusable scratch, write the packed native result straight into a reusable
  // output buffer via the `_into` variants, and read each element out of it —
  // no intermediate unpack array, no per-call native Vec or JS allocation.
  if (spec.fast !== undefined) {
    const c = ctx.counters
    c.batchCalls++
    c.itemsDispatched += n

    // Pack the requests directly (no `items.map`) into the reusable scratch.
    let total = 4
    for (const req of requests) total += 4 + req.input.byteLength
    let scratch = state.packScratch
    if (scratch.byteLength < total) {
      scratch = new Uint8Array(Math.max(256, total * 2))
      state.packScratch = scratch
    }
    const packView = viewForArrayBuffer(scratch.buffer, scratch.byteOffset)
    packView.setUint32(0, n, true)
    let pos = 4
    for (const req of requests) {
      packView.setUint32(pos, req.input.byteLength, true)
      pos += 4
      scratch.set(req.input, pos)
      pos += req.input.byteLength
    }

    // Hybrid coalesce: when any request deferred a default key, compute ALL
    // keys in ONE packed fnv1a64 crossing, resolve cache hits with NO native
    // op compute, and run the packed op batch only on the remaining misses
    // (repacked). The adaptive key-skip decision is made once per flush.
    const needKeys = requests.some((r) => r.needsDefaultKey)
    const computeKeys = needKeys && shouldComputeDefaultKey(ctx)
    let keyView: DataView | null = null
    if (computeKeys) {
      ctx.keyAttempts += n
      const keyTotal = 4 + n * 8
      let keyBuf = state.keyScratch
      if (keyBuf.byteLength < keyTotal) {
        keyBuf = new Uint8Array(keyTotal)
        state.keyScratch = keyBuf
      }
      fnvBatchKeysInto(scratch.subarray(0, total), keyBuf)
      keyView = viewForArrayBuffer(keyBuf.buffer, keyBuf.byteOffset)
    }

    const pending: number[] = []
    for (let i = 0; i < n; i++) {
      const req = requests[i]
      if (req === undefined) continue
      let key = req.key
      if (key === undefined && req.needsDefaultKey && keyView !== null) {
        key = op + KEY_SEP + String(keyView.getBigUint64(4 + i * 8, true))
        req.key = key
      }
      if (key !== undefined) {
        const hit = state.cache.get(key)
        if (hit !== undefined) {
          ctx.counters.cachedHits++
          if (req.needsDefaultKey) ctx.keyHits++
          req.resolve(hit)
          continue
        }
      }
      pending.push(i)
    }
    if (pending.length === 0) return

    // Repack the pending (miss) requests into the same scratch and run the
    // packed op batch. scratch is sized >= total >= the subset size, so it is
    // reused without reallocating; the op only runs on the misses.
    const m = pending.length
    let total2 = 4
    for (const i of pending) {
      const req = requests[i]
      if (req !== undefined) total2 += 4 + req.input.byteLength
    }
    packView.setUint32(0, m, true)
    let pos2 = 4
    for (let j = 0; j < m; j++) {
      const pi = pending[j]
      if (pi === undefined) continue
      const req = requests[pi]
      if (req === undefined) continue
      packView.setUint32(pos2, req.input.byteLength, true)
      pos2 += 4
      scratch.set(req.input, pos2)
      pos2 += req.input.byteLength
    }

    // Size the reusable output buffer to the exact packed result.
    const outSize = spec.fast.outSize(m)
    let out = state.outScratch
    if (out.byteLength < outSize) {
      out = new Uint8Array(outSize)
      state.outScratch = out
    }
    try {
      spec.fast.batch(scratch.subarray(0, total2), out)
      const outView = viewForArrayBuffer(out.buffer, out.byteOffset)
      for (let j = 0; j < m; j++) {
        const pi = pending[j]
        if (pi === undefined) continue
        const req = requests[pi]
        if (req === undefined) continue
        const value = spec.fast.element(outView, out, j)
        maybeCache(state, req, value)
        req.resolve(value)
      }
    } catch (err) {
      for (const j of pending) {
        const req = requests[j]
        if (req === undefined) continue
        req.reject(err)
      }
    }
    return
  }

  const items = requests.map((r) => r.input)
  try {
    const bulk = dispatchBulk(ctx, spec, items, [])
    for (let i = 0; i < n; i++) {
      const req = requests[i]
      if (req === undefined) continue
      const value = spec.element(bulk, i)
      maybeCache(state, req, value)
      req.resolve(value)
    }
  } catch (err) {
    for (const req of requests) req.reject(err)
  }
}

/**
 * Decide whether to compute a default (`fnv1a64`) cache key for this call.
 * Warm-up always computes (documented default). Once enough attempts show
 * ZERO hits the inputs are unique — skip the key (one native crossing +
 * string alloc) so `load()` stays cheap for unique workloads; a periodic
 * probe re-enables it if inputs start repeating.
 */
function shouldComputeDefaultKey(ctx: OpDispatchCtx): boolean {
  if (ctx.keyAttempts < KEY_WARMUP) return true
  if (ctx.keyHits > 0) return true
  return ++ctx.keyProbeCounter % KEY_PROBE_EVERY === 0
}

/** Resolve a single-mode load: dispatch the scalar and (optionally) cache. */
function flushSingle(state: LoaderState, op: LoaderOpName, ctx: OpDispatchCtx): void {
  const spec = LOADER_OPS[op]
  const input = ctx.pendingInput
  const resolve = ctx.pendingResolve
  const reject = ctx.pendingReject
  const key = ctx.pendingKey
  ctx.pendingSingle = false
  ctx.pendingInput = null
  ctx.pendingResolve = null
  ctx.pendingReject = null
  ctx.pendingKey = undefined
  // A same-tick burst moved this request to the coalescer — nothing to do.
  if (input === null || resolve === null) return
  try {
    const value = dispatchSingle(ctx, spec, input, [])
    if (key !== undefined) state.cache.set(key, value)
    resolve(value)
  } catch (err) {
    if (reject !== null) reject(err)
  }
}

/** Shared `load` implementation used by `opFn.load` and `loader.load`. */
function loadOne(
  state: LoaderState,
  op: LoaderOpName,
  input: Uint8Array,
  opts?: LoadOptions,
): Promise<unknown> {
  // Ops with required extra args cannot be coalesced (all group members must
  // share the same args); surface a clear error instead of a broken batch.
  if (hasRequiredRest(op)) {
    return Promise.reject(
      new TypeError(
        `loader.load: op "${op}" requires extra arguments; use loader.run("${op}", …) instead`,
      ),
    )
  }

  const ctx = ctxFor(state, op)
  const spec: LoaderOpSpec = LOADER_OPS[op]
  const caching = state.options.caching && state.options.maxCacheKeys > 0 && (opts?.cache ?? true)

  let key: string | undefined
  let needsDefaultKey = false
  if (caching) {
    if (opts?.key !== undefined) {
      // Explicit key: computable synchronously, so keep the eager cache check
      // and let a hit resolve without a coalescer flush.
      key = op + KEY_SEP + opts.key
      const hit = state.cache.get(key)
      if (hit !== undefined) {
        ctx.counters.cachedHits++
        return Promise.resolve(hit)
      }
    } else if (ctx.mode === 'coalesce' && spec.fast !== undefined && state.coalescer.pending > 0) {
      // Mid-burst on a cheap (fast) op: defer the default key to the flush so
      // all keys are computed in ONE packed native crossing instead of one
      // scalar fnv1a64 crossing per load. A LONE load (the first in the tick,
      // `pending === 0`) keeps the eager key so a cache hit still resolves
      // synchronously with no coalescer flush. Single mode and non-fast ops
      // also keep eager keys.
      needsDefaultKey = true
    } else if (shouldComputeDefaultKey(ctx)) {
      ctx.keyAttempts++
      key = op + KEY_SEP + String(rust.fnv1a64(input))
      const hit = state.cache.get(key)
      if (hit !== undefined) {
        ctx.counters.cachedHits++
        ctx.keyHits++
        return Promise.resolve(hit)
      }
    }
  }

  return new Promise((resolve, reject) => {
    // Load-time strategy: low load → single scalar call (no coalescer
    // bookkeeping, no flush); a rising same-tick load → switch to bulk.
    if (ctx.mode === 'single') {
      if (!ctx.pendingSingle) {
        ctx.pendingSingle = true
        ctx.pendingInput = input
        ctx.pendingResolve = resolve
        ctx.pendingReject = reject
        ctx.pendingKey = key
        queueMicrotask(() => flushSingle(state, op, ctx))
      } else {
        // A second load in the same event-loop tick = rising load → coalesce.
        ctx.mode = 'coalesce'
        const first: LoadRequest = {
          input: ctx.pendingInput ?? input,
          resolve: ctx.pendingResolve ?? resolve,
          reject: ctx.pendingReject ?? reject,
          key: ctx.pendingKey,
        }
        ctx.pendingSingle = false
        ctx.pendingInput = null
        ctx.pendingResolve = null
        ctx.pendingReject = null
        ctx.pendingKey = undefined
        state.coalescer.enqueue(op, first)
        state.coalescer.enqueue(op, { input, resolve, reject, key })
      }
      return
    }
    state.coalescer.enqueue(op, { input, resolve, reject, key, needsDefaultKey })
  })
}

function hasRequiredRest(op: LoaderOpName): boolean {
  // Derived statically; a cheap runtime guard is unnecessary, so keep this
  // allowlist aligned with `LoadableName` above. Ops with required extra args
  // OR per-item companions cannot be coalesced (all group members must share
  // the same args) — `load()` is unavailable for them.
  switch (op) {
    case 'signCookie':
    case 'verifyCookie':
    case 'csrfVerify':
    case 'passwordHash':
    case 'passwordVerify':
    case 'hmacSha256':
    case 'hmacSha256Verify':
    case 'aeadEncrypt':
    case 'aeadDecrypt':
    case 'jwtSign':
    case 'jwtVerify':
    case 'jsonPatch':
    case 'urlResolve':
    case 'wsFrameEncode':
    case 'schemaValidate':
      return true
    default:
      return false
  }
}

/** Build a specialized hot function for one op. */
function makeOpFn<K extends LoaderOpName>(op: K, state: LoaderState): OpFnEntry {
  const spec = LOADER_OPS[op]
  // `ctx` is rebound on `configure()` (see OpFnEntry.rebind) so the hot path
  // stays a zero-lookup closure WITHOUT going stale after reconfiguration.
  let ctx = ctxFor(state, op)

  function opFn(input: Uint8Array | Uint8Array[], ...rest: unknown[]): unknown {
    if (Array.isArray(input)) {
      return dispatchBulk(ctx, spec, input as Uint8Array[], rest)
    }
    return dispatchSingle(ctx, spec, input as Uint8Array, rest)
  }

  const statsGetter = (): LoaderOpStats => {
    const c = ctx.counters
    return {
      scalarCalls: c.scalarCalls,
      batchCalls: c.batchCalls,
      itemsDispatched: c.itemsDispatched,
      cachedHits: c.cachedHits,
      batchMin: ctx.cost.batchMin,
      mode: ctx.mode,
    }
  }

  const loadFn = hasRequiredRest(op)
    ? undefined
    : (input: Uint8Array, opts?: LoadOptions) =>
        loadOne(state, op, input, opts) as Promise<LoaderScalar<K>>

  Object.defineProperties(opFn, {
    name: { value: op, enumerable: true },
    stats: { get: statsGetter, enumerable: true },
    clear: { value: () => state.cache.clear(), enumerable: true },
    cache: {
      value: (input: Uint8Array, key?: string) => {
        const raw = key ?? String(rust.fnv1a64(input))
        return state.cache.get(op + KEY_SEP + raw) as LoaderScalar<K> | undefined
      },
      enumerable: true,
    },
    load: { value: loadFn, enumerable: true },
  })

  return {
    op,
    fn: opFn as unknown as LoaderOpFn<LoaderOpName>,
    rebind(next: OpDispatchCtx) {
      ctx = next
    },
  }
}

// ── Factory + singleton ─────────────────────────────────────────────────────

/** Create an isolated loader with the given defaults. */
export function createLoader(options: LoaderOptions = {}): Loader {
  const state: LoaderState = {
    options: {
      adaptive: options.adaptive !== false,
      batchMin: Math.max(2, Math.min(8, options.batchMin ?? 2)),
      maxCacheKeys: options.maxCacheKeys ?? 256,
      caching: options.caching !== false,
      sampleEvery: options.sampleEvery ?? 32,
      loadStrategy: options.loadStrategy ?? 'auto',
    },
    ctxs: new Map(),
    cache: createLruCache(options.maxCacheKeys ?? 256),
    coalescer: createTickCoalescer((op, requests) =>
      handleFlush(state, op as LoaderOpName, requests),
    ),
    opFns: new Map(),
    flushes: 0,
    packScratch: new Uint8Array(0),
    outScratch: new Uint8Array(0),
    keyScratch: new Uint8Array(0),
  }

  const loader = ((op: LoaderOpName): LoaderOpFn<LoaderOpName> => {
    let entry = state.opFns.get(op)
    if (!entry) {
      entry = makeOpFn(op, state)
      state.opFns.set(op, entry)
    }
    return entry.fn
  }) as unknown as Loader

  const runFn = (
    op: LoaderOpName,
    input: Uint8Array | Uint8Array[],
    ...rest: unknown[]
  ): unknown => {
    const spec = LOADER_OPS[op]
    const ctx = ctxFor(state, op)
    if (Array.isArray(input)) {
      return dispatchBulk(ctx, spec, input, rest)
    }
    return dispatchSingle(ctx, spec, input, rest)
  }

  const loadFn = <K extends LoadableName>(op: K, input: Uint8Array, opts?: LoadOptions) =>
    loadOne(state, op, input, opts) as Promise<LoaderScalar<K>>

  const cacheFn = <K extends LoaderOpName>(
    op: K,
    input: Uint8Array,
    key?: string,
  ): LoaderScalar<K> | undefined => {
    const raw = key ?? String(rust.fnv1a64(input))
    return state.cache.get(op + KEY_SEP + raw) as LoaderScalar<K> | undefined
  }

  const configureFn = (next: LoaderOptions) => {
    const prev = state.options
    state.options = {
      adaptive: next.adaptive ?? prev.adaptive,
      batchMin: Math.max(2, Math.min(8, next.batchMin ?? prev.batchMin)),
      maxCacheKeys: next.maxCacheKeys ?? prev.maxCacheKeys,
      caching: next.caching ?? prev.caching,
      sampleEvery: next.sampleEvery ?? prev.sampleEvery,
      loadStrategy: next.loadStrategy ?? prev.loadStrategy,
    }
    // A config change invalidates learned thresholds; start fresh AND rebind
    // every memoized op fn so its dispatch/stats keep using the current ctx.
    state.ctxs.clear()
    for (const entry of state.opFns.values()) {
      entry.rebind(ctxFor(state, entry.op))
    }
    // Rebuild the cache if its capacity changed.
    if (next.maxCacheKeys !== undefined && next.maxCacheKeys !== prev.maxCacheKeys) {
      state.cache = createLruCache(state.options.maxCacheKeys)
    }
  }

  const statsGetter = (): LoaderStats => {
    let scalarCalls = 0
    let batchCalls = 0
    let itemsDispatched = 0
    let cachedHits = 0
    for (const ctx of state.ctxs.values()) {
      const c = ctx.counters
      scalarCalls += c.scalarCalls
      batchCalls += c.batchCalls
      itemsDispatched += c.itemsDispatched
      cachedHits += c.cachedHits
    }
    return {
      scalarCalls,
      batchCalls,
      itemsDispatched,
      flushes: state.flushes,
      cachedHits,
      cacheSize: state.cache.size,
      cacheEvictions: state.cache.evictions,
    }
  }

  const opNamesGetter = (): LoaderOpName[] => Object.keys(LOADER_OPS) as LoaderOpName[]

  // Bind a SchemaValidator: single/bulk validate through the loader's normal
  // dispatch machinery (shared cost model + counters), plus a whole-batch count.
  const schemaFn = (validator: SchemaValidator): LoaderSchemaFn => {
    const spec = LOADER_OPS.schemaValidate
    const ctx = ctxFor(state, 'schemaValidate')
    const fn = ((input: Uint8Array | Uint8Array[]) => {
      if (Array.isArray(input)) {
        return dispatchBulk(ctx, spec, input, [validator]) as Uint8Array
      }
      return dispatchSingle(ctx, spec, input, [validator]) as boolean
    }) as LoaderSchemaFn
    Object.defineProperty(fn, 'count', {
      value: (inputs: Uint8Array[]) => rust.batch.schemaValidateCount(validator, inputs),
      enumerable: true,
    })
    return fn
  }

  Object.defineProperties(loader, {
    run: { value: runFn, enumerable: true },
    load: { value: loadFn, enumerable: true },
    cache: { value: cacheFn, enumerable: true },
    schema: { value: schemaFn, enumerable: true },
    clear: { value: () => state.cache.clear(), enumerable: true },
    configure: { value: configureFn, enumerable: true },
    stats: { get: statsGetter, enumerable: true },
    opNames: { get: opNamesGetter, enumerable: true },
  })

  return loader
}

/**
 * The global, ready-to-use loader. Most consumers just do
 * `import { loader } from "castrum"` and either `loader("validateEmail")(…)`
 * (higher-order function) or `loader.run("validateEmail", …)`.
 */
export const loader = createLoader()

