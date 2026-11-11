// src/runtime/detect.ts — one-time runtime detection (cached).
//
// The ONLY place `typeof Bun` is checked. The result is resolved ONCE at
// module load into a constant — hot paths never re-evaluate the detection,
// and `src/shared/runtime.ts` is a thin facade over this module so existing
// `isBun()` / `isNode()` call sites keep working unchanged.

import type { RuntimeName } from './types'

function detectRuntimeName(): RuntimeName {
  // Bun defines the global `Bun` object; Node does not.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun'
  if (typeof process !== 'undefined' && process.versions?.node != null) return 'node'
  return 'unknown'
}

/** The host runtime, resolved once at module load. */
export const detectedRuntime: RuntimeName = detectRuntimeName()

/** Whether the host runtime is Bun (equivalent to `detectedRuntime === "bun"`). */
export function isBunRuntime(): boolean {
  return detectedRuntime === 'bun'
}

/** Whether the host runtime is Node.js. */
export function isNodeRuntime(): boolean {
  return detectedRuntime === 'node'
}

/**
 * Whether `bun:ffi` can be required. Some Bun-hosted runners expose the runtime
 * version without installing the global `Bun` object; FFI remains available
 * there even though global-object built-ins must stay disabled.
 */
export function canUseBunFFI(): boolean {
  return (
    detectedRuntime === 'bun' ||
    (typeof process !== 'undefined' && typeof process.versions?.bun === 'string')
  )
}

/**
 * Request a synchronous full garbage collection when the host runtime exposes
 * one. On Bun this is `Bun.gc(true)`; on Node it is `globalThis.gc?.()`, which
 * is only defined when the process runs with `--expose-gc`. A no-op otherwise.
 */
export function forceGc(): void {
  if (detectedRuntime === 'bun') {
    Bun.gc(true)
    return
  }
  // Node only defines `globalThis.gc` under `--expose-gc`.
  ;(globalThis as { gc?: () => void }).gc?.()
}

/** The Node.js major version when running under Node, otherwise `null`. */
export function nodeMajorVersion(): number | null {
  if (detectedRuntime !== 'node') return null
  const v = process.versions.node
  const major = Number(v?.split('.')[0])
  return Number.isFinite(major) ? major : null
}
