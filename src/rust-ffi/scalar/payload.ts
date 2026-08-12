// src/rust-ffi/scalar/payload.ts — Output / streaming scalar methods.
//
// Mirrors rust/payload/*: gzip/brotli compress, multipart parse, WebSocket
// frame codec and SSE event framing.

import type { MultipartPart, WsFrame } from '../../native'
import { getBunFFI } from '../../native/ffi'
import type { RustClientContext } from '../context'

/** Output / streaming scalar methods (`Pick<RustScalar, ...>`). */
export function buildPayload(ctx: RustClientContext) {
  const { addon } = ctx

  return {
    gzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
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
          (packed[2]! | (packed[3]! << 8) | (packed[4]! << 16) | (packed[5]! << 24)) >>> 0
        return {
          fin: packed[0]! === 1,
          opcode: packed[1]!,
          payload: packed.subarray(6, 6 + payloadLen),
        }
      }
      return addon.wsFrameDecode(data)
    },
    sseEncodeEvent(
      event: string | null,
      data: Uint8Array,
      id: string | null,
      retry: number | null,
    ): Uint8Array {
      return addon.sseEncodeEvent(event ?? null, data, id ?? null, retry ?? null)
    },
  }
}
