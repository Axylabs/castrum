// src/rust-ffi/scalar/http.ts — HTTP wire-format + parsing scalar methods.
//
// Mirrors rust/http/* (packed parsers, media type, etag, HTTP dates,
// Accept-Encoding, URL codec/join, MIME lookup) plus the `util/validation`
// validators and the WebSocket accept-key.

import type { RustClientContext } from "../context";
import type { EncodingPrefResult, MediaTypeResult } from "../../native";

/** HTTP / parsing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHttp(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array {
      return ctx.cachedMime(ext);
    },
    urlEncode(input: Uint8Array): Uint8Array {
      return addon.urlEncode(input);
    },
    urlDecode(input: Uint8Array): Uint8Array {
      return addon.urlDecode(input);
    },
    urlDecodeBytes(input: Uint8Array): Uint8Array {
      return addon.urlDecodeBytes(input);
    },
    urlEncodeInto(input: Uint8Array, output: Uint8Array): number {
      return addon.urlEncodeInto(input, output);
    },
    urlDecodeInto(input: Uint8Array, output: Uint8Array): number {
      return addon.urlDecodeInto(input, output);
    },
    validateEmail(input: Uint8Array): boolean {
      return addon.validateEmail(input);
    },
    validateUuid(input: Uint8Array): boolean {
      return addon.validateUuid(input);
    },
    validateIpv4(input: Uint8Array): boolean {
      return addon.validateIpv4(input);
    },
    validateIpv6(input: Uint8Array): boolean {
      return addon.validateIpv6(input);
    },
    wsAcceptKey(key: Uint8Array): Uint8Array {
      return addon.wsAcceptKey(key);
    },
    httpParseRequestPacked(input: Uint8Array): Uint8Array {
      return addon.httpParseRequestPacked(input);
    },
    httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number {
      return addon.httpParseRequestPackedInto(input, output);
    },
    queryParsePacked(input: Uint8Array): Uint8Array {
      return addon.queryParsePacked(input);
    },
    queryParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      return addon.queryParsePackedInto(input, output);
    },
    cookieParsePacked(input: Uint8Array): Uint8Array {
      return addon.cookieParsePacked(input);
    },
    cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      return addon.cookieParsePackedInto(input, output);
    },
    formParsePacked(input: Uint8Array): Uint8Array {
      return addon.formParsePacked(input);
    },
    parseMediaType(input: Uint8Array): MediaTypeResult {
      const r = addon.parseMediaType(input);
      // napi serializes Option fields as undefined; normalize to null to match
      // the declared `string | null` public type.
      return {
        mediaType: r.mediaType,
        charset: r.charset ?? null,
        boundary: r.boundary ?? null,
        params: r.params,
      };
    },
    etag(data: Uint8Array, weak?: boolean): Uint8Array {
      return addon.etag(data, weak ?? undefined);
    },
    etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number {
      return addon.etagInto(data, output, weak ?? undefined);
    },
    httpDate(secs?: number): Uint8Array {
      return addon.httpDate(secs ?? undefined);
    },
    parseHttpDate(input: Uint8Array): bigint | null {
      return addon.parseHttpDate(input);
    },
    parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[] {
      return addon.parseAcceptEncoding(input);
    },
    urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array {
      return addon.urlResolve(base, reference);
    },
    urlEncodeQuery(params: Record<string, string>): Uint8Array {
      return addon.urlEncodeQuery(params);
    },
  };
}
