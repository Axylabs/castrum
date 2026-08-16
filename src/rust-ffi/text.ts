// src/rust-ffi/text.ts — String-oriented FFI namespace (text in → text out).
//
// `rust.text.*` is the ergonomic string API over the byte-level native
// functions. Pure wrappers: encode input, call native, decode output.
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): the Bun
// built-in delegations (urlEncode/urlDecode) come from `builtins.has(op)` and
// the native call from `transport.ffi` / `transport.resolve` (bun:ffi first,
// napi fallback) — no inline `isBun()` / `getBunFFI()`.

import { decoder, encoder } from '../shared/bytes'
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
  const { builtins, transport } = ctx.runtime
  // String memo: the byte path already caches the native bytes; this avoids the
  // encode → native lookup → slice → decode round-trip for repeated extension
  // strings (the common case) — 0 allocations on a cache hit.
  const mimeStrCache = new Map<string, string>()

  return {
    mimeFromExtension(ext) {
      let mime = mimeStrCache.get(ext)
      if (mime === undefined) {
        // FFI-first: `cstring` ARG + cstring MIME return (native transfer both
        // ways — the engine transcodes the extension in-engine, no JS encode).
        // napi keeps the memoized-bytes path (cachedMime → decode).
        const f = transport.ffi
        mime = f
          ? (f.mimeFromExtension(ext) ?? 'application/octet-stream')
          : decoder.decode(ctx.cachedMime(encoder.encode(ext)))
        mimeStrCache.set(ext, mime)
      }
      return mime
    },
    urlEncode(input) {
      // Bun's native encodeURIComponent beats the rust+FFI/NAPI string crossing
      // (~4x, measured) with byte-for-byte parity (RFC 3986 unreserved set) —
      // see docs/bun-builtins-decision-matrix.md.
      if (builtins.has('urlEncode')) return builtins.urlEncodeStr(input)
      return resolveNative(ctx, 'urlEncodeStr')(input) as string
    },
    urlDecode(input) {
      // decodeURIComponent matches the rust decoder on valid input and also
      // throws on malformed/invalid UTF-8 (URIError, an Error subclass).
      if (builtins.has('urlDecode')) return builtins.urlDecodeStr(input)
      return resolveNative(ctx, 'urlDecodeStr')(input) as string
    },
    wsAcceptKey(key) {
      // FFI-first: `cstring` ARG + cstring return (native transfer both ways —
      // the engine transcodes the key in-engine, no JS encode). napi keeps the
      // encode/decode path.
      const f = transport.ffi
      if (f) return f.wsAcceptKey(key)
      return decoder.decode(resolveNative(ctx, 'wsAcceptKey')(encoder.encode(key)) as Uint8Array)
    },
    validateEmail(input) {
      // FFI-first: `cstring` ARG (the engine transcodes the string in-engine —
      // no JS encode). napi fallback keeps the encode path.
      const f = transport.ffi
      if (f) return f.validateEmail(input)
      return resolveNative(ctx, 'validateEmail')(encoder.encode(input)) as boolean
    },
    validateUuid(input) {
      const f = transport.ffi
      if (f) return f.validateUuid(input)
      return resolveNative(ctx, 'validateUuid')(encoder.encode(input)) as boolean
    },
    validateIpv4(input) {
      const f = transport.ffi
      if (f) return f.validateIpv4(input)
      return resolveNative(ctx, 'validateIpv4')(encoder.encode(input)) as boolean
    },
    validateIpv6(input) {
      const f = transport.ffi
      if (f) return f.validateIpv6(input)
      return resolveNative(ctx, 'validateIpv6')(encoder.encode(input)) as boolean
    },
  }
}
