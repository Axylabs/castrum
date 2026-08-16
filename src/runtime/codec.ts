// src/runtime/codec.ts — runtime-native UTF-8 codec (Bun transfer, Node fallback).
//
// The UTF-8 codec branches (formerly in `src/shared/codec.ts`) are centralized
// here and selected ONCE at module load:
//   - encode:     Bun `Bun.ArrayBufferSink` vs `TextEncoder`.
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
let bunSink: Bun.ArrayBufferSink | null = null
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
  return {
    encodeUtf8(s: string): Uint8Array {
      if (bunSink === null) bunSink = new Bun.ArrayBufferSink()
      const sink = bunSink
      // `stream` resets the buffer on flush (reusable singleton); `flush()`
      // returns the written data as a `Uint8Array`.
      sink.start({ asUint8Array: true, stream: true })
      sink.write(s)
      return sink.flush() as Uint8Array
    },
    encodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
      return bunEncodeUtf8Into(s, dest, offset)
    },
    decodeUtf8: decodeUtf8Bun,
    // Bun's CString is replacement-mode; strictness is enforced by the native
    // `castrum_utf8_valid` probe (callers check it first via the transport's
    // ffi surface). This fallback matches the historical behavior.
    decodeUtf8Fatal: decodeUtf8Bun,
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
  }
}

/** Build the codec for a runtime (used by `createRuntimeAdapter` / tests). */
export function createCodec(name: RuntimeName): Utf8Codec {
  return name === 'bun' ? createBunCodec() : createNodeCodec()
}

/** The shared codec for the detected runtime (selected once at load). */
export const runtimeCodec: Utf8Codec = createCodec(detectedRuntime)
