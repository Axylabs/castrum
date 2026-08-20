// src/native/ffi/build.ts — the `build()` orchestrator for the BunFFI surface.
//
// `build(sym, useBufferLength)` sets up the shared per-bind state — the
// probe-gated `lenOrView`/`oneArg` argument adapters and the pooled scratch
// buffers — then delegates to the four domain builders (each receives the raw
// dlopen'd symbols + this context) and merges their method objects into the
// final `BunFFI`. Extracted from the former monolithic `ffi.ts` so the
// per-call wrapper surface is navigable by domain:
//   - `build/codecs.ts`     hashing / codec / crypto / auth / ws-key / etag
//   - `build/compress.ts`   gzip / brotli / json patch
//   - `build/parse.ts`      packed parsers / media-type / http-date / sse
//   - `build/instances.ts`  opaque-handle evals + ingress + route stack

import { buildCodecs } from './build/codecs'
import { buildCompress } from './build/compress'
import { buildInstances } from './build/instances'
import { buildParse } from './build/parse'
import type { BuildCtx } from './build/util'
import type { BunFFI } from './types'

/**
 * Assemble the `BunFFI` surface from the raw dlopen'd symbols.
 *
 * @param sym             The `symbols` object from `dlopen(path, {...})`.
 * @param useBufferLength `true` when the engine's `buffer`/`buffer_length`
 *                        ABI pair is live (see the probe in `ffi.ts`).
 */
export function build(
  sym: Record<string, (...a: unknown[]) => unknown>,
  useBufferLength: boolean,
): BunFFI {
  // Single-buffer input fns: with the probe-gated `buffer/buffer_length` ABI the
  // engine reads ptr + byteLength off the SAME TypedArray at call time (an
  // atomic snapshot — pass the view twice, per Bun's docs); with `(ptr,len)` we
  // pass the length explicitly. The branch is on a bind-time constant, so the
  // JIT folds it away at the call site.
  const oneArg = (raw: (...a: unknown[]) => number | bigint, v: Uint8Array): number | bigint =>
    useBufferLength ? raw(v, v) : raw(v, v.length)
  // Phase 1.1: under `buffer`/`buffer_length` the engine reads ptr + byteLength
  // off the SAME view, so every `(ptr,len)` pair passes the view itself for the
  // length slot (atomic snapshot, one JS arg fewer); under `(ptr,usize)` it's
  // the explicit length. The branch is a bind-time constant → JIT folds it.
  const lenOrView = (v: Uint8Array): Uint8Array | number => (useBufferLength ? v : v.length)

  // ── Reusable scratch for the STRING-returning encode wrappers ────────
  // Each wrapper writes its result and decodes it into an immutable JS string
  // (or primitive) SYNCHRONOUSLY before the next call reuses the buffer — the
  // same safety rationale as `jsonSumOut` / `generateRequestId`. Per-Worker
  // module state (single-threaded event loop); never shared across Workers.
  // NOT used for byte-returning ops (hexDecode/urlDecode/base64Decode/aead/
  // wsFrame/packed parsers): their returned `Uint8Array` aliases the buffer
  // and escapes to the caller — those stay on `*Into` (caller-owned).
  let encodeScratch = new Uint8Array(0)
  const scratchFor = (size: number): Uint8Array => {
    if (encodeScratch.byteLength < size) encodeScratch = new Uint8Array(size)
    return encodeScratch
  }
  // Pooled 9-byte scratch for jsonSumIds (the packed `[u8 ok][i64 sum LE]`
  // output). The wrapper returns the BigInt VALUE (no byte aliasing escapes),
  // so a single reused buffer + cached DataView is safe — removes the per-call
  // Uint8Array + DataView allocs (measured ~400ns of the FFI wrapper cost).
  const jsonSumOut = new Uint8Array(9)
  const jsonSumView = new DataView(jsonSumOut.buffer)
  // Fixed-size packed-verdict scratch + cached DataViews (parseHttpDate 9 B,
  // rate-limit check 13 B) — same pooled pattern as `jsonSumView`. Kept
  // separate from the growable `encodeScratch` so the cached DataViews are
  // never invalidated by a buffer replacement.
  const dateScratch = new Uint8Array(9)
  const dateScratchView = new DataView(dateScratch.buffer)
  const rateScratch = new Uint8Array(13)
  const rateScratchView = new DataView(rateScratch.buffer)

  const ctx: BuildCtx = {
    useBufferLength,
    lenOrView,
    oneArg,
    scratchFor,
    jsonSumOut,
    jsonSumView,
    dateScratch,
    dateScratchView,
    rateScratch,
    rateScratchView,
  }

  // Merge the domain surfaces. Each builder's method bodies are verbatim from
  // the original single return object; the cast asserts the merged shape.
  return {
    ...buildCodecs(sym, ctx),
    ...buildCompress(sym, ctx),
    ...buildParse(sym, ctx),
    ...buildInstances(sym, ctx),
  } as BunFFI
}
