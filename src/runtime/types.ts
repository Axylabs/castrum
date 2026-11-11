// src/runtime/types.ts — Runtime adapter contracts (Bun / Node).
//
// The single seam that centralizes every Bun-vs-Node and native-transport
// decision: detection (detect.ts), UTF-8 codec, uuid, env, Bun built-in
// delegation (builtins.ts), and the bun:ffi-vs-napi transport (transport.ts).
// Modeled on Elysia's adapter (`ElysiaAdapterOptions` / `createAdapter`) but
// internal-only, typed with concrete sub-objects (no string-union escape
// hatch), and selected ONCE at module load — hot paths never re-check
// `typeof Bun`.
//
// `src/runtime/native.ts` exposes the FFI-facing seam ({ name, codec, uuid,
// env, builtins, transport }). Pure modules must not import this boundary —
// take the functions they need via DI.

import type { NativeAddon } from '../native'
import type { BunFFI } from '../native/ffi'

/** Host runtime identifier. */
export type RuntimeName = 'bun' | 'node' | 'unknown'

/** Runtime-native UTF-8 codec (Bun transfer machinery vs TextEncoder/TextDecoder). */
export interface Utf8Codec {
  /** Encode a string to UTF-8 bytes (fresh buffer). */
  encodeUtf8(s: string): Uint8Array
  /** Encode into `dest` starting at `offset`; returns bytes written (no split chars). */
  encodeUtf8Into(s: string, dest: Uint8Array, offset?: number): number
  /** Decode UTF-8 bytes to a string (replacement mode on invalid). */
  decodeUtf8(bytes: Uint8Array): string
  /** Decode UTF-8 bytes to a string, throwing on invalid UTF-8. */
  decodeUtf8Fatal(bytes: Uint8Array): string
  /**
   * Decode the byte RANGE `[start, end)` of `bytes` to a string (replacement
   * mode on invalid). Zero-copy ranged decode for packed-wire unpackers —
   * avoids the per-field `subarray` view allocation. ASCII-only ranges take
   * a latin1 fast path (~2x on Bun); multi-byte ranges fall back to UTF-8.
   */
  decodeUtf8Range(bytes: Uint8Array, start: number, end: number): string
  /**
   * Decode the byte RANGE `[start, end)` of a PREPARED bounded `Buffer` view
   * using ABSOLUTE offsets into the view (0 = the view's first byte).
   * `unpackMediaType` resolves the WeakMap/Buffer view ONCE per packed result
   * and calls this per field — removing the per-field cache lookup + view
   * arithmetic. Identical semantics to `decodeUtf8Range` (replacement mode,
   * ASCII latin1 fast path); offsets are relative to the view, not the view's
   * backing buffer. Optional: runtimes/tests may leave it undefined — callers
   * fall back to `decodeUtf8Range` on the original bytes.
   */
  decodeUtf8RangeView?: (view: Buffer, start: number, end: number) => string
}

/** UUIDv7 generation (Bun built-in vs crypto.randomUUID on Node). */
export interface UuidAdapter {
  uuidv7(): string
}

/** Env-var resolution (CASTRUM_* preferred, napi-rs `NAPI_RS_*` aliases). */
export interface EnvAdapter {
  resolveVar(preferred: string, legacy: readonly string[]): string | undefined
}

/** A bound native callable (bun:ffi C-ABI or napi addon). */
export type NativeCallable = (...args: unknown[]) => unknown

/**
 * Native transport: the SAME cdylib accessed via bun:ffi (C-ABI, PRIMARY on
 * Bun) or napi (Node / fallback). `resolve(op)` returns the bound op
 * (ffi-first, cached, napi fallback) so hot call sites have no per-call
 * `getBunFFI()` branch.
 */
export interface TransportAdapter {
  /** Active transport: `"ffi"` (bun:ffi live) or `"napi"`. */
  readonly name: 'ffi' | 'napi'
  /** Native text-return contract: `"string"` on the ffi path, `"bytes"` on napi. */
  readonly returnType: 'string' | 'bytes'
  /** The raw bun:ffi surface when live, else `null` (for ops with ffi-specific JS handling). */
  readonly ffi: BunFFI | null
  /** The napi addon proxy (lazy — first native call triggers the dlopen). */
  readonly napi: NativeAddon
  /** Whether the bun:ffi transport is live (equivalent to `name === "ffi"`). */
  ffiActive(): boolean
  /** Bound op callable (ffi-first, napi fallback), or `undefined` for unknown ops. */
  resolve(op: string): NativeCallable | undefined
}

/**
 * Bun built-in delegation registry (the `BUN_WINS` set). Single source of
 * truth for "under Bun this op is faster as a built-in than via the addon".
 * On Node the registry is empty (`has()` is false) so builders fall through
 * to the native transport.
 *
 * `ops` is the exported op-name list; `selection.ts` derives its BUN_WINS
 * decision from `has(op)` so the hardcoded set + `isBun()` branch disappear.
 */
export interface BuiltinsAdapter {
  /** Op names this runtime delegates to built-ins (empty on Node). */
  readonly ops: readonly string[]
  /** Whether `op` has a built-in delegation on this runtime. */
  has(op: string): boolean

  // ── The delegated ops (bytes-in scalar surface, Bun contracts) ──
  crc32(input: Uint8Array): number
  xxh3(input: Uint8Array): bigint
  /** HMAC-SHA256 → lowercase-hex STRING on Bun. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | string
  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array
  /** Random hex token (2n chars) with the 16 MiB guard. */
  randomToken(byteLen: number): Uint8Array | string
  /** Standard padded base64 only; `undefined` when url-safe/unpadded (falls to native). */
  base64Encode(
    input: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): Uint8Array | string | undefined
  base64UrlEncode(input: Uint8Array): Uint8Array | string
  hexEncode(input: Uint8Array): Uint8Array | string
  /** Percent-encode bytes → percent-encoded STRING. */
  urlEncode(input: Uint8Array): string
  /** Percent-decode bytes → bytes. */
  urlDecode(input: Uint8Array): Uint8Array
  /** String-in percent-encode (`encodeURIComponent`). */
  urlEncodeStr(input: string): string
  /** String-in percent-decode (`decodeURIComponent`). */
  urlDecodeStr(input: string): string
  /** RFC 1123 IMF-fixdate STRING for `secs` (default now). */
  httpDate(secs?: number): string
}

/**
 * The FFI-facing runtime adapter used by `rust-ffi`, selection, and shared
 * helpers. This focused seam never pulls the ingress graph into native calls.
 */
export interface NativeRuntimeAdapter {
  /** Host runtime (cached at load — never re-checked in hot paths). */
  readonly name: RuntimeName
  /** Whether the runtime speaks the web-standard Request/Response surface. */
  readonly isWebStandard: boolean
  /** Runtime-native UTF-8 codec. */
  readonly codec: Utf8Codec
  /** UUIDv7 generation. */
  readonly uuid: UuidAdapter
  /** Env-var alias resolution. */
  readonly env: EnvAdapter
  /** Bun built-in delegation registry (empty on Node). */
  readonly builtins: BuiltinsAdapter
  /** Native transport (bun:ffi primary, napi fallback). */
  readonly transport: TransportAdapter
}
