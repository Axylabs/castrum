// src/runtime/codec.ts — runtime-native UTF-8 codec (Bun transfer, Node fallback).
//
// The UTF-8 codec branches (formerly in `src/shared/codec.ts`) are centralized
// here and selected ONCE at module load:
//   - encode:     shared `TextEncoder` singleton (Bun's native implementation
//     measures ~3x faster than the old `Bun.ArrayBufferSink` start/write/flush
//     path on Bun 1.4 — 34-50ns vs 188-215ns for small strings) vs `TextEncoder`
//     under Node.
//   - encodeInto: zero-copy `Buffer` view `.write` vs `TextEncoder.encodeInto`.
//   - decode:     `new CString(ptr, 0, len)` from `bun:ffi` vs `TextDecoder`.
//   - decodeFatal: replacement-mode (Bun) vs fatal `TextDecoder` (Node).
//
// `src/shared/codec.ts` re-exports these so existing callers are unchanged.
// This module must NOT import `src/native/ffi.ts` (it would create a cycle
// through the bind-time self-test) — the Bun decode lazily `require`s
// `bun:ffi` itself, and depends only on the detection leaf.

import { detectedRuntime } from './detect'
import type { RuntimeName, Utf8Codec } from './types'

// ── Lazy Node singletons ──────────────────────────────────────────
let nodeEncoder: TextEncoder | null = null
let nodeDecoder: TextDecoder | null = null
let nodeFatalDecoder: TextDecoder | null = null

function getNodeEncoder(): TextEncoder {
  if (nodeEncoder === null) nodeEncoder = new TextEncoder()
  return nodeEncoder
}

function getNodeDecoder(): TextDecoder {
  if (nodeDecoder === null) nodeDecoder = new TextDecoder()
  return nodeDecoder
}

function getNodeFatalDecoder(): TextDecoder {
  if (nodeFatalDecoder === null) nodeFatalDecoder = new TextDecoder('utf-8', { fatal: true })
  return nodeFatalDecoder
}

// ── Bun codec ─────────────────────────────────────────────────────
let bunFfiCodec: typeof import('bun:ffi') | null | undefined

function getBunFfiCodec(): typeof import('bun:ffi') | null {
  if (bunFfiCodec === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      bunFfiCodec = require('bun:ffi') as typeof import('bun:ffi')
    } catch {
      bunFfiCodec = null
    }
  }
  return bunFfiCodec
}

function createBunCodec(): Utf8Codec {
  const decodeUtf8Bun = (bytes: Uint8Array): string => {
    if (bytes.byteLength === 0) return ''
    const ffi = getBunFfiCodec()
    if (ffi) {
      return new ffi.CString(ffi.ptr(bytes), 0, bytes.byteLength).toString()
    }
    return getNodeDecoder().decode(bytes)
  }
  // Shared encoder singleton — Bun's native TextEncoder implementation
  // allocates the exact-size buffer in-engine; measured ~3x faster than the
  // previous ArrayBufferSink start/write/flush path on Bun 1.4 (see header).
  const bunEncoder = new TextEncoder()
  return {
    encodeUtf8(s: string): Uint8Array {
      return bunEncoder.encode(s)
    },
    encodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
      return bunEncodeUtf8Into(s, dest, offset)
    },
    decodeUtf8: decodeUtf8Bun,
    // Bun's CString is replacement-mode; strictness is enforced by the native
    // `castrum_utf8_valid` probe (callers check it first via the transport's
    // ffi surface). This fallback matches the historical behavior.
    decodeUtf8Fatal: decodeUtf8Bun,
    decodeUtf8Range: decodeUtf8RangeBun,
  }
}

// Cached zero-copy `Buffer` views keyed by the backing `ArrayBuffer`.
//
// `Buffer.write` requires a `Buffer` view; the historical implementation
// created one with `Buffer.from(backing, start, len)` on EVERY call — an
// object allocation on the hot path (the ingress packers encode the URL/IP
// twice per request through this function). Caching the full-backing view per
// `ArrayBuffer` (they are immutable-size in this codebase — the packers
// replace the whole buffer on growth, giving a fresh `ArrayBuffer` key) turns
// the per-call `Buffer.from` into a WeakMap hit.
const bunEncodeViewCache = new WeakMap<ArrayBufferLike, Buffer>()

/**
 * Write `s` (UTF-8) into `dest` starting at `offset` and return bytes written.
 *
 * Fast path (the hot callers — the ingress input/header packers — pass `dest`
 * as a subarray that extends to the END of its backing buffer): reuse the
 * cached full-backing `Buffer` view and write at the absolute position — the
 * write bound is then identical to the historical `Buffer.from(backing, start,
 * len)` behaviour, so no bytes outside `dest` can be touched.
 *
 * When `dest` does NOT extend to the end of its backing (a mid-buffer slice),
 * fall back to a bounded `subarray` so the truncation semantics match the
 * original `Buffer.from(backing, start, len)` exactly.
 */
function bunEncodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
  const backing = dest.buffer
  let view = bunEncodeViewCache.get(backing)
  if (view === undefined || view.byteLength !== backing.byteLength) {
    view = Buffer.from(backing)
    bunEncodeViewCache.set(backing, view)
  }
  const start = dest.byteOffset + offset
  if (dest.byteOffset + dest.byteLength !== backing.byteLength) {
    // Non-suffix dest: bound the write to `dest` exactly (historical semantics).
    return view.subarray(start, start + dest.byteLength - offset).write(s, 0, 'utf8')
  }
  return view.write(s, start, 'utf8')
}

// Shared cached full-backing view for the ranged DECODE fast path (same
// WeakMap pattern as the encode views above — one Buffer per ArrayBuffer,
// never per call).
const bunDecodeViewCache = new WeakMap<ArrayBufferLike, Buffer>()

function bunDecodeView(bytes: Uint8Array): Buffer {
  const backing = bytes.buffer
  let view = bunDecodeViewCache.get(backing)
  if (view === undefined || view.byteLength !== backing.byteLength) {
    view = Buffer.from(backing)
    bunDecodeViewCache.set(backing, view)
  }
  return view
}

/**
 * Ranged decode: ASCII-only ranges take the latin1 `toString` path (JSC
 * builds the string without the UTF-8 decoder machinery — measured ~2x the
 * CString path on Bun 1.4); any high byte falls back to a real UTF-8 decode
 * of exactly that range. Replacement-mode parity with `decodeUtf8` holds for
 * both branches (latin1 is byte-identical to UTF-8 when no byte exceeds 0x7F).
 */
function decodeUtf8RangeBun(bytes: Uint8Array, start: number, end: number): string {
  const view = bunDecodeView(bytes)
  const base = bytes.byteOffset
  for (let i = start; i < end; i++) {
    if ((bytes[i] ?? 0) >= 0x80) {
      return view.toString('utf8', base + start, base + end)
    }
  }
  return view.toString('latin1', base + start, base + end)
}

// ── Node codec ────────────────────────────────────────────────────
function createNodeCodec(): Utf8Codec {
  return {
    encodeUtf8(s: string): Uint8Array {
      return getNodeEncoder().encode(s)
    },
    encodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
      return getNodeEncoder().encodeInto(s, dest.subarray(offset)).written
    },
    decodeUtf8(bytes: Uint8Array): string {
      return getNodeDecoder().decode(bytes)
    },
    decodeUtf8Fatal(bytes: Uint8Array): string {
      return getNodeFatalDecoder().decode(bytes)
    },
    decodeUtf8Range(bytes: Uint8Array, start: number, end: number): string {
      // Node: ranged Buffer toString with the same ASCII fast path.
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let i = start; i < end; i++) {
        if ((bytes[i] ?? 0) >= 0x80) {
          return view.toString('utf8', start, end)
        }
      }
      return view.toString('latin1', start, end)
    },
  }
}

/** Build the codec for a runtime (used by `createRuntimeAdapter` / tests). */
export function createCodec(name: RuntimeName): Utf8Codec {
  return name === 'bun' ? createBunCodec() : createNodeCodec()
}

/** The shared codec for the detected runtime (selected once at load). */
export const runtimeCodec: Utf8Codec = createCodec(detectedRuntime)
