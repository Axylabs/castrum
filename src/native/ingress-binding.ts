// src/native/ingress-binding.ts — shared self-tested ingress transport for framework adapters.

import { type BunFFI, ffiAddonPath, getBunFFI } from './ffi'

/**
 * Synchronous ingress writers backed by castrum's process-lifetime FFI binding.
 * Handles MUST originate from addonPath and remain owned/alive while in use.
 * Writers throw on native failure; a return larger than output.byteLength is
 * the exact required capacity, not a completed write. No buffer is retained.
 */
export type IngressBinding = Pick<
  BunFFI,
  'ingressHandleComponents' | 'ingressHandlePacked' | 'ingressLayout'
> & { readonly addonPath: string }

let cached: IngressBinding | null | undefined

/**
 * Share castrum's self-tested ingress writers without a second dlopen/map.
 * @returns The binding and actual binary path, or null when FFI is unavailable.
 * @example
 * const binding = getIngressBinding()
 * // Verify binding.addonPath matches the addon that owns your ingress handle.
 */
export function getIngressBinding(): IngressBinding | null {
  if (cached !== undefined) return cached
  const ffi = getBunFFI()
  const addonPath = ffiAddonPath()
  cached =
    ffi && addonPath
      ? {
          addonPath,
          ingressHandleComponents: ffi.ingressHandleComponents,
          ingressHandlePacked: ffi.ingressHandlePacked,
          ingressLayout: ffi.ingressLayout,
        }
      : null
  return cached
}
