// src/rust-ffi/scalar/http.ts — HTTP wire-format + parsing scalar methods.
//
// Mirrors rust/http/* (packed parsers, media type, etag, HTTP dates,
// Accept-Encoding, URL codec/join, MIME lookup) plus the `util/validation`
// validators and the WebSocket accept-key.
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): Bun built-in
// delegations (urlEncode/urlDecode/httpDate) come from `builtins.has(op)` and
// the native call from `transport.resolve(op)` / `transport.ffi` (bun:ffi
// first, napi fallback) — no inline `isBun()` / `getBunFFI()`.

import type { EncodingPrefResult, MediaTypeResult } from '../../native'
import type { BunFFI } from '../../native/ffi'
import { decoder } from '../../shared/bytes'
import { decodeUtf8Fatal, decodeUtf8Range } from '../../shared/codec'
import { packPairs } from '../../shared/packed'
import { memoizeFfi, type RustClientContext, resolveNative } from '../context'
import { writeInto } from '../into'

// Mirror napi `url_decode`'s UTF-8 validation (rust/http/url_codec.rs): only
// validate when a high byte is present (the ASCII fast path skips it — same as
// Rust's saw_high check). On the Bun path the check is a native C-ABI probe
// (`castrum_utf8_valid`); under Node (no ffi) the codec's fatal TextDecoder is
// the fallback — no TextDecoder runs on the Bun path.
function ensureValidUtf8(bytes: Uint8Array, ffi: BunFFI | null): void {
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] ?? 0) >= 0x80) {
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
  // Ranged decode straight off the (pooled) packed buffer — no per-field
  // subarray views. ASCII fields take the latin1 fast path.
  let off = 0
  const mtLen = u32LE(packed, off)
  off += 4
  const mediaType = decodeUtf8Range(packed, off, off + mtLen)
  off += mtLen
  let charset: string | null = null
  const csLen = u32LE(packed, off)
  off += 4
  if (csLen !== 0xffffffff) {
    charset = decodeUtf8Range(packed, off, off + csLen)
    off += csLen
  }
  let boundary: string | null = null
  const bLen = u32LE(packed, off)
  off += 4
  if (bLen !== 0xffffffff) {
    boundary = decodeUtf8Range(packed, off, off + bLen)
    off += bLen
  }
  const count = u32LE(packed, off)
  off += 4
  const params: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const kLen = u32LE(packed, off)
    off += 4
    const key = decodeUtf8Range(packed, off, off + kLen)
    off += kLen
    const vLen = u32LE(packed, off)
    off += 4
    const val = decodeUtf8Range(packed, off, off + vLen)
    off += vLen
    params[key] = val
  }
  return { mediaType, charset, boundary, params }
}

/** Unpack the `castrum_parse_accept_encoding` verdict (f32 q-values) into the
 * napi-shaped array. Layout: `[u32 count]{[u32 encLen][enc][f32 q][u32 order]}`.
 * Ranged decode off the pooled buffer + shared f32 bit-reinterpret views —
 * no per-field subarrays, no per-call DataView. */
const f32Bits = new Float32Array(1)
const f32BitsU32 = new Uint32Array(f32Bits.buffer)
function unpackAcceptEncoding(packed: Uint8Array): EncodingPrefResult[] {
  const count = u32LE(packed, 0)
  let off = 4
  const out: EncodingPrefResult[] = []
  for (let i = 0; i < count; i++) {
    const encLen = u32LE(packed, off)
    off += 4
    const encoding = decodeUtf8Range(packed, off, off + encLen)
    off += encLen
    f32BitsU32[0] = u32LE(packed, off)
    const q: number = f32Bits[0] ?? 0
    off += 4
    const order = u32LE(packed, off)
    off += 4
    out.push({ encoding, q, order })
  }
  return out
}

/** HTTP / parsing scalar methods (`Pick<RustScalar, ...>`). */
export function buildHttp(ctx: RustClientContext) {
  const { builtins, transport } = ctx.runtime
  // Resolve the native fns through the shared first-use cache so the hot
  // scalar path skips the lazy-addon Proxy get on every call. `resolveNative`
  // is FFI-first (bun:ffi when live, napi fallback) via the adapter.
  const n = (name: string) => resolveNative(ctx, name)
  // Hoist the immutable per-runtime builtin-delegation decisions into a
  // bind-time map (BUILTIN_OPS is a module constant, never mutated after
  // load) so the hot path reads an object property instead of a `Set.has`.
  const HAS = {
    urlEncode: builtins.has('urlEncode'),
    urlDecode: builtins.has('urlDecode'),
    httpDate: builtins.has('httpDate'),
  }
  // Lazy-memoized ffi surface: binds on first call (no eager dlopen at
  // import), then a single local read per call — no getter hop.
  const ffi = memoizeFfi(transport)

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array | string {
      // FFI-first: the `cstring` ARG is string-only, so bytes are decoded once
      // (cheap CString clone) before the call. napi keeps the memoized-bytes
      // path (cachedMime).
      const f = ffi()
      if (f) return f.mimeFromExtension(decoder.decode(ext)) ?? 'application/octet-stream'
      return ctx.cachedMime(ext)
    },
    urlEncode(input: Uint8Array): Uint8Array | string {
      // Under Bun, Bun's native `encodeURIComponent` beats the rust+FFI/NAPI
      // crossing (~4x on the string path, ~1.3x on bytes) and skips the C-ABI
      // call entirely — see docs/bun-builtins-decision-matrix.md. Bun returns
      // the percent-encoded STRING (native transfer). Parity is pinned by
      // test/unit/features/url.test.ts.
      if (HAS.urlEncode) return builtins.urlEncode(input)
      return n('urlEncode')(input) as Uint8Array
    },
    urlDecode(input: Uint8Array): Uint8Array {
      // Same rationale as `urlEncode`; the strict `urlDecode` already throws on
      // invalid UTF-8 (ensureValidUtf8 below), matching decodeURIComponent's
      // URIError (a subclass of Error), so the JS path is behavior-equivalent.
      if (HAS.urlDecode) return builtins.urlDecode(input)
      const f = ffi()
      if (f) {
        const out = f.urlDecode(input)
        // napi `url_decode` validates UTF-8 (only when a high byte is present);
        // `url_decode_bytes`/`url_decode_into` do not. This is the strict one.
        ensureValidUtf8(out, transport.ffi)
        return out
      }
      return n('urlDecode')(input) as Uint8Array
    },
    urlDecodeBytes(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) return f.urlDecode(input) // byte semantics match url_decode_bytes
      return n('urlDecodeBytes')(input) as Uint8Array
    },
    urlEncodeInto(input: Uint8Array, output: Uint8Array): number {
      return n('urlEncodeInto')(input, output) as number
    },
    urlDecodeInto(input: Uint8Array, output: Uint8Array): number {
      // no UTF-8 check — matches napi url_decode_into on both transports
      return n('urlDecodeInto')(input, output) as number
    },
    validateEmail(input: Uint8Array): boolean {
      // FFI-first: the `cstring` ARG is string-only, so bytes are decoded once
      // (cheap CString clone) before the call — still faster than the old
      // `(ptr,len)` view path (see bench:margin cstring scenario). napi
      // fallback keeps the byte path.
      const f = ffi()
      if (f) return f.validateEmail(decoder.decode(input))
      return n('validateEmail')(input) as boolean
    },
    validateUuid(input: Uint8Array): boolean {
      const f = ffi()
      if (f) return f.validateUuid(decoder.decode(input))
      return n('validateUuid')(input) as boolean
    },
    validateIpv4(input: Uint8Array): boolean {
      const f = ffi()
      if (f) return f.validateIpv4(decoder.decode(input))
      return n('validateIpv4')(input) as boolean
    },
    validateIpv6(input: Uint8Array): boolean {
      const f = ffi()
      if (f) return f.validateIpv6(decoder.decode(input))
      return n('validateIpv6')(input) as boolean
    },
    wsAcceptKey(key: Uint8Array): Uint8Array | string {
      // FFI-first: the `cstring` ARG is string-only, so bytes are decoded once
      // (cheap CString clone) before the call. napi fallback keeps the bytes.
      const f = ffi()
      if (f) return f.wsAcceptKey(decoder.decode(key))
      return n('wsAcceptKey')(key) as Uint8Array | string
    },
    wsAcceptKeyInto(key: Uint8Array, output: Uint8Array): number {
      const f = ffi()
      if (f) return f.wsAcceptKeyInto(key, output)
      return writeInto('ws accept key', output, n('wsAcceptKey')(key) as Uint8Array)
    },
    httpParseRequestPacked(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = f.httpParseRequestPackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('httpParseRequestPacked')(input) as Uint8Array
    },
    httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number {
      return n('httpParseRequestPackedInto')(input, output) as number
    },
    queryParsePacked(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = f.queryParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('queryParsePacked')(input) as Uint8Array
    },
    queryParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      return n('queryParsePackedInto')(input, output) as number
    },
    cookieParsePacked(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) {
        const out = new Uint8Array(input.length * 9 + 16)
        const w = f.cookieParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('cookieParsePacked')(input) as Uint8Array
    },
    cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      return n('cookieParsePackedInto')(input, output) as number
    },
    formParsePacked(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) {
        // x-www-form-urlencoded uses the SAME packed-pairs core as query parse.
        const out = new Uint8Array(input.length * 9 + 16)
        const w = f.formParsePackedInto(input, out)
        return out.subarray(0, w)
      }
      return n('formParsePacked')(input) as Uint8Array
    },
    formParsePackedInto(input: Uint8Array, output: Uint8Array): number {
      // Pooled sibling of formParsePacked — caller-owned output buffer (the
      // napi addon has no packed `Into` for form, so copy via the allocating
      // call on that path; same wire output, so the copy is exact).
      const f = ffi()
      if (f) return f.formParsePackedInto(input, output)
      return writeInto('form parse', output, n('formParsePacked')(input) as Uint8Array)
    },
    parseMediaType(input: Uint8Array): MediaTypeResult {
      const f = ffi()
      if (f) return unpackMediaType(f.parseMediaType(input))
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
      return n('etag')(data, weak ?? undefined) as Uint8Array | string
    },
    etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number {
      return n('etagInto')(data, output, weak ?? undefined) as number
    },
    httpDate(secs?: number): Uint8Array | string {
      // Bun's Date.toUTCString (RFC 1123 IMF-fixdate) beats the rust+FFI
      // crossing (~3.7x, measured); Bun returns the STRING (native transfer).
      if (HAS.httpDate) return builtins.httpDate(secs)
      return n('httpDate')(secs ?? undefined) as Uint8Array
    },
    httpDateInto(secs: number | undefined, output: Uint8Array): number {
      // FFI-first: `castrum_http_date_into` writes directly into the caller
      // buffer (no napi crossing). `undefined` → 0 (matches the napi
      // `Option<f64>` default). napi fallback keeps the old path.
      const f = ffi()
      if (f) return f.httpDateInto(secs ?? 0, output)
      return n('httpDateInto')(secs ?? undefined, output) as number
    },
    parseHttpDate(input: Uint8Array): bigint | null {
      return n('parseHttpDate')(input) as bigint | null
    },
    parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[] {
      const f = ffi()
      if (f) return unpackAcceptEncoding(f.parseAcceptEncoding(input))
      return n('parseAcceptEncoding')(input) as EncodingPrefResult[]
    },
    urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array | string {
      // FFI-first: cstring resolution (native transfer — zero encode).
      const f = ffi()
      if (f) {
        const s = f.urlResolve(base, reference)
        if (s === null) throw new Error('url resolve: invalid UTF-8 in input')
        return s
      }
      return n('urlResolve')(base, reference) as Uint8Array
    },
    urlEncodeQuery(params: Record<string, string>): Uint8Array | string {
      // FFI-first: pack the params into the shared pairs layout, then the C
      // side sorts keys (BTreeMap) and percent-encodes → cstring.
      const f = ffi()
      if (f) {
        const s = f.urlEncodeQuery(packPairs(Object.entries(params)))
        if (s === null) throw new Error('url encode query: invalid input')
        return s
      }
      return n('urlEncodeQuery')(params) as Uint8Array
    },
  }
}
