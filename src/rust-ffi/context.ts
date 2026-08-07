// src/rust-ffi/context.ts — Per-instance state + shared helpers for the Rust
// client namespaces.
//
// Each `createRust()` call builds one context holding its own caches, toggles
// and the lazily-initialized rayon-pool bookkeeping. The mutable pool state
// (initialized flag / pending thread count) stays encapsulated behind accessor
// functions so it cannot be corrupted externally.

import { addon } from "./addon";
import { resolveRayonThreads } from "./options";
import { normalizeExt } from "./options";
import type { RustOptions } from "./options";
import type { HmacSignerInstance } from "../native";

/** Shared per-instance state passed to the namespace/scalar builders. */
export interface RustClientContext {
  /** The shared lazy addon proxy. */
  addon: typeof addon;
  /** Per-instance toggles (mime/hmac caching). */
  state: { mimeCache: boolean; hmacCache: boolean };
  mimeByText: Map<string, Uint8Array>;
  hmacSigners: WeakMap<Uint8Array, HmacSignerInstance>;

  /** Initialize the process-wide rayon pool exactly once (no-op after). */
  ensurePool(): void;
  /** Whether the rayon pool state has been established on this instance. */
  isPoolInitialized(): boolean;
  /** Record the caller's intent for the process-wide pool before it inits. */
  setPendingThreads(threads: number | undefined): void;
  /** Mark the pool state as established (explicit initThreadPool calls). */
  markPoolInitialized(): void;

  /** Wrap a rayon-backed object so pool init happens on first access. */
  withPoolInit<T extends object>(target: T): T;
  /** Cached MIME lookup (returns a defensive copy). */
  cachedMime(ext: Uint8Array): Uint8Array;
  /** Cached HMAC signer lookup. */
  hmacSigner(key: Uint8Array): HmacSignerInstance;
}

/** Build a per-instance context from client options. */
export function createContext(options: RustOptions): RustClientContext {
  const mimeByText = new Map<string, Uint8Array>();
  const hmacSigners = new WeakMap<Uint8Array, HmacSignerInstance>();
  const state = {
    mimeCache: options.mimeCache !== false,
    hmacCache: options.hmacCache !== false,
  };

  // The native rayon pool is a process-wide OnceLock: the FIRST call wins.
  // We therefore defer init until the first batch/packed operation so that
  // rust.configure({ rayonThreads }) called at startup actually takes effect
  // (previously the pool was initialized eagerly at module load, silently
  // ignoring later rayonThreads tuning).
  let poolInitialized = false;
  let pendingThreads = options.rayonThreads;

  function ensurePool(): void {
    if (poolInitialized) return;
    poolInitialized = true;
    addon.initThreadPool(resolveRayonThreads(pendingThreads));
  }

  function isPoolInitialized(): boolean {
    return poolInitialized;
  }

  function setPendingThreads(threads: number | undefined): void {
    pendingThreads = threads;
  }

  function markPoolInitialized(): void {
    poolInitialized = true;
  }

  // Any access to a rayon-backed namespace triggers pool init exactly once.
  function withPoolInit<T extends object>(target: T): T {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        ensurePool();
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  function cachedMime(ext: Uint8Array): Uint8Array {
    if (!state.mimeCache) {
      return addon.mimeFromExtension(ext);
    }

    const key = normalizeExt(ext);

    let val = mimeByText.get(key);
    if (!val) {
      val = addon.mimeFromExtension(ext);
      mimeByText.set(key, val);
    }

    // Return a copy so callers cannot mutate cached bytes.
    return val.slice();
  }

  function hmacSigner(key: Uint8Array): HmacSignerInstance {
    if (!state.hmacCache) {
      return new addon.HmacSigner(key);
    }

    let signer = hmacSigners.get(key);

    if (!signer) {
      signer = new addon.HmacSigner(key);
      hmacSigners.set(key, signer);
    }

    return signer;
  }

  return {
    addon,
    state,
    mimeByText,
    hmacSigners,
    ensurePool,
    isPoolInitialized,
    setPendingThreads,
    markPoolInitialized,
    withPoolInit,
    cachedMime,
    hmacSigner,
  };
}
