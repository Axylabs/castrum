// src/rust-ffi/scalar/payload.ts — Output / streaming scalar methods.
//
// Mirrors rust/payload/*: gzip/brotli compress, multipart parse, WebSocket
// frame codec and SSE event framing.
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): the Bun
// gzipCompress delegation comes from `builtins.has(op)` and the native call
// from `transport.ffi` / `transport.resolve` (bun:ffi first, napi fallback) —
// no inline `isBun()` / `getBunFFI()`.

import type { MultipartPart, WsFrame } from '../../native'
import { decoder } from '../../shared/bytes'
import { writeInto } from '../into'
import { memoizeFfi, type RustClientContext, resolveNative } from '../context'

/** Read an unsigned little-endian u32 at `off`. */
function u32LE(b: Uint8Array, off: number): number {
  return (
    ((b[off] ?? 0) |
      ((b[off + 1] ?? 0) << 8) |
      ((b[off + 2] ?? 0) << 16) |
      ((b[off + 3] ?? 0) << 24)) >>>
    0
  )
}

/**
 * Unpack the `parts_to_packed` layout (`[u32 count]{[u32 name_len][name]
 * [u8 has_filename][u32 filename_len][filename][u8 has_ct][u32 ct_len][ct]
 * [u32 data_len][data]}`) into the object shape. Slices `data` by copy so the
 * caller owns it (napi parity).
 */
function unpackMultipart(packed: Uint8Array): MultipartPart[] {
  const count = u32LE(packed, 0)
  let off = 4
  const out: MultipartPart[] = []
  for (let i = 0; i < count; i++) {
    const nameLen = u32LE(packed, off)
    off += 4
    const name = decoder.decode(packed.subarray(off, off + nameLen))
    off += nameLen
    const hasFilename = packed[off] ?? 0
    off += 1
    const filenameLen = u32LE(packed, off)
    off += 4
    const filename =
      hasFilename === 1 ? decoder.decode(packed.subarray(off, off + filenameLen)) : null
    off += filenameLen
    const hasCt = packed[off] ?? 0
    off += 1
    const ctLen = u32LE(packed, off)
    off += 4
    const contentType = hasCt === 1 ? decoder.decode(packed.subarray(off, off + ctLen)) : null
    off += ctLen
    const dataLen = u32LE(packed, off)
    off += 4
    const data = packed.subarray(off, off + dataLen).slice()
    off += dataLen
    out.push({ name, filename, contentType, data })
  }
  return out
}

/** Output / streaming scalar methods (`Pick<RustScalar, ...>`). */
export function buildPayload(ctx: RustClientContext) {
  const { addon } = ctx
  const { builtins, transport } = ctx.runtime
  // Hoist the immutable per-runtime builtin-delegation decision into a
  // bind-time flag (BUILTIN_OPS is a module constant — never mutated) so the
  // hot path reads a property instead of a `Set.has`.
  const HAS = { gzipCompress: builtins.has('gzipCompress') }
  // Lazy-memoized ffi surface: binds on first call, single local read after.
  const ffi = memoizeFfi(transport)

  return {
    gzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
      // Optimal by default under Bun: `Bun.gzipSync` (native zlib) is ~2x
      // faster than the rust+FFI crossing (decision matrix). Emits valid gzip
      // (decompression-parity with the addon — only the header OS byte
      // differs: 0xFF vs 0x03). `gzipCompressInto` (pooled) stays native.
      if (HAS.gzipCompress) return builtins.gzipCompress(data, level)
      const f = ffi()
      if (f) return f.gzipCompress(data, level ?? undefined)
      return addon.gzipCompress(data, level ?? null)
    },
    gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number | null): number {
      const f = ffi()
      if (f) return f.gzipCompressInto(data, output, level ?? undefined)
      return writeInto('gzip compress', output, addon.gzipCompress(data, level ?? null))
    },
    gzipDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array {
      const f = ffi()
      if (f) return f.gzipDecompress(data, maxDecompressed ?? undefined)
      return addon.gzipDecompress(data, maxDecompressed ?? null)
    },
    gzipDecompressInto(
      data: Uint8Array,
      output: Uint8Array,
      maxDecompressed?: number | null,
    ): number {
      // Pooled sibling — caller-owned output buffer (the C ABI streams into
      // it via the `_into` core; keeps the 64 MiB decompression-bomb cap).
      const f = ffi()
      if (f) return f.gzipDecompressInto(data, output, maxDecompressed ?? undefined)
      return writeInto('gzip decompress', output, addon.gzipDecompress(data, maxDecompressed ?? null))
    },
    brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array {
      const f = ffi()
      if (f) return f.brotliCompress(data, quality ?? undefined)
      return addon.brotliCompress(data, quality ?? null)
    },
    brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number | null): number {
      const f = ffi()
      if (f) return f.brotliCompressInto(data, output, quality ?? undefined)
      return writeInto('brotli compress', output, addon.brotliCompress(data, quality ?? null))
    },
    brotliDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array {
      const f = ffi()
      if (f) return f.brotliDecompress(data, maxDecompressed ?? undefined)
      return addon.brotliDecompress(data, maxDecompressed ?? null)
    },
    brotliDecompressInto(
      data: Uint8Array,
      output: Uint8Array,
      maxDecompressed?: number | null,
    ): number {
      // Pooled sibling — caller-owned output buffer (keeps the 64 MiB cap).
      const f = ffi()
      if (f) return f.brotliDecompressInto(data, output, maxDecompressed ?? undefined)
      return writeInto('brotli decompress', output, addon.brotliDecompress(data, maxDecompressed ?? null))
    },
    multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[] {
      // FFI-first: packed parts (castrum_multipart_parse_packed) → unpack to
      // the object shape. napi keeps its object path.
      const f = ffi()
      if (f) return unpackMultipart(f.multipartParsePacked(body, boundary))
      // Normalize napi `Option<String>` (undefined) → null and expose the
      // camelCase `contentType` key (napi renames `content_type` to camelCase).
      return addon.multipartParse(body, boundary).map((p) => ({
        name: p.name,
        filename: p.filename ?? null,
        contentType: p.contentType ?? null,
        data: p.data,
      }))
    },
    multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array {
      // Zero-copy packed sibling — no JS objects per part (see native types).
      return resolveNative(ctx, 'multipartParsePacked')(body, boundary) as Uint8Array
    },
    multipartParsePackedInto(body: Uint8Array, boundary: Uint8Array, output: Uint8Array): number {
      // Pooled sibling — caller-owned output buffer (the napi addon has no
      // packed `Into` for multipart, so copy via the allocating call there).
      const f = ffi()
      if (f) return f.multipartParsePackedInto(body, boundary, output)
      return writeInto('multipart parse', output, addon.multipartParsePacked(body, boundary))
    },
    wsFrameEncode(opcode: number, payload: Uint8Array, mask: boolean, fin: boolean): Uint8Array {
      return resolveNative(ctx, 'wsFrameEncode')(opcode, payload, mask, fin) as Uint8Array
    },
    wsFrameEncodeInto(
      opcode: number,
      payload: Uint8Array,
      mask: boolean,
      fin: boolean,
      output: Uint8Array,
    ): number {
      const f = ffi()
      if (f) return f.wsFrameEncodeInto(opcode, payload, mask, fin, output)
      return writeInto('ws frame encode', output, addon.wsFrameEncode(opcode, payload, mask, fin))
    },
    wsFrameDecode(data: Uint8Array): WsFrame | null {
      const f = ffi()
      if (f) {
        // C ABI returns packed [flags][opcode][u32 len][payload]; decode here.
        const packed = f.wsFrameDecodePacked(data)
        if (packed === null) return null
        const payloadLen =
          ((packed[2] ?? 0) |
            ((packed[3] ?? 0) << 8) |
            ((packed[4] ?? 0) << 16) |
            ((packed[5] ?? 0) << 24)) >>>
          0
        return {
          fin: (packed[0] ?? 0) === 1,
          opcode: packed[1] ?? 0,
          payload: packed.subarray(6, 6 + payloadLen),
        }
      }
      return addon.wsFrameDecode(data)
    },
    wsFrameDecodePackedInto(data: Uint8Array, output: Uint8Array): number | null {
      // Pooled sibling — caller-owned output buffer sized ≥ data.length + 6
      // (6-byte header + payload). null = malformed frame. The napi addon has
      // no packed decode, so that path re-packs the decoded object instead.
      const f = ffi()
      if (f) return f.wsFrameDecodePackedInto(data, output)
      const frame = addon.wsFrameDecode(data)
      if (frame === null) return null
      const need = 6 + frame.payload.length
      if (output.length < need) throw new Error('ws frame decode: output buffer too small')
      output[0] = frame.fin ? 1 : 0
      output[1] = frame.opcode
      output[2] = frame.payload.length & 0xff
      output[3] = (frame.payload.length >> 8) & 0xff
      output[4] = (frame.payload.length >> 16) & 0xff
      output[5] = (frame.payload.length >> 24) & 0xff
      output.set(frame.payload, 6)
      return need
    },
    sseEncodeEvent(
      event: string | null,
      data: Uint8Array,
      id: string | null,
      retry: number | null,
    ): Uint8Array {
      // FFI-first: the C-ABI `castrum_sse_encode_into` encodes directly into a
      // caller buffer (no napi crossing / String args). napi fallback mirrors
      // the Option semantics (null → line omitted).
      const f = ffi()
      if (f) return f.sseEncodeEvent(event, data, id, retry)
      return addon.sseEncodeEvent(event ?? null, data, id ?? null, retry ?? null)
    },
    sseEncodeEventInto(
      event: string | null,
      data: Uint8Array,
      id: string | null,
      retry: number | null,
      output: Uint8Array,
    ): number {
      // Pooled sibling — caller-owned output buffer (no per-call alloc). The
      // napi addon has no `_into` variant, so that path re-encodes into the
      // buffer via the allocating call.
      const f = ffi()
      if (f) return f.sseEncodeEventInto(event, data, id, retry, output)
      const bytes = addon.sseEncodeEvent(event ?? null, data, id ?? null, retry ?? null)
      if (output.length < bytes.length) throw new Error('sse encode: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
  }
}
