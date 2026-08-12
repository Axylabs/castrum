// src/rust-ffi/scalar/http.ts — HTTP wire-format + parsing scalar methods.
//
// Mirrors rust/http/* (packed parsers, media type, etag, HTTP dates,
// Accept-Encoding, URL codec/join, MIME lookup) plus the `util/validation`
// validators and the WebSocket accept-key.

import type { EncodingPrefResult, MediaTypeResult } from '../../native'
import { getBunFFI } from '../../native/ffi'
import { type RustClientContext, resolveNative } from '../context'

// Mirror napi `url_decode`'s UTF-8 validation (rust/http/url_codec.rs): only
// validate when a high byte is present (the ASCII fast path skips it — same as
// Rust's saw_high check). `url_decode_bytes` / `url_decode_into` skip the check
// entirely, so those ffi bindings are byte-faithful with no extra work.
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })
function ensureValidUtf8(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! >= 0x80) {
      try {
        FATAL_UTF8.decode(bytes)
      } catch {
        throw new Error('url decode: invalid UTF-8 in decoded output')
      }
      return
    }
  }
}

/** HTTP / parsing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHttp(ctx: RustClientContext) {
  // Resolve the native fns through the shared first-use cache so the hot
  // scalar path skips the lazy-addon Proxy get on every call.
  const n = (name: string) => resolveNative(ctx, name)

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array {
      return ctx.cachedMime(ext)
    },
    urlEncode(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.urlEncode(input)
      return n('urlEncode')(input) as Uint8Array
    },
    urlDecode(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        const out = ffi.urlDecode(input)
        // napi `url_decode` validates UTF-8 (only when a high byte is present);
        // `url_decode_bytes`/`url_decode_into` do not. This is the strict one.
        ensureValidUtf8(out)
        return out
      }
      return n('urlDecode')(input) as Uint8Array
    },
    urlDecodeBytes(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.urlDecode(input) // byte semantics match url_decode_bytes
      return n('urlDecodeBytes')(input) as Uint8Array
    },
    urlEncodeInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.urlEncodeInto(input, output)
      return n('urlEncodeInto')(input, output) as number
    },
    urlDecodeInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.urlDecodeInto(input, output) // no UTF-8 check, matches napi
      return n('urlDecodeInto')(input, output) as number
    },
    validateEmail(input: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateEmail(input)
      return n('validateEmail')(input) as boolean
    },
    validateUuid(input: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateUuid(input)
      return n('validateUuid')(input) as boolean
    },
    validateIpv4(input: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateIpv4(input)
      return n('validateIpv4')(input) as boolean
    },
    validateIpv6(input: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateIpv6(input)
      return n('validateIpv6')(input) as boolean
    },
    wsAcceptKey(key: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.wsAcceptKey(key)
      return n('wsAcceptKey')(key) as Uint8Array
    },
    httpParseRequestPacked(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = ffi.httpParseRequestPackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('httpParseRequestPacked')(input) as Uint8Array
    },
    httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.httpParseRequestPackedInto(input, output)
      return n('httpParseRequestPackedInto')(input, output) as number
    },
    queryParsePacked(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = ffi.queryParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('queryParsePacked')(input) as Uint8Array
    },
    queryParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.queryParsePackedInto(input, output)
      return n('queryParsePackedInto')(input, output) as number
    },
    cookieParsePacked(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = ffi.cookieParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('cookieParsePacked')(input) as Uint8Array
    },
    cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.cookieParsePackedInto(input, output)
      return n('cookieParsePackedInto')(input, output) as number
    },
    formParsePacked(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        // x-www-form-urlencoded uses the SAME packed-pairs core as query parse.
        const out = new Uint8Array(input.length * 9 + 16)
        const w = ffi.formParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('formParsePacked')(input) as Uint8Array
    },
    parseMediaType(input: Uint8Array): MediaTypeResult {
      const r = n('parseMediaType')(input) as MediaTypeResult
      // napi serializes Option fields as undefined; normalize to null to match
      // the declared `string | null` public type.
      return {
        mediaType: r.mediaType,
        charset: r.charset ?? null,
        boundary: r.boundary ?? null,
        params: r.params,
      }
    },
    etag(data: Uint8Array, weak?: boolean): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.etag(data, weak)
      return n('etag')(data, weak ?? undefined) as Uint8Array
    },
    etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.etagInto(data, output, weak)
      return n('etagInto')(data, output, weak ?? undefined) as number
    },
    httpDate(secs?: number): Uint8Array {
      return n('httpDate')(secs ?? undefined) as Uint8Array
    },
    httpDateInto(secs: number | undefined, output: Uint8Array): number {
      return n('httpDateInto')(secs ?? undefined, output) as number
    },
    parseHttpDate(input: Uint8Array): bigint | null {
      return n('parseHttpDate')(input) as bigint | null
    },
    parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[] {
      return n('parseAcceptEncoding')(input) as EncodingPrefResult[]
    },
    urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array {
      return n('urlResolve')(base, reference) as Uint8Array
    },
    urlEncodeQuery(params: Record<string, string>): Uint8Array {
      return n('urlEncodeQuery')(params) as Uint8Array
    },
  }
}
