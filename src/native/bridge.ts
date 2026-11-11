// src/native/bridge.ts — configured native transport bridge for framework adapters.

import { bindBunFFI, type BunFFIBindOptions } from './ffi'
import type { BunFFI, FfiMode } from './ffi/types'
import { getAddonPath, loadAddon } from './loader'
import type { NativeAddon } from './types'

/** Configuration for one native addon and its optional C-ABI transport. */
export interface NativeBridgeOptions {
  /** Explicit addon binary. Defaults to castrum's package/binary detection. */
  addonPath?: string
  /** C-ABI selection. Defaults to automatic FFI with NAPI fallback. */
  ffiMode?: FfiMode
}

/** One addon and C-ABI surface bound to the SAME binary. */
export interface NativeBridge {
  /** Node-API module used for stateful instances and the Node fallback. */
  readonly addon: NativeAddon
  /** Binary that owns both transports and every opaque handle. */
  readonly addonPath: string
  /** Forced-FFI bind failure, retained so the framework can report it lazily. */
  readonly ffiError: Error | null
  /** Lazily bind and return the self-tested C-ABI surface. */
  getFfi(): BunFFI | null
}

/**
 * Create a native bridge with no process-global transport state.
 *
 * The C-ABI binder is restricted to the NAPI addon's exact binary so opaque
 * handles can never cross baseline/SIMD or independently configured builds.
 * NAPI loading happens once here; FFI binding stays lazy until `getFfi()`.
 */
export function createNativeBridge(options: NativeBridgeOptions = {}): NativeBridge {
  const addonPath = options.addonPath ?? getAddonPath()
  const addon = loadAddon(addonPath)
  const bindOptions: BunFFIBindOptions = {
    addonPath,
    candidates: [addonPath],
    mode: options.ffiMode ?? 'auto',
  }
  let cached: BunFFI | null | undefined
  let ffiError: Error | null = null
  return {
    addon,
    addonPath,
    get ffiError() {
      return ffiError
    },
    getFfi() {
      if (cached === undefined) {
        try {
          cached = bindBunFFI(bindOptions)
        } catch (error) {
          cached = null
          ffiError = error instanceof Error ? error : new Error(String(error))
        }
      }
      return cached
    },
  }
}
