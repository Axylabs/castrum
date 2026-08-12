// src/rust-ffi/text.ts — String-oriented FFI namespace (text in → text out).
//
// `rust.text.*` is the ergonomic string API over the byte-level native
// functions. Pure wrappers: encode input, call native, decode output.

import { decoder, encoder } from "../shared/bytes";
import { isBun } from "../shared/runtime";
import { resolveNative, type RustClientContext } from "./context";

/** String-oriented FFI namespace. */
export interface RustText {
  mimeFromExtension(ext: string): string;
  urlEncode(input: string): string;
  urlDecode(input: string): string;
  wsAcceptKey(key: string): string;
  validateEmail(input: string): boolean;
  validateUuid(input: string): boolean;
  validateIpv4(input: string): boolean;
  validateIpv6(input: string): boolean;
}

/** Build the `text` namespace for a client context. */
export function buildText(ctx: RustClientContext): RustText {
  // String memo: the byte path already caches the native bytes; this avoids the
  // encode → native lookup → slice → decode round-trip for repeated extension
  // strings (the common case) — 0 allocations on a cache hit.
  const mimeStrCache = new Map<string, string>();

  return {
    mimeFromExtension(ext) {
      let mime = mimeStrCache.get(ext);
      if (mime === undefined) {
        mime = decoder.decode(ctx.cachedMime(encoder.encode(ext)));
        mimeStrCache.set(ext, mime);
      }
      return mime;
    },
    urlEncode(input) {
      // Bun's native encodeURIComponent beats the rust+FFI/NAPI string crossing
      // (~4x, measured) with byte-for-byte parity (RFC 3986 unreserved set) —
      // see docs/bun-builtins-decision-matrix.md.
      if (isBun()) return encodeURIComponent(input);
      return resolveNative(ctx, "urlEncodeStr")(input) as string;
    },
    urlDecode(input) {
      // decodeURIComponent matches the rust decoder on valid input and also
      // throws on malformed/invalid UTF-8 (URIError, an Error subclass).
      if (isBun()) return decodeURIComponent(input);
      return resolveNative(ctx, "urlDecodeStr")(input) as string;
    },
    wsAcceptKey(key) {
      return decoder.decode(resolveNative(ctx, "wsAcceptKey")(encoder.encode(key)) as Uint8Array);
    },
    validateEmail(input) {
      return resolveNative(ctx, "validateEmail")(encoder.encode(input)) as boolean;
    },
    validateUuid(input) {
      return resolveNative(ctx, "validateUuid")(encoder.encode(input)) as boolean;
    },
    validateIpv4(input) {
      return resolveNative(ctx, "validateIpv4")(encoder.encode(input)) as boolean;
    },
    validateIpv6(input) {
      return resolveNative(ctx, "validateIpv6")(encoder.encode(input)) as boolean;
    },
  };
}
