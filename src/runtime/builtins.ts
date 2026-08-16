// src/runtime/builtins.ts — Bun built-in delegation registry (the BUN_WINS set).
//
// Single source of truth for "under Bun this op is faster as a built-in than
// via the rust addon" (measured in docs/bun-builtins-decision-matrix.md). The
// scalar/text builders prefer `builtins.has(op)` over calling the native
// transport; `src/selection.ts` derives its `opImpl` decision from the same
// registry, so the hardcoded `BUN_WINS` set + `isBun()` branch disappear.
//
// NOTE: `gzipDecompress` is deliberately NOT delegated — the rust surface
// keeps the native path (with its 64 MiB decompression-bomb cap) even under
// Bun, because `Bun.gunzipSync` has no output-size bound.
//
// On Node the registry is EMPTY (`has()` returns false; methods throw if
// called) so every op falls through to the native transport.

import { runtimeCodec } from './codec'
import { detectedRuntime } from './detect'
import type { BuiltinsAdapter, RuntimeName } from './types'

/** The delegated op names (matches the historical `BUN_WINS` set). */
export const BUILTIN_OPS = [
  'gzipCompress',
  'crc32',
  'randomToken',
  'hmacSha256',
  'xxh3',
  'urlEncode',
  'urlDecode',
  'base64Encode',
  'base64UrlEncode',
  'hexEncode',
  'httpDate',
] as const

const MAX_TOKEN_BYTES = 16 * 1024 * 1024 // 16 MiB guard (matches the native path)

function createBunBuiltins(): BuiltinsAdapter {
  const ops = new Set<string>(BUILTIN_OPS)
  return {
    ops: BUILTIN_OPS,
    has(op: string): boolean {
      return ops.has(op)
    },
    crc32(input: Uint8Array): number {
      return Bun.hash.crc32(input) >>> 0 // preserves the unsigned-32 contract
    },
    xxh3(input: Uint8Array): bigint {
      return Bun.hash.xxHash3(input)
    },
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | string {
      const hasher = new Bun.CryptoHasher('sha256', key)
      hasher.update(data)
      return Buffer.from(hasher.digest()).toString('hex')
    },
    gzipCompress(data: Uint8Array, level?: number | null): Uint8Array {
      const opts = level != null ? ({ level } as Parameters<typeof Bun.gzipSync>[1]) : undefined
      return Bun.gzipSync(data as unknown as Uint8Array<ArrayBuffer>, opts)
    },
    randomToken(byteLen: number): Uint8Array | string {
      if (byteLen > MAX_TOKEN_BYTES) {
        throw new RangeError('randomToken: byteLen exceeds 16 MiB limit')
      }
      return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLen))).toString('hex')
    },
    base64Encode(
      input: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): Uint8Array | string | undefined {
      // Only the standard padded, non-url-safe case delegates (SIMD Buffer);
      // url-safe/unpadded falls through to the native transport.
      if (urlSafe || padding === false) return undefined
      return Buffer.from(input).toString('base64')
    },
    base64UrlEncode(input: Uint8Array): Uint8Array | string {
      return Buffer.from(input).toString('base64url')
    },
    hexEncode(input: Uint8Array): Uint8Array | string {
      return Buffer.from(input).toString('hex')
    },
    urlEncode(input: Uint8Array): string {
      return encodeURIComponent(runtimeCodec.decodeUtf8(input))
    },
    urlDecode(input: Uint8Array): Uint8Array {
      return runtimeCodec.encodeUtf8(decodeURIComponent(runtimeCodec.decodeUtf8(input)))
    },
    urlEncodeStr(input: string): string {
      return encodeURIComponent(input)
    },
    urlDecodeStr(input: string): string {
      return decodeURIComponent(input)
    },
    httpDate(secs?: number): string {
      const t = secs ?? Math.floor(Date.now() / 1000)
      return new Date(t * 1000).toUTCString()
    },
  }
}

function createNodeBuiltins(): BuiltinsAdapter {
  const unavailable = (op: string): never => {
    throw new Error(`builtin "${op}" is a Bun-only delegation — not available on Node`)
  }
  return {
    ops: [],
    has(): boolean {
      return false
    },
    crc32: () => unavailable('crc32'),
    xxh3: () => unavailable('xxh3'),
    hmacSha256: () => unavailable('hmacSha256'),
    gzipCompress: () => unavailable('gzipCompress'),
    randomToken: () => unavailable('randomToken'),
    base64Encode: () => unavailable('base64Encode'),
    base64UrlEncode: () => unavailable('base64UrlEncode'),
    hexEncode: () => unavailable('hexEncode'),
    urlEncode: () => unavailable('urlEncode'),
    urlDecode: () => unavailable('urlDecode'),
    urlEncodeStr: () => unavailable('urlEncodeStr'),
    urlDecodeStr: () => unavailable('urlDecodeStr'),
    httpDate: () => unavailable('httpDate'),
  }
}

/** Build the builtins registry for a runtime. */
export function createBuiltins(name: RuntimeName): BuiltinsAdapter {
  return name === 'bun' ? createBunBuiltins() : createNodeBuiltins()
}

/** The shared builtins registry for the detected runtime (selected once at load). */
export const runtimeBuiltins: BuiltinsAdapter = createBuiltins(detectedRuntime)
