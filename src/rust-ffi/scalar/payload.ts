// src/rust-ffi/scalar/payload.ts — Output / streaming scalar methods.
//
// Mirrors rust/payload/*: gzip/brotli compress, multipart parse, WebSocket
// frame codec and SSE event framing.

import type { MultipartPart, WsFrame } from '../../native'
import { getBunFFI } from '../../native/ffi'
import { decoder } from '../../shared/bytes'
import { isBun } from '../../shared/runtime'
import type { RustClientContext } from '../context'

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

  return {
    gzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
      // Optimal by default under Bun: `Bun.gzipSync` (native zlib) is ~2x
      // faster than the rust+FFI crossing (decision matrix). Emits valid gzip
      // (decompression-parity with the addon — only the header OS byte
      // differs: 0xFF vs 0x03). `gzipCompressInto` (pooled) stays native.
      if (isBun()) {
        const opts = level != null ? ({ level } as Parameters<typeof Bun.gzipSync>[1]) : undefined
        return Bun.gzipSync(data as unknown as Uint8Array<ArrayBuffer>, opts)
      }
      const ffi = getBunFFI()
      if (ffi) return ffi.gzipCompress(data, level ?? undefined)
      return addon.gzipCompress(data, level ?? null)
    },
    gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number | null): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.gzipCompressInto(data, output, level ?? undefined)
      const bytes = addon.gzipCompress(data, level ?? null)
      if (output.length < bytes.length) throw new Error('gzip compress: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    gzipDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.gzipDecompress(data, maxDecompressed ?? undefined)
      return addon.gzipDecompress(data, maxDecompressed ?? null)
    },
    brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.brotliCompress(data, quality ?? undefined)
      return addon.brotliCompress(data, quality ?? null)
    },
    brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number | null): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.brotliCompressInto(data, output, quality ?? undefined)
      const bytes = addon.brotliCompress(data, quality ?? null)
      if (output.length < bytes.length) throw new Error('brotli compress: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    brotliDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.brotliDecompress(data, maxDecompressed ?? undefined)
      return addon.brotliDecompress(data, maxDecompressed ?? null)
    },
    multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[] {
      // FFI-first: packed parts (castrum_multipart_parse_packed) → unpack to
      // the object shape. napi keeps its object path.
      const ffi = getBunFFI()
      if (ffi) return unpackMultipart(ffi.multipartParsePacked(body, boundary))
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
      const ffi = getBunFFI()
      if (ffi) return ffi.multipartParsePacked(body, boundary)
      // Zero-copy packed sibling — no JS objects per part (see native types).
      return addon.multipartParsePacked(body, boundary)
    },
    multipartParsePackedInto(body: Uint8Array, boundary: Uint8Array, output: Uint8Array): number {
      // Pooled sibling — caller-owned output buffer (the napi addon has no
      // packed `Into` for multipart, so copy via the allocating call there).
      const ffi = getBunFFI()
      if (ffi) return ffi.multipartParsePackedInto(body, boundary, output)
      const bytes = addon.multipartParsePacked(body, boundary)
      if (output.length < bytes.length) throw new Error('multipart parse: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    wsFrameEncode(opcode: number, payload: Uint8Array, mask: boolean, fin: boolean): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.wsFrameEncode(opcode, payload, mask, fin)
      return addon.wsFrameEncode(opcode, payload, mask, fin)
    },
    wsFrameEncodeInto(
      opcode: number,
      payload: Uint8Array,
      mask: boolean,
      fin: boolean,
      output: Uint8Array,
    ): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.wsFrameEncodeInto(opcode, payload, mask, fin, output)
      const bytes = addon.wsFrameEncode(opcode, payload, mask, fin)
      if (output.length < bytes.length) throw new Error('ws frame encode: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    wsFrameDecode(data: Uint8Array): WsFrame | null {
      const ffi = getBunFFI()
      if (ffi) {
        // C ABI returns packed [flags][opcode][u32 len][payload]; decode here.
        const packed = ffi.wsFrameDecodePacked(data)
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
      const ffi = getBunFFI()
      if (ffi) return ffi.wsFrameDecodePackedInto(data, output)
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
      const ffi = getBunFFI()
      if (ffi) return ffi.sseEncodeEvent(event, data, id, retry)
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
      const ffi = getBunFFI()
      if (ffi) return ffi.sseEncodeEventInto(event, data, id, retry, output)
      const bytes = addon.sseEncodeEvent(event ?? null, data, id ?? null, retry ?? null)
      if (output.length < bytes.length) throw new Error('sse encode: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
  }
}
