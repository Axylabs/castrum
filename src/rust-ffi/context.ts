// src/rust-ffi/context.ts — Per-instance state + shared helpers for the Rust
// client namespaces.
//
// Each `createRust()` call builds one context holding its own caches, toggles
// and the lazily-initialized rayon-pool bookkeeping. The mutable pool state
// (initialized flag / pending thread count) stays encapsulated behind accessor
// functions so it cannot be corrupted externally.

import type { HmacSignerInstance } from '../native'
import type { BunFFI } from '../native/ffi'
import { runtimeNative } from '../runtime/native'
import type { NativeRuntimeAdapter, TransportAdapter } from '../runtime/types'
import { addon } from './addon'
import type { RustOptions } from './options'
import { normalizeExt, resolveRayonThreads } from './options'

// Module-level cache of resolved native fns. The native addon is a process
// singleton, so the resolved function is identical across all client contexts;
// caching it here lets scalar/packed/text wrappers skip the lazy-addon Proxy
// `get` trap (a branch + `Reflect.get`) on every call — the same pattern
// batch.ts uses for its packed entries.
const nativeFnCache = new Map<string, unknown>()

/**
 * Resolve a native op on first use and cache it for all subsequent calls —
 * FFI-FIRST via the runtime adapter's transport (`bun:ffi` on Bun, napi
 * fallback otherwise), so builders no longer repeat `getBunFFI()` inline.
 * Preserves the lazy-load contract (the addon is only loaded on the first
 * real native call) while removing per-call Proxy overhead.
 */
export function resolveNative(
  ctx: RustClientContext,
  name: string,
): (...args: unknown[]) => unknown {
  let f = nativeFnCache.get(name)
  if (f === undefined) {
    const fn = ctx.runtime.transport.resolve(name)
    f = fn ?? (ctx.addon as unknown as Record<string, unknown>)[name]
    nativeFnCache.set(name, f)
  }
  return f as (...args: unknown[]) => unknown
}

/**
 * Resolve a native fn and ensure the process-wide rayon pool is initialized
 * on first use — the rayon-backed `batch`/`packed` surfaces need this, while
 * `resolveNative` (plain scalars) must NOT init the pool so
 * `rust.configure({ rayonThreads })` can still take effect at startup.
 * Shares the SAME `nativeFnCache` as `resolveNative` (the batch fn names are
 * disjoint from the scalar names, so the shared cache is safe). FFI-first via
 * the runtime adapter's transport, like `resolveNative`.
 */
export function resolvePoolNative(
  ctx: RustClientContext,
  name: string,
): (...args: unknown[]) => unknown {
  let f = nativeFnCache.get(name)
  if (f === undefined) {
    ctx.ensurePool()
    const fn = ctx.runtime.transport.resolve(name)
    f = fn ?? (ctx.addon as unknown as Record<string, unknown>)[name]
    nativeFnCache.set(name, f)
  }
  return f as (...args: unknown[]) => unknown
}

/**
 * Lazy memoized `bun:ffi` resolver for the scalar builders.
 *
 * Returns a closure that resolves `transport.ffi` ONCE — on the first call —
 * and reads the local from then on. This keeps the FFI bind DEFERRED
 * (importing `rust` does not eagerly dlopen; the builder factories run at
 * module load) while removing the per-call `() => transport.ffi` getter hop
 * from the hot path. The transport's own cache already makes the steady-state
 * resolve a single `undefined`-check; this collapses the getter + inner
 * closure into one local read.
 */
export function memoizeFfi(transport: TransportAdapter): () => BunFFI | null {
  let resolved: BunFFI | null | undefined
  return () => {
    if (resolved === undefined) resolved = transport.ffi
    return resolved
  }
}

/** Shared per-instance state passed to the namespace/scalar builders. */
export interface RustClientContext {
  /** The shared lazy addon proxy (napi surface). */
  addon: typeof addon
  /** The runtime adapter seam (Bun/Node — builtins + ffi/napi transport). */
  runtime: NativeRuntimeAdapter
  /** Per-instance toggles (mime/hmac caching). */
  state: { mimeCache: boolean; hmacCache: boolean }
  mimeByText: Map<string, Uint8Array>
  hmacSigners: WeakMap<Uint8Array, HmacSignerInstance>

  /** Initialize the process-wide rayon pool exactly once (no-op after). */
  ensurePool(): void
  /** Whether the rayon pool state has been established on this instance. */
  isPoolInitialized(): boolean
  /** Record the caller's intent for the process-wide pool before it inits. */
  setPendingThreads(threads: number | undefined): void
  /** Mark the pool state as established (explicit initThreadPool calls). */
  markPoolInitialized(): void
  /** Cached MIME lookup (returns the cached bytes by reference — do not mutate). */
  cachedMime(ext: Uint8Array): Uint8Array
  /** Cached HMAC signer lookup. */
  hmacSigner(key: Uint8Array): HmacSignerInstance
}

/** Build a per-instance context from client options. */
export function createContext(options: RustOptions): RustClientContext {
  const mimeByText = new Map<string, Uint8Array>()
  const hmacSigners = new WeakMap<Uint8Array, HmacSignerInstance>()
  const state = {
    mimeCache: options.mimeCache !== false,
    hmacCache: options.hmacCache !== false,
  }

  // The native rayon pool is a process-wide OnceLock: the FIRST call wins.
  // We therefore defer init until the first batch/packed operation so that
  // rust.configure({ rayonThreads }) called at startup actually takes effect
  // (previously the pool was initialized eagerly at module load, silently
  // ignoring later rayonThreads tuning).
  let poolInitialized = false
  let pendingThreads = options.rayonThreads

  function ensurePool(): void {
    if (poolInitialized) return
    poolInitialized = true
    addon.initThreadPool(resolveRayonThreads(pendingThreads))
  }

  function isPoolInitialized(): boolean {
    return poolInitialized
  }

  function setPendingThreads(threads: number | undefined): void {
    pendingThreads = threads
  }

  function markPoolInitialized(): void {
    poolInitialized = true
  }

  function cachedMime(ext: Uint8Array): Uint8Array {
    if (!state.mimeCache) {
      return addon.mimeFromExtension(ext)
    }

    const key = normalizeExt(ext)

    let val = mimeByText.get(key)
    if (!val) {
      val = addon.mimeFromExtension(ext)
      mimeByText.set(key, val)
    }

    // Return the cached bytes BY REFERENCE (no per-call defensive copy — a
    // measurable win on the MIME parity op). The returned slice aliases the
    // cache: callers must NOT mutate it (same contract as `generateRequestId`).
    return val
  }

  function hmacSigner(key: Uint8Array): HmacSignerInstance {
    if (!state.hmacCache) {
      return new addon.HmacSigner(key)
    }

    let signer = hmacSigners.get(key)

    if (!signer) {
      signer = new addon.HmacSigner(key)
      hmacSigners.set(key, signer)
    }

    return signer
  }

  return {
    addon,
    runtime: runtimeNative,
    state,
    mimeByText,
    hmacSigners,
    ensurePool,
    isPoolInitialized,
    setPendingThreads,
    markPoolInitialized,
    cachedMime,
    hmacSigner,
  }
}
