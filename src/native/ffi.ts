// src/native/ffi.ts — Bun-only C-ABI fast path via `bun:ffi` (transport core).
//
// Bun JIT-compiles `bun:ffi` calls down to direct native calls (~10-20ns
// crossing), versus ~100-350ns for a Node-API call. The same cdylib that Node
// loads through napi-rs ALSO exports `extern "C"` symbols (`rust/ffi/`), so
// under Bun we can `dlopen` it and call the hot scalar functions directly.
//
// Structure: this file is the transport CORE (transport selection + probe +
// dlopen + symbol binding + bind-time self-test gating). The per-call wrapper
// surface lives in `build.ts` (delegating to `build/{codecs,compress,parse,
// instances}.ts`), and the pure pieces beside it: `ffi/types.ts` (BunFFI /
// FfiMode / Raw signatures), `ffi/constants.ts` (caps + sizing + self-test
// vectors), `ffi/selftest.ts` (the bind-time self-test). This file re-exports
// `getBunFFI` + `BunFFI` so existing importers keep working unchanged.
//
// Safety / correctness strategy:
//   - Lazily bound (no addon/ffi work until first use).
//   - A one-time SELF-TEST runs at bind time (ffi/selftest.ts); any failure
//     disables ffi and falls back to the napi addon.
//   - Decoders that can fail ARE exposed with parity error semantics: a `0`
//     write on non-empty input throws (the napi decoders throw rather than
//     return a short buffer).
//   - Never called under Node (falls back to napi immediately).
//
// Buffer ABI: input/out pointers are `(ptr, len)` pairs; the JS wrapper passes
// `(view, view.length)` and bun:ffi converts the TypedArray to its pointer.

import type { FFITypeOrString } from 'bun:ffi'
import { buildFFISymbolMap } from './ffi/symbols'
import { resolveEnvVar } from '../shared/env'
import { isBun } from '../shared/runtime'
import { build } from './ffi/build'
import { selfTest } from './ffi/selftest'
import type { BunFFI, FfiMode } from './ffi/types'
// Static import: loader.ts has no side effects (path resolution only — no
// dlopen), so this adds zero import-time cost while letting `bind()` reuse the
// exact same resolved `.node` path the napi fallback uses (the shared seam).
import { getAddonPath, getAddonPathCandidates } from './loader'

// Re-export the type surface so `import type { BunFFI } from '../native/ffi'`
// keeps working (existing call sites).
export type { BunFFI, FfiMode } from './ffi/types'

let cached: BunFFI | null | undefined
/**
 * Resolved buffer ABI mode, set once by `bind()`. `null` = ffi unavailable
 * (Node / `CASTRUM_FFI_MODE=napi` / failed self-test), `'buffer-pair'` = the
 * engine-native `buffer`/`buffer_length` pair is live, `'ptr-len'` = the
 * explicit `(ptr, usize)` fallback.
 */
let bufferAbiMode: 'buffer-pair' | 'ptr-len' | null = null

/**
 * The addon file the live `bun:ffi` binding was opened from, or `null` while
 * unbound. Diagnostics only — a v3→baseline fallback is visible here.
 */
let boundAddonPath: string | null = null

// ── Transport selection (CASTRUM_FFI_MODE) ───────────────────────

function resolveFfiMode(): FfiMode {
  const raw = resolveEnvVar('CASTRUM_FFI_MODE')
  switch (raw) {
    case 'ffi':
      return 'ffi'
    case 'napi':
      return 'napi'
    default:
      return 'auto'
  }
}

/**
 * Lazily bind the Bun ffi fast path, or return `null` when unavailable
 * (Node, `CASTRUM_FFI_MODE=napi`, missing symbols, or a failed self-test).
 * `undefined` caches "not yet attempted".
 *
 * Under `CASTRUM_FFI_MODE=ffi` a bind/self-test failure THROWS instead of
 * returning null — the caller asked for the primary transport explicitly.
 */
export function getBunFFI(): BunFFI | null {
  if (cached !== undefined) {
    return cached
  }
  cached = bind()
  return cached
}

/**
 * Which buffer ABI the live `bun:ffi` binding uses, or `null` when the
 * transport is unavailable (Node, `CASTRUM_FFI_MODE=napi`, or a failed
 * self-test). `'buffer-pair'` = the engine-native `buffer`/`buffer_length`
 * pair (atomic ptr+byteLength snapshot) is in use; `'ptr-len'` = the explicit
 * `(ptr, usize)` fallback (older Bun / probe failure). Lazy — triggers the
 * same one-time bind as {@link getBunFFI}. Under `CASTRUM_FFI_MODE=ffi` on Bun
 * this is guaranteed non-null; a bind/self-test failure THROWS, matching
 * `getBunFFI`.
 */
export function ffiBufferMode(): 'buffer-pair' | 'ptr-len' | null {
  if (cached === undefined) {
    getBunFFI()
  }
  return bufferAbiMode
}

/**
 * The addon file path the live `bun:ffi` binding was opened from, or `null`
 * when the transport is unavailable (Node, `CASTRUM_FFI_MODE=napi`, or every
 * candidate failed). Lazy — triggers the same one-time bind as
 * {@link getBunFFI}. Use it to confirm WHICH artifact bound, e.g. when a stale
 * v3 SIMD binary forced the baseline fallback.
 */
export function ffiAddonPath(): string | null {
  if (cached === undefined) {
    getBunFFI()
  }
  return boundAddonPath
}

/**
 * Probe whether this Bun build accepts the `buffer`/`buffer_length` ABI pair in
 * `dlopen`. Bun's docs list `buffer_length` as engine-native (dlopen-supported),
 * but an earlier canary threw "invalid ABI type" for it. If that regressed (or
 * a future Bun removes it), we silently keep explicit `(ptr, len)` pairs. The
 * full bind-time self-test is the safety net either way.
 */
function probeBufferLength(dlopen: typeof import('bun:ffi')['dlopen'], path: string): boolean {
  try {
    const { symbols, close } = dlopen(path, {
      // bun-types lacks the `buffer_length` literal — cast it; runtime support
      // is exactly what this probe is verifying.
      castrum_crc32: {
        args: ['buffer', 'buffer_length'] as unknown as readonly FFITypeOrString[],
        returns: 'u32',
      },
    })
    // `buffer_length` is `buffer`'s length twin — pass the SAME view twice
    // (the engine reads ptr + byteLength off that object at call time).
    const view = new Uint8Array([1, 2, 3])
    const out = (symbols as Record<string, (a: unknown, b: unknown) => unknown>).castrum_crc32?.(
      view,
      view,
    )
    close()
    return typeof out === 'number' && out >= 0
  } catch {
    return false
  }
}

function bind(forcedPath?: string, tried: string[] = []): BunFFI | null {
  bufferAbiMode = null // reset — the mode below is only valid for a live bind
  const mode = resolveFfiMode()
  if (!isBun()) {
    if (mode === 'ffi') {
      throw new Error(
        'CASTRUM_FFI_MODE=ffi is invalid here: bun:ffi is a Bun-only transport ' +
          '(this process is not Bun). Use CASTRUM_FFI_MODE=auto (default) so Node ' +
          'uses the napi fallback.',
      )
    }
    return null
  }
  if (mode === 'napi') {
    return null
  }
  // Resolve the SAME addon file napi uses (./loader.ts — statically imported
  // above; it only resolves the path, it never dlopens the addon). On a retry,
  // `forcedPath` is the next candidate from `getAddonPathCandidates()`.
  const path = forcedPath ?? getAddonPath()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen } = require('bun:ffi') as typeof import('bun:ffi')

    // Probe `buffer`/`buffer_length` (the engine reads ptr + len off the SAME
    // TypedArray at call time — an atomic snapshot) once; when supported we use
    // it for the input-only hot fns (one JS arg instead of two), else `(ptr,len)`.
    const useBufferLength = probeBufferLength(dlopen, path)
    bufferAbiMode = useBufferLength ? 'buffer-pair' : 'ptr-len'

    const { symbols } = dlopen(path, buildFFISymbolMap(useBufferLength))

    // (`as unknown as`: the zero-arg `castrum_metrics_create` infers
    // `(...args: never[])`, which can't overlap `(...a: unknown[])` directly.)
    const bindings = build(
      symbols as unknown as Record<string, (...a: unknown[]) => unknown>,
      useBufferLength,
    )
    if (!selfTest(bindings)) {
      throw new Error(`bun:ffi bind-time self-test failed on ${path}`)
    }
    boundAddonPath = path
    return bindings
  } catch (err) {
    bufferAbiMode = null
    // The preferred artifact failed to dlopen/bind/self-test. The common cause
    // is a STALE v3 SIMD binary (`castrum.linux-x64-v3-gnu.node`) that predates
    // a newly added `castrum_*` symbol: dlopen fails, and without this walk the
    // whole FFI transport would be disabled (every call silently downgraded to
    // napi, and the task runtime silently made synchronous). Try the remaining
    // existing candidates — the baseline binary — before giving up.
    for (const next of getAddonPathCandidates()) {
      if (next === path || tried.includes(next)) continue
      const bound = bind(next, [...tried, path])
      if (bound) return bound
    }
    if (mode === 'ffi') {
      const cause = err instanceof Error ? `: ${err.message}` : ''
      throw new Error(
        `CASTRUM_FFI_MODE=ffi: failed to bind bun:ffi${cause} ` +
          `(tried: ${[...tried, path].join(', ')})`,
      )
    }
    return null
  }
}
