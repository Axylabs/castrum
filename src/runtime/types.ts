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
// env, builtins, transport }); `src/runtime/index.ts` composes the FULL
// adapter (adding server + websocket in src/runtime/server.ts). Pure modules
// must not import this boundary — take the functions they need via DI.

import type { BakedServer, CreateIngressServerOptions } from '../ingress/server'
import type { WebSocketUpgradeOptions, WebSocketUpgradeResult } from '../integration/websocket'
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
 * Platform HTTP server adapter. `createIngressServer` builds a `Bun.serve`
 * server on Bun and the `node:http` adapter on Node — the SAME pre-baked
 * route handlers (shared `buildRouteHandlers`) either way. The explicit
 * `createIngressServerNode` stays exported for consumers who want the Node
 * backend pinned.
 */
export interface ServerAdapter {
  /** The backend this adapter targets. */
  readonly runtime: 'bun' | 'node'
  createIngressServer(options: CreateIngressServerOptions): BakedServer
}

/**
 * Platform WebSocket adapter. `createWebSocketUpgrade` returns the RFC 6455
 * 101 handshake on Bun (whose `Response` can carry status 101) and throws a
 * clear Bun-only error on Node (which must use the server-node `upgrade`
 * option instead).
 */
export interface WebsocketAdapter {
  createWebSocketUpgrade(
    req: Request,
    opts?: WebSocketUpgradeOptions,
  ): WebSocketUpgradeResult | null
}

/**
 * The runtime adapter — the single seam centralizing every Bun-vs-Node and
 * native-transport decision. Selected ONCE at module load (`src/runtime`).
 * `src/runtime/native.ts` composes the FFI-facing subset
 * ({@link NativeRuntimeAdapter}); the FULL adapter additionally carries
 * `server` + `websocket` (composed in `src/runtime/index.ts` for the public
 * API).
 */
export interface RuntimeAdapter {
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
  /** Platform HTTP server (Bun.serve on Bun, node:http on Node). */
  readonly server: ServerAdapter
  /** Platform WebSocket 101 handshake (Bun-only). */
  readonly websocket: WebsocketAdapter
}

/**
 * The FFI-facing runtime subset (no server/websocket) — what the `rust-ffi`
 * layer / selection / shared helpers import, so the native seam never pulls
 * the ingress graph.
 */
export type NativeRuntimeAdapter = Omit<RuntimeAdapter, 'server' | 'websocket'>
