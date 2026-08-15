// src/rust-ffi/scalar/http.ts — HTTP wire-format + parsing scalar methods.
//
// Mirrors rust/http/* (packed parsers, media type, etag, HTTP dates,
// Accept-Encoding, URL codec/join, MIME lookup) plus the `util/validation`
// validators and the WebSocket accept-key.

import type { EncodingPrefResult, MediaTypeResult } from '../../native'
import { getBunFFI } from '../../native/ffi'
import { decoder, encoder } from '../../shared/bytes'
import { decodeUtf8Fatal } from '../../shared/codec'
import { packPairs } from '../../shared/packed'
import { isBun } from '../../shared/runtime'
import { type RustClientContext, resolveNative } from '../context'

// Mirror napi `url_decode`'s UTF-8 validation (rust/http/url_codec.rs): only
// validate when a high byte is present (the ASCII fast path skips it — same as
// Rust's saw_high check). On the Bun path the check is a native C-ABI probe
// (`castrum_utf8_valid`); under Node (no ffi) the codec's fatal TextDecoder is
// the fallback — no TextDecoder runs on the Bun path.
function ensureValidUtf8(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] ?? 0) >= 0x80) {
      const ffi = getBunFFI()
      if (ffi) {
        if (!ffi.utf8Valid(bytes)) {
          throw new Error('url decode: invalid UTF-8 in decoded output')
        }
      } else {
        try {
          decodeUtf8Fatal(bytes)
        } catch {
          throw new Error('url decode: invalid UTF-8 in decoded output')
        }
      }
      return
    }
  }
}

/** Read an unsigned little-endian u32 at `off` (0 past the end). */
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
 * Unpack the `castrum_parse_media_type` verdict into the napi-shaped result.
 * Layout: `[u32 mediaTypeLen][mediaType][u32 charsetLen (0xFFFFFFFF = none)]
 * [charset][u32 boundaryLen][boundary][u32 paramCount]{[u32 keyLen][key]
 * [u32 valLen][val]}` — charset/boundary also appear in `params`, matching the
 * napi `HashMap` (which keeps every param including charset/boundary).
 */
function unpackMediaType(packed: Uint8Array): MediaTypeResult {
  let off = 0
  const mtLen = u32LE(packed, off)
  off += 4
  const mediaType = decoder.decode(packed.subarray(off, off + mtLen))
  off += mtLen
  let charset: string | null = null
  const csLen = u32LE(packed, off)
  off += 4
  if (csLen !== 0xffffffff) {
    charset = decoder.decode(packed.subarray(off, off + csLen))
    off += csLen
  }
  let boundary: string | null = null
  const bLen = u32LE(packed, off)
  off += 4
  if (bLen !== 0xffffffff) {
    boundary = decoder.decode(packed.subarray(off, off + bLen))
    off += bLen
  }
  const count = u32LE(packed, off)
  off += 4
  const params: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const kLen = u32LE(packed, off)
    off += 4
    const key = decoder.decode(packed.subarray(off, off + kLen))
    off += kLen
    const vLen = u32LE(packed, off)
    off += 4
    const val = decoder.decode(packed.subarray(off, off + vLen))
    off += vLen
    params[key] = val
  }
  return { mediaType, charset, boundary, params }
}

/** Unpack the `castrum_parse_accept_encoding` verdict (f32 q-values) into the
 * napi-shaped array. Layout: `[u32 count]{[u32 encLen][enc][f32 q][u32 order]}`. */
function unpackAcceptEncoding(packed: Uint8Array): EncodingPrefResult[] {
  const count = u32LE(packed, 0)
  let off = 4
  const out: EncodingPrefResult[] = []
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  for (let i = 0; i < count; i++) {
    const encLen = u32LE(packed, off)
    off += 4
    const encoding = decoder.decode(packed.subarray(off, off + encLen))
    off += encLen
    const q = view.getFloat32(off, true)
    off += 4
    const order = u32LE(packed, off)
    off += 4
    out.push({ encoding, q, order })
  }
  return out
}

/** HTTP / parsing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHttp(ctx: RustClientContext) {
  // Resolve the native fns through the shared first-use cache so the hot
  // scalar path skips the lazy-addon Proxy get on every call.
  const n = (name: string) => resolveNative(ctx, name)

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array | string {
      // FFI-first: cstring MIME return (native transfer — zero encode). napi
      // keeps the memoized-bytes path.
      const ffi = getBunFFI()
      if (ffi) return ffi.mimeFromExtension(ext) ?? 'application/octet-stream'
      return ctx.cachedMime(ext)
    },
    urlEncode(input: Uint8Array): Uint8Array | string {
      // Under Bun, Bun's native `encodeURIComponent` beats the rust+FFI/NAPI
      // crossing (~4x on the string path, ~1.3x on bytes) and skips the C-ABI
      // call entirely — see docs/bun-builtins-decision-matrix.md. Bun returns
      // the percent-encoded STRING (native transfer). Parity is pinned by
      // test/unit/features/url.test.ts.
      if (isBun()) return encodeURIComponent(decoder.decode(input))
      const ffi = getBunFFI()
      if (ffi) return ffi.urlEncode(input)
      return n('urlEncode')(input) as Uint8Array
    },
    urlDecode(input: Uint8Array): Uint8Array {
      // Same rationale as `urlEncode`; the strict `urlDecode` already throws on
      // invalid UTF-8 (ensureValidUtf8 below), matching decodeURIComponent's
      // URIError (a subclass of Error), so the JS path is behavior-equivalent.
      if (isBun()) return encoder.encode(decodeURIComponent(decoder.decode(input)))
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
    wsAcceptKey(key: Uint8Array): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) return ffi.wsAcceptKey(key)
      return n('wsAcceptKey')(key) as Uint8Array
    },
    wsAcceptKeyInto(key: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.wsAcceptKeyInto(key, output)
      const bytes = n('wsAcceptKey')(key) as Uint8Array
      if (output.length < bytes.length) throw new Error('ws accept key: output buffer too small')
      output.set(bytes)
      return bytes.length
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
    formParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      // Pooled sibling of formParsePacked — caller-owned output buffer (the
      // napi addon has no packed `Into` for form, so copy via the allocating
      // call on that path; same wire output, so the copy is exact).
      const ffi = getBunFFI()
      if (ffi) return ffi.formParsePackedInto(input, output)
      const bytes = n('formParsePacked')(input) as Uint8Array
      if (output.length < bytes.length) throw new Error('form parse: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    parseMediaType(input: Uint8Array): MediaTypeResult {
      const ffi = getBunFFI()
      if (ffi) return unpackMediaType(ffi.parseMediaType(input))
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
    etag(data: Uint8Array, weak?: boolean): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) return ffi.etag(data, weak)
      return n('etag')(data, weak ?? undefined) as Uint8Array
    },
    etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.etagInto(data, output, weak)
      return n('etagInto')(data, output, weak ?? undefined) as number
    },
    httpDate(secs?: number): Uint8Array | string {
      // Bun's Date.toUTCString (RFC 1123 IMF-fixdate) beats the rust+FFI
      // crossing (~3.7x, measured); Bun returns the STRING (native transfer).
      if (isBun()) {
        const t = secs ?? Math.floor(Date.now() / 1000)
        return new Date(t * 1000).toUTCString()
      }
      return n('httpDate')(secs ?? undefined) as Uint8Array
    },
    httpDateInto(secs: number | undefined, output: Uint8Array): number {
      // FFI-first: `castrum_http_date_into` writes directly into the caller
      // buffer (no napi crossing). `undefined` → 0 (matches the napi
      // `Option<f64>` default). napi fallback keeps the old path.
      const ffi = getBunFFI()
      if (ffi) return ffi.httpDateInto(secs ?? 0, output)
      return n('httpDateInto')(secs ?? undefined, output) as number
    },
    parseHttpDate(input: Uint8Array): bigint | null {
      const ffi = getBunFFI()
      if (ffi) return ffi.parseHttpDate(input)
      return n('parseHttpDate')(input) as bigint | null
    },
    parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[] {
      const ffi = getBunFFI()
      if (ffi) return unpackAcceptEncoding(ffi.parseAcceptEncoding(input))
      return n('parseAcceptEncoding')(input) as EncodingPrefResult[]
    },
    urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array | string {
      // FFI-first: cstring resolution (native transfer — zero encode).
      const ffi = getBunFFI()
      if (ffi) {
        const s = ffi.urlResolve(base, reference)
        if (s === null) throw new Error('url resolve: invalid UTF-8 in input')
        return s
      }
      return n('urlResolve')(base, reference) as Uint8Array
    },
    urlEncodeQuery(params: Record<string, string>): Uint8Array | string {
      // FFI-first: pack the params into the shared pairs layout, then the C
      // side sorts keys (BTreeMap) and percent-encodes → cstring.
      const ffi = getBunFFI()
      if (ffi) {
        const s = ffi.urlEncodeQuery(packPairs(Object.entries(params)))
        if (s === null) throw new Error('url encode query: invalid input')
        return s
      }
      return n('urlEncodeQuery')(params) as Uint8Array
    },
  }
}
