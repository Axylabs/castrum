// src/rust-ffi/options.ts — Client options + input-normalization helpers.
//
// Holds the `RustOptions` contract, the rayon thread-count resolution, and the
// small coercion helpers (bigint/number/ext normalization) used across the FFI
// namespaces.

import { availableParallelism, cpus } from 'node:os'
import { decoder } from '../shared/bytes'
import { resolveEnvVar } from '../shared/env'

/** Options accepted by `createRust` / `rust.configure`. */
export interface RustOptions {
  /**
   * Rayon thread pool size.
   *
   * The rayon pool is process-wide and initialized **once** (native
   * `OnceLock`) — the first initialization wins. Importing this module
   * initializes the pool with defaults, so this option only takes effect when
   * the pool has not yet been created. For reliable control set
   * `CASTRUM_RAYON_THREADS` / `RUST_RAYON_THREADS` before import.
   * Default: max(1, hardwareConcurrency - 1).
   */
  rayonThreads?: number
  /** Cache MIME lookups keyed by normalized extension. Default: true. */
  mimeCache?: boolean
  /** Reuse HMAC signers keyed by key-buffer identity. Default: true. */
  hmacCache?: boolean
}

const FALLBACK_CORES = 4

/**
 * Resolve the CPU count without relying on `navigator.hardwareConcurrency`,
 * which throws a ReferenceError under Node.js < 21. `os.availableParallelism`
 * exists in Bun and Node >= 18.14; older Node falls back to `os.cpus().length`.
 */
function hardwareConcurrency(): number {
  if (typeof availableParallelism === 'function') {
    return availableParallelism()
  }
  const count = cpus()?.length
  return count && count > 0 ? count : FALLBACK_CORES
}

/** Resolve the effective rayon thread count from explicit/env/default. */
export function resolveRayonThreads(explicit?: number): number {
  const cores = hardwareConcurrency()

  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(cores, Math.floor(explicit)))
  }

  const envThreads = Number(
    resolveEnvVar('CASTRUM_RAYON_THREADS', ['RUST_BENCH_RAYON_THREADS', 'RUST_RAYON_THREADS']),
  )

  if (Number.isFinite(envThreads) && envThreads > 0) {
    return Math.max(1, Math.min(cores, Math.floor(envThreads)))
  }

  return Math.max(1, cores - 1)
}

/** Coerce a value to bigint (accepts bigint/number/string). */
export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return BigInt(value)
  }

  throw new TypeError(`Expected bigint-compatible value, got ${typeof value}: ${String(value)}`)
}

/** Coerce a value to number (accepts number/bigint/string). */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return Number(value)
  }

  return 0
}

/** Normalize a file-extension byte slice to a lowercase string w/o a dot. */
export function normalizeExt(ext: Uint8Array): string {
  let s: string

  try {
    s = decoder.decode(ext)
  } catch {
    return ''
  }

  if (s.charCodeAt(0) === 46) {
    s = s.slice(1)
  }

  return s.toLowerCase()
}
