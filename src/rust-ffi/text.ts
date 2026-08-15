// src/rust-ffi/text.ts — String-oriented FFI namespace (text in → text out).
//
// `rust.text.*` is the ergonomic string API over the byte-level native
// functions. Pure wrappers: encode input, call native, decode output.

import { getBunFFI } from '../native/ffi'
import { decoder, encoder } from '../shared/bytes'
import { isBun } from '../shared/runtime'
import { type RustClientContext, resolveNative } from './context'

/** String-oriented FFI namespace. */
export interface RustText {
  /**
   * Resolve a lowercase file extension to a MIME type string (e.g. `"html"` →
   * `"text/html"`). Unknown extensions return `"application/octet-stream"`.
   * @param ext the file extension WITHOUT a leading dot, case-insensitive.
   * @returns the MIME type for `ext`.
   */
  mimeFromExtension(ext: string): string
  /**
   * RFC 3986 percent-encode a string (the `encodeURIComponent` unreserved
   * set). Under Bun this delegates to the native `encodeURIComponent` for
   * ~4x speed with byte-for-byte parity.
   * @param input the string to encode.
   * @returns the percent-encoded string.
   */
  urlEncode(input: string): string
  /**
   * Percent-decode a string. Throws on malformed `%XX` or invalid UTF-8
   * output (parity with `decodeURIComponent`, which is used under Bun).
   * @param input the percent-encoded string to decode.
   * @returns the decoded string.
   */
  urlDecode(input: string): string
  /**
   * Compute the RFC 6455 `Sec-WebSocket-Accept` value for a client key.
   * @param key the base64 `Sec-WebSocket-Key` header value.
   * @returns the 28-byte base64 accept value.
   */
  wsAcceptKey(key: string): string
  /** @param input an email address. @returns whether it is RFC-valid. */
  validateEmail(input: string): boolean
  /** @param input a UUID string. @returns whether it is a valid (v1-v8) UUID. */
  validateUuid(input: string): boolean
  /** @param input an IPv4 address. @returns whether it is valid. */
  validateIpv4(input: string): boolean
  /** @param input an IPv6 address. @returns whether it is valid. */
  validateIpv6(input: string): boolean
}

/** Build the `text` namespace for a client context. */
export function buildText(ctx: RustClientContext): RustText {
  // String memo: the byte path already caches the native bytes; this avoids the
  // encode → native lookup → slice → decode round-trip for repeated extension
  // strings (the common case) — 0 allocations on a cache hit.
  const mimeStrCache = new Map<string, string>()

  return {
    mimeFromExtension(ext) {
      let mime = mimeStrCache.get(ext)
      if (mime === undefined) {
        // FFI-first: cstring MIME return (native transfer — zero decode). napi
        // keeps the memoized-bytes path (cachedMime → decode).
        const ffi = getBunFFI()
        mime = ffi
          ? (ffi.mimeFromExtension(encoder.encode(ext)) ?? 'application/octet-stream')
          : decoder.decode(ctx.cachedMime(encoder.encode(ext)))
        mimeStrCache.set(ext, mime)
      }
      return mime
    },
    urlEncode(input) {
      // Bun's native encodeURIComponent beats the rust+FFI/NAPI string crossing
      // (~4x, measured) with byte-for-byte parity (RFC 3986 unreserved set) —
      // see docs/bun-builtins-decision-matrix.md.
      if (isBun()) return encodeURIComponent(input)
      return resolveNative(ctx, 'urlEncodeStr')(input) as string
    },
    urlDecode(input) {
      // decodeURIComponent matches the rust decoder on valid input and also
      // throws on malformed/invalid UTF-8 (URIError, an Error subclass).
      if (isBun()) return decodeURIComponent(input)
      return resolveNative(ctx, 'urlDecodeStr')(input) as string
    },
    wsAcceptKey(key) {
      // FFI-first: cstring accept-key return (native transfer). napi keeps the
      // decode path.
      const ffi = getBunFFI()
      if (ffi) return ffi.wsAcceptKey(encoder.encode(key))
      return decoder.decode(resolveNative(ctx, 'wsAcceptKey')(encoder.encode(key)) as Uint8Array)
    },
    validateEmail(input) {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateEmail(encoder.encode(input))
      return resolveNative(ctx, 'validateEmail')(encoder.encode(input)) as boolean
    },
    validateUuid(input) {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateUuid(encoder.encode(input))
      return resolveNative(ctx, 'validateUuid')(encoder.encode(input)) as boolean
    },
    validateIpv4(input) {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateIpv4(encoder.encode(input))
      return resolveNative(ctx, 'validateIpv4')(encoder.encode(input)) as boolean
    },
    validateIpv6(input) {
      const ffi = getBunFFI()
      if (ffi) return ffi.validateIpv6(encoder.encode(input))
      return resolveNative(ctx, 'validateIpv6')(encoder.encode(input)) as boolean
    },
  }
}
