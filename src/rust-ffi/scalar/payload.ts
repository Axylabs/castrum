// src/rust-ffi/scalar/payload.ts — Output / streaming scalar methods.
//
// Mirrors rust/payload/*: gzip/brotli compress, multipart parse, WebSocket
// frame codec and SSE event framing.

import type { RustClientContext } from "../context";
import type { MultipartPart, WsFrame } from "../../native";

/** Output / streaming scalar methods (`Pick<RustScalar, ...>`). */
export function buildPayload(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    gzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
      return addon.gzipCompress(data, level ?? null);
    },
    gzipDecompress(data: Uint8Array): Uint8Array {
      return addon.gzipDecompress(data);
    },
    brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array {
      return addon.brotliCompress(data, quality ?? null);
    },
    brotliDecompress(data: Uint8Array): Uint8Array {
      return addon.brotliDecompress(data);
    },
    multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[] {
      // Normalize napi `Option<String>` (undefined) → null and expose the
      // camelCase `contentType` key (napi renames `content_type` to camelCase).
      return addon.multipartParse(body, boundary).map((p) => ({
        name: p.name,
        filename: p.filename ?? null,
        contentType: p.contentType ?? null,
        data: p.data,
      }));
    },
    multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array {
      // Zero-copy packed sibling — no JS objects per part (see native types).
      return addon.multipartParsePacked(body, boundary);
    },
    wsFrameEncode(
      opcode: number,
      payload: Uint8Array,
      mask: boolean,
      fin: boolean,
    ): Uint8Array {
      return addon.wsFrameEncode(opcode, payload, mask, fin);
    },
    wsFrameDecode(data: Uint8Array): WsFrame | null {
      return addon.wsFrameDecode(data);
    },
    sseEncodeEvent(
      event: string | null,
      data: Uint8Array,
      id: string | null,
      retry: number | null,
    ): Uint8Array {
      return addon.sseEncodeEvent(
        event ?? null,
        data,
        id ?? null,
        retry ?? null,
      );
    },
  };
}
