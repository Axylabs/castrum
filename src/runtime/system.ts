// src/runtime/system.ts — OS, clock, and runtime promise adapters.

import { availableParallelism, cpus } from 'node:os'
import { isBunRuntime } from './detect'

const FALLBACK_CORES = 4

/** Resolve available CPU parallelism with a conservative fallback. */
export function hardwareConcurrency(): number {
  if (typeof availableParallelism === 'function') return availableParallelism()
  const count = cpus()?.length
  return count && count > 0 ? count : FALLBACK_CORES
}

/** High-resolution nanosecond clock for sampled adaptive-cost measurements. */
export const nowNs: () => number =
  typeof process !== 'undefined' && typeof process.hrtime === 'function'
    ? () => Number(process.hrtime.bigint())
    : () => performance.now() * 1e6

/** Return an already-settled promise's value on Bun; pass through elsewhere. */
export function peekPromise<T>(promise: Promise<T>): Promise<T> | T {
  return isBunRuntime() ? Bun.peek(promise) : promise
}
