// src/rust-ffi/text.ts — String-oriented FFI namespace (text in → text out).
//
// `rust.text.*` is the ergonomic string API over the byte-level native
// functions. Pure wrappers: encode input, call native, decode output.

import { decoder, encoder } from "../shared/bytes";
import type { RustClientContext } from "./context";

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
  const { addon } = ctx;

  return {
    mimeFromExtension(ext) {
      return decoder.decode(ctx.cachedMime(encoder.encode(ext)));
    },
    urlEncode(input) {
      return addon.urlEncodeStr(input);
    },
    urlDecode(input) {
      return addon.urlDecodeStr(input);
    },
    wsAcceptKey(key) {
      return decoder.decode(addon.wsAcceptKey(encoder.encode(key)));
    },
    validateEmail(input) {
      return addon.validateEmail(encoder.encode(input));
    },
    validateUuid(input) {
      return addon.validateUuid(encoder.encode(input));
    },
    validateIpv4(input) {
      return addon.validateIpv4(encoder.encode(input));
    },
    validateIpv6(input) {
      return addon.validateIpv6(encoder.encode(input));
    },
  };
}
