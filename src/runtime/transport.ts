// src/runtime/transport.ts — native transport adapter (bun:ffi primary, napi fallback).
//
// The SAME cdylib is reached two ways: the bun:ffi C-ABI transport
// (`getBunFFI()`, PRIMARY under Bun — ~10-20ns crossing) and the napi addon
// (`addon`, Node / forced `CASTRUM_FFI_MODE=napi` / failed ffi self-test).
// Historically every scalar builder repeated `const ffi = getBunFFI();
// if (ffi) return ffi.X(...); return addon.X(...)`. This adapter centralizes
// that selection: `resolve(op)` returns the bound op (ffi-first, cached,
// napi fallback), and the raw `ffi` / `napi` surfaces are exposed for the few
// ops with transport-specific JS handling (jsonParse packed path, urlDecode
// UTF-8 probe, packed unboxers).
//
// LAZY: the one-time ffi bind is deferred until the first `resolve` /
// introspection, so importing the adapter does not eagerly dlopen.

import type { BunFFI } from '../native/ffi'
import { getBunFFI } from '../native/ffi'
import { addon } from '../rust-ffi/addon'
import type { NativeCallable, TransportAdapter } from './types'

export function createTransport(): TransportAdapter {
  let cachedFfi: BunFFI | null | undefined // undefined = not yet attempted
  const getFfi = (): BunFFI | null => {
    if (cachedFfi === undefined) cachedFfi = getBunFFI()
    return cachedFfi
  }
  const cache = new Map<string, NativeCallable>()

  const resolve = (op: string): NativeCallable | undefined => {
    let f = cache.get(op)
    if (f === undefined) {
      const ffiSurface = getFfi() as unknown as Record<string, unknown> | null
      const candidate =
        ffiSurface && typeof ffiSurface[op] === 'function'
          ? (ffiSurface[op] as NativeCallable)
          : (addon as unknown as Record<string, unknown>)[op]
      if (typeof candidate !== 'function') return undefined
      f = candidate as NativeCallable
      cache.set(op, f)
    }
    return f
  }

  return {
    get name(): 'ffi' | 'napi' {
      return getFfi() !== null ? 'ffi' : 'napi'
    },
    get returnType(): 'string' | 'bytes' {
      return getFfi() !== null ? 'string' : 'bytes'
    },
    get ffi(): BunFFI | null {
      return getFfi()
    },
    napi: addon,
    ffiActive: () => getFfi() !== null,
    resolve,
  }
}
