// src/native/ffi.ts — Bun-only C-ABI fast path via `bun:ffi`.
//
// Bun JIT-compiles `bun:ffi` calls down to direct native calls (~10-20ns
// crossing), versus ~100-350ns for a Node-API call. The same cdylib that Node
// loads through napi-rs ALSO exports `extern "C"` symbols (`rust/ffi.rs`), so
// under Bun we can `dlopen` it and call the hot scalar functions directly —
// skipping the N-API marshaling that dominates the sub-µs operations.
//
// Safety / correctness strategy:
//   - Lazily bound (no addon/ffi work until first use).
//   - A one-time SELF-TEST runs at bind time: every bound function is checked
//     against known-good vectors. If ANY check fails (ABI mismatch, platform
//     quirk, a future Bun regression), the whole ffi layer is disabled and the
//     caller falls back to the napi addon — the public API never sees a wrong
//     result. `bun:ffi` is experimental; this is the safety net.
//   - Decoders that can fail (hexDecode / urlDecode / base64Decode) ARE exposed
//     here with parity error semantics: a `0` write on non-empty input throws
//     (the napi decoders throw rather than return a short buffer). The only
//     unavoidable divergence is decompressing a stream that yields exactly 0
//     bytes, which the C ABI can't distinguish from "too small" (napi returns
//     an empty buffer; ffi throws) — degenerate and not exercised by tests.
//   - Never called under Node (falls back to napi immediately).
//
// Buffer ABI: input/out pointers are `(ptr, len)` pairs; the JS wrapper passes
// `(view, view.length)` and bun:ffi converts the TypedArray to its pointer.

// Type-only: erased at compile time (no runtime import of `bun:ffi` — that
// stays lazy inside `bind()`). `FFITypeOrString` is the dlopen ABI-string union.
import type { FFITypeOrString } from 'bun:ffi'
import { resolveEnvVar } from '../shared/env'
import { isBun } from '../shared/runtime'
// Static import: loader.ts has no side effects (path resolution only — no
// dlopen), so this adds zero import-time cost while letting `bind()` reuse the
// exact same resolved `.node` path the napi fallback uses (the shared seam).
import { getAddonPath } from './loader'

const encoder = new TextEncoder()

/** The set of C-ABI functions this layer can accelerate on Bun. */
export interface BunFFI {
  crc32(input: Uint8Array): number
  fnv1a64(input: Uint8Array): bigint
  xxh3(input: Uint8Array): bigint
  jsonValid(input: Uint8Array): boolean
  /** Lowercase-hex encode into a fresh `Uint8Array` (size `input.length * 2`). */
  hexEncode(input: Uint8Array): Uint8Array
  /** Lowercase-hex encode into `output`; returns bytes written. */
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number
  /** RFC 3986 percent-encode into a fresh buffer (size `input.length * 3`). */
  urlEncode(input: Uint8Array): Uint8Array
  /** RFC 3986 percent-encode into `output`; returns bytes written. */
  urlEncodeInto(input: Uint8Array, output: Uint8Array): number

  // ── Validators (u8 → boolean) ─────────────────────────────────────
  validateEmail(input: Uint8Array): boolean
  validateUuid(input: Uint8Array): boolean
  validateIpv4(input: Uint8Array): boolean
  validateIpv6(input: Uint8Array): boolean
  /** Sum of `id` fields across a JSON array → bigint (throws on non-array input). */
  jsonSumIds(input: Uint8Array): bigint

  // ── Constant-time verify (u8 → boolean) ───────────────────────────
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean
  passwordVerifyBcrypt(password: Uint8Array, phc: Uint8Array): boolean

  // ── Decoders (throw on malformed input — napi `Result` parity) ──
  /** Hex-decode into a fresh buffer (size `input.length / 2`). */
  hexDecode(input: Uint8Array): Uint8Array
  /** Hex-decode into `output`; returns bytes written (throws if too small). */
  hexDecodeInto(input: Uint8Array, output: Uint8Array): number
  /** Percent-decode into a fresh buffer (size `input.length`). */
  urlDecode(input: Uint8Array): Uint8Array
  /** Percent-decode into `output`; returns bytes written (throws if too small). */
  urlDecodeInto(input: Uint8Array, output: Uint8Array): number
  /** base64-decode into a fresh buffer (size `ceil(len/4)*3`). */
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array
  /** base64-decode into `output`; returns bytes written (throws if too small). */
  base64DecodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number

  // ── Fixed-size output writers ─────────────────────────────────────
  /** RFC 6455 Sec-WebSocket-Accept (28 bytes) into a fresh buffer. */
  wsAcceptKey(key: Uint8Array): Uint8Array
  /** crc32 ETag (10 strong / 12 weak bytes) into a fresh buffer. */
  etag(data: Uint8Array, weak?: boolean): Uint8Array
  /** crc32 ETag into `output`; returns bytes written. */
  etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number
  /** `byteLen` random bytes → `byteLen * 2` hex chars. */
  randomToken(byteLen: number): Uint8Array
  /** base64-encode into a fresh buffer (size `ceil(len/3)*4`). */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array
  /** base64-encode into `output`; returns bytes written. */
  base64EncodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number
  /** HMAC-SHA256 hex (64 chars) into a fresh buffer. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array
  /** HMAC-SHA256 hex into `output`; returns bytes written (throws if too small). */
  hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number
  /** Sign cookie `value` as `value.<64-hex>` into a fresh buffer. */
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array
  /** Sign cookie into `output`; returns bytes written (throws if too small). */
  signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number
  /** Verify a signed cookie → value bytes, or `null` on bad signature. */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null
  /** CSRF token (129 bytes: 64 rnd-hex + '.' + 64 sig-hex). */
  csrfToken(secret: Uint8Array): Uint8Array
  /** Argon2id PHC hash bytes (m/t/p/out_len params). */
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    mCost: number,
    tCost: number,
    pCost: number,
    outLen: number,
  ): Uint8Array
  /** bcrypt `$2b$` PHC string bytes (cost clamped 4..=31). */
  passwordHashBcrypt(password: Uint8Array, cost: number): Uint8Array
  /** PBKDF2-HMAC-SHA256 → `dkLen` bytes (rounds, dkLen clamped). */
  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, rounds: number, dkLen: number): Uint8Array
  /** AEAD encrypt (0 = AES-256-GCM, 1 = ChaCha20-Poly1305) → ct+tag. */
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm?: number,
  ): Uint8Array
  /** AEAD encrypt into `output` (ct + 16-byte tag); returns bytes written. */
  aeadEncryptInto(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    output: Uint8Array,
    algorithm?: number,
  ): number
  /** AEAD decrypt → plaintext, or `null` on auth failure. */
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm?: number,
  ): Uint8Array | null

  // ── Frame / patch / compression (variable-size → grow-retry) ─────
  /** RFC 6455 frame encode into a fresh buffer. */
  wsFrameEncode(opcode: number, payload: Uint8Array, mask: boolean, fin: boolean): Uint8Array
  /** RFC 6455 frame encode into `output`; returns bytes written (throws if too small). */
  wsFrameEncodeInto(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
    output: Uint8Array,
  ): number
  /** RFC 6902 JSON patch into a fresh buffer. */
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array
  /** gzip-compress into a fresh buffer (level clamped 0..=9, default 6). */
  gzipCompress(data: Uint8Array, level?: number): Uint8Array
  /** gzip-compress into `output`; returns bytes written (throws if too small). */
  gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number): number
  /** gzip-decompress into a fresh buffer (capped by `maxDecompressed`). */
  gzipDecompress(data: Uint8Array, maxDecompressed?: number): Uint8Array
  /** brotli-compress into a fresh buffer (quality clamped 0..=11, default 5). */
  brotliCompress(data: Uint8Array, quality?: number): Uint8Array
  /** brotli-compress into `output`; returns bytes written (throws if too small). */
  brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number): number
  /** brotli-decompress into a fresh buffer (capped by `maxDecompressed`). */
  brotliDecompress(data: Uint8Array, maxDecompressed?: number): Uint8Array

  // ── Packed parsers (into caller buffers) ─────────────────────────
  /** HTTP request parse → packed output into `output`; returns bytes written. */
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number
  /** Query string parse → packed output into `output`; returns bytes written. */
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /** Cookie header parse → packed output into `output`; returns bytes written. */
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number

  // ── Excluded-surface additions (packed / opaque-handle) ─────────
  /** Sign JWT (HS256) from pre-serialized claim JSON (ttl<=0 → no iat/exp). */
  jwtSignBytes(claimsJson: Uint8Array, secret: Uint8Array, ttl: number, now: number): Uint8Array
  /** Decode a WS frame into packed `[flags][opcode][u32 len][payload]`; null on malformed. */
  wsFrameDecodePacked(data: Uint8Array): Uint8Array | null
  /** Parse multipart/form-data into the packed parts layout. */
  multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array
  /** Parse x-www-form-urlencoded into packed pairs into `output`. */
  formParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Run the ingress pipeline on a packed frame via the opaque inner handle from
   * `Ingress.ingressInnerPtr()` (valid only while the instance is alive — the
   * caller must hold it). Returns bytes written; throws on error / too-small.
   */
  ingressHandlePacked(
    inner: number,
    input: Uint8Array,
    body: Uint8Array | null,
    output: Uint8Array,
  ): number
  /**
   * Write the ingress binary-layout constants (38 × u32 LE — `rust/ffi.rs`
   * `IngressLayout`, numeric source `rust/ingress/output.rs`) into `output`;
   * returns bytes written. Lets `src/ingress/constants.ts` read the layout via
   * bun:ffi on Bun so importing the package does NOT dlopen the napi addon.
   */
  ingressLayout(out: Uint8Array): number
}

// ── Caps mirrored from the Rust napi layer ────────────────────────
// rust/payload/compress.rs DEFAULT_MAX_DECOMPRESSED (64 MiB decompression bomb
// guard — must stay in sync; do not raise without benchmarking).
const MAX_DECOMPRESSED = 64 * 1024 * 1024
// rust/json/json_patch_ops.rs MAX_JSON_PATCH_OUTPUT (128 MiB).
const MAX_JSON_PATCH_OUTPUT = 128 * 1024 * 1024

// ── Output-buffer sizing heuristics (measured) ─────────────────────
// These are ALLOCATION caps only, not correctness bounds: `growExact` covers
// any residual miss with at most one exact-size retry (no re-run loop), so a
// guess that is too small costs one extra native pass, never a wrong result.
//
// Compress: a 75 KiB input compresses to <1 KiB, so a 16 KiB initial is
// plenty and single-pass; the 1 MiB ceiling bounds incompressible data.
const COMPRESS_INITIAL_CAP = 16 * 1024
const COMPRESS_MAX_CAP = 1024 * 1024
const COMPRESS_HEADROOM = 64 // small-input slack above `data.length`
// Decompress (no trailer / expensive trailer): typical JSON/text ratios.
const DECOMPRESS_GUESS_MULTIPLIER_GZIP = 16
const DECOMPRESS_GUESS_MULTIPLIER_BROTLI = 32
const DECOMPRESS_FALLBACK_CAP = 4 * 1024 * 1024 // 4 MiB over-alloc bound
const DECOMPRESS_MIN_INITIAL = 1024
// JWT: token ≈ header(~36) + payload(≈4/3× claims) + sig(~43) + 2 dots. The
// old `claims.length + 128` under-sized a typical token (measured 168 B for a
// 30 B claim → grow-retry double-run, making ffi slower than napi). 2×+128
// with a 256-byte floor covers typical claims in one pass.
const JWT_INITIAL_MULTIPLIER = 2
const JWT_INITIAL_EXTRA = 128
const JWT_INITIAL_FLOOR = 256

// ── Known-good vectors for the bind-time self-test ───────────────
// These mirror the Rust `#[cfg(test)]` vectors in rust/ffi.rs.
const SELFTEST_HEX = encoder.encode('hello') // -> 68656c6c6f
const SELFTEST_JSON = encoder.encode('{"a":1}')

// Empty view for `null` body slots in (ptr, len) pairs — the C side treats
// len 0 as "no body" regardless of the pointer value.
const EMPTY_VIEW = new Uint8Array(0)

let cached: BunFFI | null | undefined

// ── Transport selection (CASTRUM_FFI_MODE) ───────────────────────
// auto  (default): use bun:ffi on Bun, silently fall back to napi when the
//                  bind or self-test fails (and always on Node).
// ffi   : force bun:ffi on Bun — throw a clear error if it can't bind or the
//                  self-test fails (use in benches/CI that MUST run ffi).
// napi  : never bind — every call goes through the napi addon (the fallback;
//                  useful for exercising the fallback path on Bun).
// The legacy alias `RUST_FFI_MODE` is accepted too (see src/shared/env.ts).
export type FfiMode = 'auto' | 'ffi' | 'napi'

function resolveFfiMode(): FfiMode {
  const raw = resolveEnvVar('CASTRUM_FFI_MODE', ['RUST_FFI_MODE'])
  switch (raw) {
    case 'ffi':
      return 'ffi'
    case 'napi':
      return 'napi'
    default:
      return 'auto'
  }
}

/**
 * Lazily bind the Bun ffi fast path, or return `null` when unavailable
 * (Node, `CASTRUM_FFI_MODE=napi`, missing symbols, or a failed self-test).
 * `undefined` caches "not yet attempted".
 *
 * Under `CASTRUM_FFI_MODE=ffi` a bind/self-test failure THROWS instead of
 * returning null — the caller asked for the primary transport explicitly.
 */
export function getBunFFI(): BunFFI | null {
  if (cached !== undefined) {
    return cached
  }
  cached = bind()
  return cached
}

/**
 * Probe whether this Bun build accepts the `buffer`/`buffer_length` ABI pair in
 * `dlopen`. Bun's docs list `buffer_length` as engine-native (dlopen-supported),
 * but an earlier canary threw "invalid ABI type" for it. If that regressed (or
 * a future Bun removes it), we silently keep explicit `(ptr, len)` pairs. The
 * full bind-time self-test is the safety net either way.
 */
function probeBufferLength(dlopen: typeof import('bun:ffi')['dlopen'], path: string): boolean {
  try {
    const { symbols, close } = dlopen(path, {
      // bun-types lacks the `buffer_length` literal — cast it; runtime support
      // is exactly what this probe is verifying.
      castrum_crc32: {
        args: ['buffer', 'buffer_length'] as unknown as readonly FFITypeOrString[],
        returns: 'u32',
      },
    })
    // `buffer_length` is `buffer`'s length twin — pass the SAME view twice
    // (the engine reads ptr + byteLength off that object at call time).
    const view = new Uint8Array([1, 2, 3])
    const out = (symbols as Record<string, (a: unknown, b: unknown) => unknown>).castrum_crc32?.(
      view,
      view,
    )
    close()
    return typeof out === 'number' && out >= 0
  } catch {
    return false
  }
}

function bind(): BunFFI | null {
  const mode = resolveFfiMode()
  if (!isBun()) {
    if (mode === 'ffi') {
      throw new Error(
        'CASTRUM_FFI_MODE=ffi is invalid here: bun:ffi is a Bun-only transport ' +
          '(this process is not Bun). Use CASTRUM_FFI_MODE=auto (default) so Node ' +
          'uses the napi fallback.',
      )
    }
    return null
  }
  if (mode === 'napi') {
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen } = require('bun:ffi') as typeof import('bun:ffi')
    // Resolve the SAME addon file napi uses (./loader.ts — statically imported
    // above; it only resolves the path, it never dlopens the addon).
    const path = getAddonPath()

    // Probe `buffer`/`buffer_length` (the engine reads ptr + len off the SAME
    // TypedArray at call time — an atomic snapshot) once; when supported we use
    // it for the input-only hot fns (one JS arg instead of two), else `(ptr,len)`.
    const useBufferLength = probeBufferLength(dlopen, path)

    // String ABI specs ("ptr"/"usize"/"u32"...): accepted by bun:ffi and typed
    // via `FFITypeOrString` in bun-types. usize == uint64 on the host ABI.
    // Symbol keys must be the exact `#[no_mangle] extern "C"` names in
    // rust/ffi.rs. Every `(ptr,len)` pair is passed as `(view, view.length)`.
    // The 8 input-only single-buffer fns use `inputAbi`; everything else keeps
    // `(ptr,len)` because the output length is the caller's write cap.
    const inputAbi: readonly FFITypeOrString[] = useBufferLength
      ? (['buffer', 'buffer_length'] as unknown as readonly FFITypeOrString[])
      : ['ptr', 'usize']
    const { symbols } = dlopen(path, {
      castrum_crc32: { args: inputAbi, returns: 'u32' },
      castrum_fnv1a64: { args: inputAbi, returns: 'u64' },
      castrum_xxh3: { args: inputAbi, returns: 'u64' },
      castrum_json_valid: { args: inputAbi, returns: 'u8' },
      castrum_hex_encode: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_hex_decode: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_url_encode: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_url_decode: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_validate_email: { args: inputAbi, returns: 'u8' },
      castrum_validate_uuid: { args: inputAbi, returns: 'u8' },
      castrum_validate_ipv4: { args: inputAbi, returns: 'u8' },
      castrum_validate_ipv6: { args: inputAbi, returns: 'u8' },
      castrum_json_sum_ids: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_hmac_sha256_verify: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'u8',
      },
      castrum_csrf_verify: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'u8' },
      castrum_password_verify: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'u8' },
      castrum_password_verify_bcrypt: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'u8' },
      castrum_ws_accept_key: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_etag: { args: ['ptr', 'usize', 'ptr', 'usize', 'u8'], returns: 'usize' },
      castrum_random_token: { args: ['u32', 'ptr', 'usize'], returns: 'usize' },
      castrum_base64_encode: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'u8', 'u8'],
        returns: 'usize',
      },
      castrum_base64_decode: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'u8', 'u8'],
        returns: 'usize',
      },
      castrum_hmac_sha256: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_sign_cookie: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_verify_cookie: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_csrf_token: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_password_hash: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'u32', 'u32', 'u32', 'u32', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_password_hash_bcrypt: {
        args: ['ptr', 'usize', 'u32', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_pbkdf2_sha256: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'u32', 'u32', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_aead_encrypt: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize', 'u8', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_aead_decrypt: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize', 'u8', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_ws_frame_encode: {
        args: ['u8', 'ptr', 'usize', 'u8', 'u8', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_json_patch: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_gzip_compress: { args: ['ptr', 'usize', 'u32', 'ptr', 'usize'], returns: 'usize' },
      castrum_gzip_decompress: {
        args: ['ptr', 'usize', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_brotli_compress: { args: ['ptr', 'usize', 'u32', 'ptr', 'usize'], returns: 'usize' },
      castrum_brotli_decompress: {
        args: ['ptr', 'usize', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_gzip_isize: { args: ['ptr', 'usize'], returns: 'u32' },
      castrum_http_parse_request_packed: {
        args: ['ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_query_parse_packed: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_cookie_parse_packed: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      // ── Excluded-surface additions ──
      castrum_jwt_sign_bytes: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'i64', 'i64', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_ws_frame_decode_packed: {
        args: ['ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_multipart_parse_packed: {
        args: ['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_form_parse_packed: { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'usize' },
      castrum_ingress_handle_packed: {
        args: ['usize', 'ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize'],
        returns: 'usize',
      },
      castrum_ingress_layout: { args: ['ptr', 'usize'], returns: 'usize' },
    })

    const bindings = build(symbols as Record<string, (...a: unknown[]) => unknown>, useBufferLength)
    if (!selfTest(bindings)) {
      if (mode === 'ffi') {
        throw new Error(
          'CASTRUM_FFI_MODE=ffi: the bun:ffi bind-time self-test failed, so the ' +
            'primary transport cannot be trusted on this Bun/addon combination. ' +
            'Unset CASTRUM_FFI_MODE (or use CASTRUM_FFI_MODE=auto) to fall back to napi.',
        )
      }
      return null
    }
    return bindings
  } catch (err) {
    if (mode === 'ffi') {
      const cause = err instanceof Error ? `: ${err.message}` : ''
      throw new Error(`CASTRUM_FFI_MODE=ffi: failed to bind bun:ffi${cause}`)
    }
    return null
  }
}

// Types for the raw dlopen'd functions (bun:ffi converts Uint8Array -> ptr for
// `ptr` args; `usize`/`u64`/`i64` returns surface as BigInt).
type Raw2 = (a: unknown, b: unknown) => number | bigint
type Raw3 = (a: unknown, b: unknown, c: unknown) => number | bigint
type Raw4 = (a: unknown, b: unknown, c: unknown, d: unknown) => number | bigint
type Raw5 = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown) => number | bigint
type Raw6 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
) => number | bigint
type Raw7 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
) => number | bigint
type Raw8 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
  h: unknown,
) => number | bigint
type Raw9 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
  h: unknown,
  i: unknown,
) => number | bigint
type Raw10 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
  h: unknown,
  i: unknown,
  j: unknown,
) => number | bigint

const flag = (v?: boolean): number => (v ? 1 : 0)

/**
 * Write with the C ABI's "needed" convention. The C side returns the EXACT
 * total bytes the result requires: `0` = real error (throw immediately — no
 * re-run, no grow-to-max allocation storm on invalid input), `w > out.length`
 * = buffer too small with `w` the exact required size (allocate once, retry),
 * else `w` is the written count. A miss therefore costs at most ONE retry with
 * an exact buffer — never a doubling loop that re-runs the whole native op
 * (which is what made FFI gzip/brotli/jsonPatch slower than napi).
 */
function growExact(
  write: (out: Uint8Array) => number,
  initial: number,
  max: number,
  error: string,
): Uint8Array {
  let cap = Math.min(Math.max(initial, 16), max)
  for (;;) {
    const out = new Uint8Array(cap)
    const w = Number(write(out))
    if (w === 0) throw new Error(error)
    if (w <= out.length) return out.subarray(0, w)
    if (w > max) throw new Error(error)
    cap = Math.min(w, max)
  }
}

/** Decoder parity: a `0` write on non-empty input throws (napi `Result`). */
function writeOrThrow(w: number, inputLen: number, label: string): number {
  if (w === 0 && inputLen !== 0) {
    throw new Error(`${label}: invalid input or output buffer too small`)
  }
  return w
}

/** base64 (no-pad) length of `n` bytes. */
const b64Len = (n: number): number => (n === 0 ? 0 : Math.ceil(n / 3) * 4 - ((3 - (n % 3)) % 3))

/**
 * Exact length of an argon2id PHC string for the given params (m/t/p/out_len).
 * Format: `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<22-char salt b64>$<hash b64>`.
 * The salt is always 16 bytes → 22 base64 chars (SaltString::encode_b64).
 * Pre-sizing exactly makes `passwordHash` a single native pass instead of a
 * grow-retry (which would re-run the whole ~tens-of-ms hash on a miss).
 */
function argon2PhcLength(m: number, t: number, p: number, outLen: number): number {
  return (
    15 + // "$argon2id$v=19$"
    2 + // "m="
    String(m).length +
    3 + // ",t="
    String(t).length +
    3 + // ",p="
    String(p).length +
    1 + // "$" before the salt
    22 + // salt b64 (16 bytes)
    1 + // "$" before the hash
    b64Len(outLen)
  )
}

function build(
  sym: Record<string, (...a: unknown[]) => unknown>,
  useBufferLength: boolean,
): BunFFI {
  const crc32 = sym.castrum_crc32 as (...a: unknown[]) => number | bigint
  const fnv = sym.castrum_fnv1a64 as (...a: unknown[]) => number | bigint
  const xxh = sym.castrum_xxh3 as (...a: unknown[]) => number | bigint
  const jsonValid = sym.castrum_json_valid as (...a: unknown[]) => number | bigint
  const hexEncode = sym.castrum_hex_encode as Raw4
  const hexDecode = sym.castrum_hex_decode as Raw4
  const urlEncode = sym.castrum_url_encode as Raw4
  const urlDecode = sym.castrum_url_decode as Raw4
  const validateEmail = sym.castrum_validate_email as (...a: unknown[]) => number | bigint
  const validateUuid = sym.castrum_validate_uuid as (...a: unknown[]) => number | bigint
  const validateIpv4 = sym.castrum_validate_ipv4 as (...a: unknown[]) => number | bigint
  const validateIpv6 = sym.castrum_validate_ipv6 as (...a: unknown[]) => number | bigint
  const jsonSumRaw = sym.castrum_json_sum_ids as Raw4

  // Single-buffer input fns: with the probe-gated `buffer/buffer_length` ABI the
  // engine reads ptr + byteLength off the SAME TypedArray at call time (an
  // atomic snapshot — pass the view twice, per Bun's docs); with `(ptr,len)` we
  // pass the length explicitly. The branch is on a bind-time constant, so the
  // JIT folds it away at the call site.
  const oneArg = (raw: (...a: unknown[]) => number | bigint, v: Uint8Array): number | bigint =>
    useBufferLength ? raw(v, v) : raw(v, v.length)
  const hmacVerify = sym.castrum_hmac_sha256_verify as Raw6
  const csrfVerify = sym.castrum_csrf_verify as Raw4
  const passwordVerify = sym.castrum_password_verify as Raw4
  const passwordVerifyBcrypt = sym.castrum_password_verify_bcrypt as Raw4
  const wsAcceptKey = sym.castrum_ws_accept_key as Raw4
  const etag = sym.castrum_etag as Raw5
  const randomToken = sym.castrum_random_token as Raw3
  const base64Encode = sym.castrum_base64_encode as Raw6
  const base64Decode = sym.castrum_base64_decode as Raw6
  const hmacSha256 = sym.castrum_hmac_sha256 as Raw6
  const signCookie = sym.castrum_sign_cookie as Raw6
  const verifyCookie = sym.castrum_verify_cookie as Raw6
  const csrfToken = sym.castrum_csrf_token as Raw4
  const passwordHash = sym.castrum_password_hash as Raw10
  const passwordHashBcrypt = sym.castrum_password_hash_bcrypt as Raw5
  const pbkdf2 = sym.castrum_pbkdf2_sha256 as Raw8
  const aeadEncrypt = sym.castrum_aead_encrypt as Raw9
  const aeadDecrypt = sym.castrum_aead_decrypt as Raw9
  const wsFrameEncode = sym.castrum_ws_frame_encode as Raw7
  const jsonPatch = sym.castrum_json_patch as Raw6
  const gzipCompress = sym.castrum_gzip_compress as Raw5
  const gzipDecompress = sym.castrum_gzip_decompress as Raw5
  const brotliCompress = sym.castrum_brotli_compress as Raw5
  const brotliDecompress = sym.castrum_brotli_decompress as Raw5
  const gzipIsize = sym.castrum_gzip_isize as Raw2
  const httpParsePacked = sym.castrum_http_parse_request_packed as Raw4
  const queryParsePacked = sym.castrum_query_parse_packed as Raw4
  const cookieParsePacked = sym.castrum_cookie_parse_packed as Raw4
  const jwtSignBytes = sym.castrum_jwt_sign_bytes as Raw8
  const wsFrameDecodePacked = sym.castrum_ws_frame_decode_packed as Raw4
  const multipartParsePacked = sym.castrum_multipart_parse_packed as Raw6
  const formParsePacked = sym.castrum_form_parse_packed as Raw4
  const ingressHandlePacked = sym.castrum_ingress_handle_packed as Raw7
  const ingressLayoutSym = sym.castrum_ingress_layout as Raw2

  // ── Encoder / decoder `Into` helpers ──────────────────────────────
  const hexEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    // Mirror napi error semantics: a too-small buffer throws, not returns 0.
    // Hex encode always writes exactly `input.length * 2` bytes on success.
    if (output.length < input.length * 2) {
      throw new Error('hex encode: output buffer too small')
    }
    return Number(hexEncode(input, input.length, output, output.length))
  }

  const urlEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlEncode(input, input.length, output, output.length))
    // Every input byte encodes to >= 1 output byte, so a 0 write on non-empty
    // input means the buffer was too small (napi throws there too). Empty
    // input legitimately writes 0.
    if (w === 0 && input.length !== 0) {
      throw new Error('url encode: output buffer too small')
    }
    return w
  }

  const hexDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(hexDecode(input, input.length, output, output.length))
    return writeOrThrow(w, input.length, 'hex decode')
  }

  const urlDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlDecode(input, input.length, output, output.length))
    return writeOrThrow(w, input.length, 'url decode')
  }

  const base64DecodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true (rust/crypto/base64.rs).
    const w = Number(
      base64Decode(
        input,
        input.length,
        output,
        output.length,
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    return writeOrThrow(w, input.length, 'base64 decode')
  }

  const base64EncodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true.
    const w = Number(
      base64Encode(
        input,
        input.length,
        output,
        output.length,
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    // Empty input legitimately writes 0 bytes — only a 0 write on NON-empty
    // input is a real error (same convention as the decode/etag paths).
    return writeOrThrow(w, input.length, 'base64 encode')
  }

  const etagInto = (data: Uint8Array, output: Uint8Array, weak?: boolean): number => {
    const w = Number(etag(data, data.length, output, output.length, flag(weak)))
    if (w === 0 && data.length !== 0) {
      throw new Error('etag: output buffer too small')
    }
    return w
  }

  return {
    crc32: (input) => Number(oneArg(crc32, input)) >>> 0,
    fnv1a64: (input) => BigInt(oneArg(fnv, input)),
    xxh3: (input) => BigInt(oneArg(xxh, input)),
    jsonValid: (input) => Number(oneArg(jsonValid, input)) === 1,
    hexEncode(input) {
      const out = new Uint8Array(input.length * 2)
      const w = hexEncodeInto(input, out)
      return w === input.length * 2 ? out : out.subarray(0, w)
    },
    hexEncodeInto,
    urlEncode(input) {
      // RFC 3986 worst case is 3 bytes per input byte (`%XX`).
      const out = new Uint8Array(input.length * 3)
      const w = urlEncodeInto(input, out)
      return out.subarray(0, w)
    },
    urlEncodeInto,

    validateEmail: (input) => Number(oneArg(validateEmail, input)) === 1,
    validateUuid: (input) => Number(oneArg(validateUuid, input)) === 1,
    validateIpv4: (input) => Number(oneArg(validateIpv4, input)) === 1,
    validateIpv6: (input) => Number(oneArg(validateIpv6, input)) === 1,
    jsonSumIds: (input) => {
      // Packed [u8 ok][i64 sum LE] output (9 B): ok=1 → valid array (the sum
      // may be 0); ok=0 → invalid input. Bytes written: 9/1/0 (0 = real error).
      const out = new Uint8Array(9)
      const w = Number(jsonSumRaw(input, input.length, out, out.length))
      if (w === 0) {
        throw new Error('json sum ids: output buffer too small')
      }
      if (out[0] === 0) {
        // Mirrors the napi error phrasing (serde: "expected an array of objects
        // with numeric ids") so both transports throw the same message.
        throw new Error('json sum ids: expected an array of objects with numeric ids')
      }
      return new DataView(out.buffer, out.byteOffset, out.byteLength).getBigInt64(1, true)
    },
    hmacSha256Verify: (key, data, signature) =>
      Number(hmacVerify(key, key.length, data, data.length, signature, signature.length)) === 1,
    csrfVerify: (token, secret) =>
      Number(csrfVerify(token, token.length, secret, secret.length)) === 1,
    passwordVerify: (password, phc) =>
      Number(passwordVerify(password, password.length, phc, phc.length)) === 1,
    passwordVerifyBcrypt: (password, phc) =>
      Number(passwordVerifyBcrypt(password, password.length, phc, phc.length)) === 1,

    hexDecode(input) {
      const out = new Uint8Array(Math.floor(input.length / 2))
      const w = hexDecodeInto(input, out)
      return out.subarray(0, w)
    },
    hexDecodeInto,
    urlDecode(input) {
      const out = new Uint8Array(input.length)
      const w = urlDecodeInto(input, out)
      return out.subarray(0, w)
    },
    urlDecodeInto,
    base64Decode(input, urlSafe, padding) {
      const out = new Uint8Array(Math.ceil((input.length * 3) / 4))
      const w = base64DecodeInto(input, out, urlSafe, padding)
      return out.subarray(0, w)
    },
    base64DecodeInto,

    wsAcceptKey(key) {
      const out = new Uint8Array(28)
      const w = Number(wsAcceptKey(key, key.length, out, out.length))
      if (w === 0) {
        throw new Error('ws accept key: bad key or output buffer too small')
      }
      return out.subarray(0, w)
    },
    etag(data, weak) {
      const out = new Uint8Array(12)
      const w = etagInto(data, out, weak)
      return out.subarray(0, w)
    },
    etagInto,
    randomToken(byteLen) {
      const out = new Uint8Array(byteLen * 2)
      const w = Number(randomToken(byteLen, out, out.length))
      // byteLen 0 legitimately yields an empty token (napi returns empty too);
      // any other 0 is a real error (buffer too small / random source failed).
      if (w === 0 && byteLen !== 0) {
        throw new Error('random token: output buffer too small or random source failed')
      }
      return out.subarray(0, w)
    },
    base64Encode(input, urlSafe, padding) {
      const out = new Uint8Array(Math.ceil(input.length / 3) * 4)
      const w = base64EncodeInto(input, out, urlSafe, padding)
      return out.subarray(0, w)
    },
    base64EncodeInto,
    hmacSha256(key, data) {
      const out = new Uint8Array(64)
      const w = Number(hmacSha256(key, key.length, data, data.length, out, out.length))
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return out.subarray(0, w)
    },
    hmacSha256Into(key, data, output) {
      if (output.length < 64) {
        throw new Error('hmac sha256: output buffer too small')
      }
      const w = Number(hmacSha256(key, key.length, data, data.length, output, output.length))
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return w
    },
    signCookie(value, secret) {
      // `value.<64-hex>` → value.length + 1 + 64.
      const out = new Uint8Array(value.length + 65)
      const w = Number(signCookie(value, value.length, secret, secret.length, out, out.length))
      if (w === 0) {
        throw new Error('sign cookie: output buffer too small')
      }
      return out.subarray(0, w)
    },
    signCookieInto(value, secret, output) {
      const need = value.length + 65
      if (output.length < need) {
        throw new Error('sign cookie: output buffer too small')
      }
      const w = Number(
        signCookie(value, value.length, secret, secret.length, output, output.length),
      )
      if (w === 0) {
        throw new Error('sign cookie: output buffer too small')
      }
      return w
    },
    verifyCookie(signed, secret) {
      const out = new Uint8Array(signed.length)
      const w = Number(verifyCookie(signed, signed.length, secret, secret.length, out, out.length))
      return w === 0 ? null : out.subarray(0, w)
    },
    csrfToken(secret) {
      const out = new Uint8Array(129)
      const w = Number(csrfToken(secret, secret.length, out, out.length))
      if (w === 0) {
        throw new Error('csrf token: output buffer too small or random source failed')
      }
      return out.subarray(0, w)
    },
    passwordHash(password, salt, mCost, tCost, pCost, outLen) {
      // Pre-size with the EXACT PHC string length (computable from the params),
      // so the hash runs once — a grow-retry would re-run the whole argon2
      // hash on a miss. growExact remains the safety net.
      return growExact(
        (out) =>
          Number(
            passwordHash(
              password,
              password.length,
              salt,
              salt.length,
              mCost,
              tCost,
              pCost,
              outLen,
              out,
              out.length,
            ),
          ),
        argon2PhcLength(mCost, tCost, pCost, outLen),
        2 * 1024 * 1024,
        'password hash: output buffer too small',
      )
    },
    passwordHashBcrypt(password, cost) {
      // `$2b$CC$` + 22 salt chars + 31 hash chars = 60 chars.
      const out = new Uint8Array(64)
      const w = Number(passwordHashBcrypt(password, password.length, cost, out, out.length))
      if (w === 0) {
        throw new Error('password hash bcrypt: output buffer too small')
      }
      return out.subarray(0, w)
    },
    pbkdf2Sha256(password, salt, rounds, dkLen) {
      // Rust clamps dkLen to [1, 1MiB] (PBKDF2_MIN_LEN/MAX_LEN) AFTER sizing its
      // own buffer — so pre-clamp here so dkLen 0 still yields a 1-byte result.
      const dk = Math.min(Math.max(dkLen, 1), 1024 * 1024)
      const out = new Uint8Array(dk)
      const w = Number(
        pbkdf2(password, password.length, salt, salt.length, rounds, dkLen, out, out.length),
      )
      if (w === 0) {
        throw new Error('pbkdf2: output buffer too small')
      }
      return out.subarray(0, w)
    },
    aeadEncrypt(key, nonce, plaintext, algorithm = 0) {
      // ciphertext + 16-byte auth tag.
      const out = new Uint8Array(plaintext.length + 16)
      const w = Number(
        aeadEncrypt(
          key,
          key.length,
          nonce,
          nonce.length,
          plaintext,
          plaintext.length,
          algorithm,
          out,
          out.length,
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return out.subarray(0, w)
    },
    aeadEncryptInto(key, nonce, plaintext, output, algorithm = 0) {
      const need = plaintext.length + 16
      if (output.length < need) {
        throw new Error('aead encrypt: output buffer too small')
      }
      const w = Number(
        aeadEncrypt(
          key,
          key.length,
          nonce,
          nonce.length,
          plaintext,
          plaintext.length,
          algorithm,
          output,
          output.length,
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return w
    },
    aeadDecrypt(key, nonce, ciphertext, algorithm = 0) {
      const out = new Uint8Array(ciphertext.length)
      const w = Number(
        aeadDecrypt(
          key,
          key.length,
          nonce,
          nonce.length,
          ciphertext,
          ciphertext.length,
          algorithm,
          out,
          out.length,
        ),
      )
      return w === 0 ? null : out.subarray(0, w)
    },

    wsFrameEncode(opcode, payload, mask, fin) {
      // Header (max 10) + payload + mask key (4).
      const out = new Uint8Array(payload.length + 14)
      const w = Number(
        wsFrameEncode(opcode, payload, payload.length, flag(mask), flag(fin), out, out.length),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return out.subarray(0, w)
    },
    wsFrameEncodeInto(opcode, payload, mask, fin, output) {
      // Header (max 10) + payload + mask key (4).
      const need = payload.length + 14
      if (output.length < need) {
        throw new Error('ws frame encode: output buffer too small')
      }
      const w = Number(
        wsFrameEncode(
          opcode,
          payload,
          payload.length,
          flag(mask),
          flag(fin),
          output,
          output.length,
        ),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return w
    },
    jsonPatch(doc, patch) {
      return growExact(
        (out) => Number(jsonPatch(doc, doc.length, patch, patch.length, out, out.length)),
        Math.min(Math.max(doc.length, patch.length) + 16, 64 * 1024),
        MAX_JSON_PATCH_OUTPUT,
        'json patch: output buffer too small or patch inapplicable',
      )
    },
    gzipCompress(data, level = 6) {
      // The C ABI streams the compressed output directly into `out` (no internal
      // Vec — see rust/payload/compress.rs gzip_compress_into). Cap the initial
      // so large compressible inputs don't pay a full-size allocation (measured:
      // a 75 KiB input compressed to <1 KiB — COMPRESS_INITIAL_CAP is plenty and
      // single-pass). growExact handles incompressible data with at most one
      // exact retry (no re-run loop).
      return growExact(
        (out) => Number(gzipCompress(data, data.length, Math.min(level, 9), out, out.length)),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'gzip compress: output buffer too small',
      )
    },
    gzipCompressInto(data, output, level = 6) {
      const w = Number(gzipCompress(data, data.length, Math.min(level, 9), output, output.length))
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('gzip compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('gzip compress: output buffer too small')
      }
      return w
    },
    gzipDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Pre-size from the gzip ISIZE trailer via the C probe (exact for
      // single-member streams) so the happy path is a single native pass; fall
      // back to a multiplier guess. growExact handles any residual miss with
      // one exact retry, and invalid input throws immediately (no 64 MiB
      // grow-to-max allocation storm).
      const isize = Number(gzipIsize(data, data.length))
      const initial =
        isize !== 0
          ? Math.min(isize, max)
          : Math.min(data.length * DECOMPRESS_GUESS_MULTIPLIER_GZIP, DECOMPRESS_FALLBACK_CAP)
      return growExact(
        (out) => Number(gzipDecompress(data, data.length, max, out, out.length)),
        initial,
        max,
        'gzip decompress: invalid stream or exceeded max decompressed size',
      )
    },
    brotliCompress(data, quality = 5) {
      // Same cap rationale as gzipCompress (streaming core); growExact for
      // incompressible data.
      return growExact(
        (out) => Number(brotliCompress(data, data.length, Math.min(quality, 11), out, out.length)),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'brotli compress: output buffer too small',
      )
    },
    brotliCompressInto(data, output, quality = 5) {
      const w = Number(
        brotliCompress(data, data.length, Math.min(quality, 11), output, output.length),
      )
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('brotli compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('brotli compress: output buffer too small')
      }
      return w
    },
    brotliDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Brotli has no cheap trailer size: DECOMPRESS_GUESS_MULTIPLIER_BROTLI×
      // initial covers typical JSON/text ratios (~10-30x) while the fallback
      // cap bounds over-allocation on large streams; growExact handles
      // higher-ratio streams with one exact retry.
      return growExact(
        (out) => Number(brotliDecompress(data, data.length, max, out, out.length)),
        Math.min(
          Math.max(data.length * DECOMPRESS_GUESS_MULTIPLIER_BROTLI, DECOMPRESS_MIN_INITIAL),
          DECOMPRESS_FALLBACK_CAP,
        ),
        max,
        'brotli decompress: invalid stream or exceeded max decompressed size',
      )
    },

    httpParseRequestPackedInto(input, output) {
      const w = Number(httpParsePacked(input, input.length, output, output.length))
      if (w === 0 && input.length !== 0) {
        throw new Error('http parse: output buffer too small or malformed request')
      }
      return w
    },
    queryParsePackedInto(input, output) {
      const w = Number(queryParsePacked(input, input.length, output, output.length))
      if (w === 0 && input.length !== 0) {
        throw new Error('query parse: output buffer too small')
      }
      return w
    },
    cookieParsePackedInto(input, output) {
      const w = Number(cookieParsePacked(input, input.length, output, output.length))
      if (w === 0 && input.length !== 0) {
        throw new Error('cookie parse: output buffer too small')
      }
      return w
    },

    // ── Excluded-surface additions ──────────────────────────────────
    jwtSignBytes(claimsJson, secret, ttl, now) {
      // Token = header(~36) + payload (claims + iat/exp, base64url ≈ 4/3×) +
      // signature (~43) + 2 dots. The old `claims.length + 128` under-sized a
      // typical token (measured 168 B for a 30 B claim → grow-retry double-run,
      // which made ffi slower than napi). 2×+128 with a 256-byte floor covers
      // typical claims in one pass; growExact handles huge claims with one
      // exact retry (no re-run loop).
      return growExact(
        (out) =>
          Number(
            jwtSignBytes(
              claimsJson,
              claimsJson.length,
              secret,
              secret.length,
              ttl,
              now,
              out,
              out.length,
            ),
          ),
        Math.min(
          Math.max(
            claimsJson.length * JWT_INITIAL_MULTIPLIER + JWT_INITIAL_EXTRA,
            JWT_INITIAL_FLOOR,
          ),
          1024 * 1024,
        ),
        1024 * 1024,
        'jwt sign: output buffer too small',
      )
    },
    wsFrameDecodePacked(data) {
      // Max packed output = 6-byte header + payload.
      const out = new Uint8Array(data.length + 6)
      const w = Number(wsFrameDecodePacked(data, data.length, out, out.length))
      return w === 0 ? null : out.subarray(0, w)
    },
    multipartParsePacked(body, boundary) {
      return growExact(
        (out) =>
          Number(
            multipartParsePacked(body, body.length, boundary, boundary.length, out, out.length),
          ),
        Math.min(body.length + boundary.length + 64, 64 * 1024),
        128 * 1024 * 1024,
        'multipart parse: output buffer too small',
      )
    },
    formParsePackedInto(input, output) {
      const w = Number(formParsePacked(input, input.length, output, output.length))
      if (w === 0 && input.length !== 0) {
        throw new Error('form parse: output buffer too small')
      }
      return w
    },
    ingressHandlePacked(inner, input, body, output) {
      const w = Number(
        ingressHandlePacked(
          inner,
          input,
          input.length,
          body ?? EMPTY_VIEW,
          body?.length ?? 0,
          output,
          output.length,
        ),
      )
      if (w === 0) {
        throw new Error('ingress handle: output buffer too small or pipeline error')
      }
      return w
    },
    ingressLayout(out) {
      const w = Number(ingressLayoutSym(out, out.length))
      if (w !== out.length) {
        throw new Error('ingress layout: output buffer too small')
      }
      return w
    },
  }
}

/** Verify every bound function against known-good results; false disables ffi. */
function selfTest(b: BunFFI): boolean {
  const dec = new TextDecoder()
  const enc = encoder

  if (b.crc32(enc.encode('123456789')) !== 0xcbf4_3926) {
    return false
  }
  if (b.fnv1a64(enc.encode('foobar')) !== 0x8594_4171_f739_67e8n) {
    return false
  }
  // XXH3-64 of empty input = 0x2d06800538d394c2 (standard reference vector).
  if (b.xxh3(new Uint8Array(0)) !== 0x2d06800538d394c2n) {
    return false
  }
  if (b.jsonValid(SELFTEST_JSON) !== true || b.jsonValid(enc.encode('{not json')) !== false) {
    return false
  }
  const hexOut = new Uint8Array(SELFTEST_HEX.length * 2)
  if (b.hexEncodeInto(SELFTEST_HEX, hexOut) !== 10 || dec.decode(hexOut) !== '68656c6c6f') {
    return false
  }
  const urlInput = enc.encode('a b/c')
  const urlOut = new Uint8Array(9)
  if (b.urlEncodeInto(urlInput, urlOut) !== 9 || dec.decode(urlOut) !== 'a%20b%2Fc') {
    return false
  }

  // Ingress layout blob (38 × u32 LE). The pinned values catch a reordered
  // `#[repr(C)] IngressLayout` (drift → self-test fails → napi fallback); the
  // Rust unit test `ingress_layout_c_abi_matches_output_source` pins every
  // field against output.rs. Slot order mirrors the struct field order.
  const layoutBuf = new Uint8Array(38 * 4)
  b.ingressLayout(layoutBuf)
  const layoutView = new DataView(layoutBuf.buffer, layoutBuf.byteOffset, layoutBuf.byteLength)
  if (
    layoutView.getUint32(0, true) !== 0 || // OUT_VERDICT
    layoutView.getUint32(2 * 4, true) !== 2 || // OUT_STATUS
    layoutView.getUint32(12 * 4, true) !== 48 || // OUT_DATA_START
    layoutView.getUint32(13 * 4, true) !== 1 || // FLAG_HAS_COOKIES
    layoutView.getUint32(28 * 4, true) !== 32 || // HV_COUNT
    layoutView.getUint32(37 * 4, true) !== 8 // ERR_INTERNAL
  ) {
    return false
  }

  // Ingress pipeline C-ABI: with a null (0) inner handle the Rust side returns
  // 0 immediately and the wrapper throws. This exercises the symbol's ABI (arg
  // count/types/return) at bind time — a signature drift would surface here
  // instead of crashing under load. Real frame→output parity is covered by
  // ffi.test.ts against a live napi instance.
  try {
    b.ingressHandlePacked(0, enc.encode('/'), null, new Uint8Array(64))
    return false // a null handle must throw, not return
  } catch {
    // expected: null inner handle → 0 → throw
  }

  // ── New bindings ───────────────────────────────────────────────────
  const a = enc.encode('a@b.com')
  const uuid = enc.encode('550e8400-e29b-41d4-a716-446655440000')
  if (
    !b.validateEmail(a) ||
    !b.validateUuid(uuid) ||
    !b.validateIpv4(enc.encode('192.168.0.1')) ||
    !b.validateIpv6(enc.encode('2001:db8::1')) ||
    b.validateEmail(enc.encode('not-an-email')) ||
    b.validateUuid(enc.encode('not-a-uuid'))
  ) {
    return false
  }
  if (b.jsonSumIds(enc.encode(`[{"id":1},{"id":2}]`)) !== 3n) {
    return false
  }
  // The packed [u8 ok][i64 sum LE] ABI: a legit zero-sum is ok, invalid input throws.
  if (b.jsonSumIds(enc.encode(`[{"id":0},{"id":0}]`)) !== 0n) {
    return false
  }
  let sumInvalidThrew = false
  try {
    b.jsonSumIds(enc.encode('nope'))
  } catch {
    sumInvalidThrew = true
  }
  if (!sumInvalidThrew) {
    return false
  }

  // HMAC RFC 4231 test case 1 (0x0b × 20 key, "Hi There" data).
  const hmacKey = new Uint8Array(20).fill(0x0b)
  const hmacData = enc.encode('Hi There')
  const hmacSig = enc.encode('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  const hmacHex = b.hmacSha256(hmacKey, hmacData)
  if (dec.decode(hmacHex) !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7') {
    return false
  }
  if (!b.hmacSha256Verify(hmacKey, hmacData, hmacSig)) {
    return false
  }

  // Decoders round-trip.
  const decoded = b.hexDecode(enc.encode('68656c6c6f'))
  if (
    dec.decode(decoded) !== 'hello' ||
    dec.decode(b.urlDecode(enc.encode('a%20b%2Fc'))) !== 'a b/c'
  ) {
    return false
  }

  // WebSocket accept key (RFC 6455 sample).
  if (
    dec.decode(b.wsAcceptKey(enc.encode('dGhlIHNhbXBsZSBub25jZQ=='))) !==
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  ) {
    return false
  }

  // ETag: strong = 10 bytes, weak = 12 bytes.
  if (b.etag(SELFTEST_HEX).length !== 10 || b.etag(SELFTEST_HEX, true).length !== 12) {
    return false
  }

  // base64.
  if (dec.decode(b.base64Encode(SELFTEST_HEX)) !== 'aGVsbG8=') {
    return false
  }
  if (dec.decode(b.base64Decode(enc.encode('aGVsbG8='))) !== 'hello') {
    return false
  }

  // Signed cookie round-trip.
  const secret = enc.encode('s3cr3t-secret')
  const signed = b.signCookie(SELFTEST_HEX, secret)
  const verified = b.verifyCookie(signed, secret)
  if (verified === null || dec.decode(verified) !== 'hello') {
    return false
  }
  if (b.verifyCookie(enc.encode('tampered.0000'), secret) !== null) {
    return false
  }

  // CSRF token round-trip (issued token verifies against the same secret).
  const csrfTokenBytes = b.csrfToken(secret)
  if (csrfTokenBytes.length !== 129 || !b.csrfVerify(csrfTokenBytes, secret)) {
    return false
  }

  // Argon2id round-trip at minimum cost (fast) — full defaults would take ~50ms.
  const pw = enc.encode('correct horse battery staple')
  const salt = enc.encode('salty-salt-16b')
  const phc = b.passwordHash(pw, salt, 8, 1, 1, 16)
  if (phc.length === 0 || !b.passwordVerify(pw, phc)) {
    return false
  }

  // bcrypt round-trip at minimum cost (fast).
  const bcryptPhc = b.passwordHashBcrypt(pw, 4)
  if (bcryptPhc.length === 0 || !b.passwordVerifyBcrypt(pw, bcryptPhc)) {
    return false
  }

  // PBKDF2-HMAC-SHA256: password="password", salt="salt", c=1, dkLen=32.
  // The C ABI writes the RAW derived key; hex-encode before comparing.
  const dk = b.pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 1, 32)
  if (
    dec.decode(b.hexEncode(dk)) !==
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
  ) {
    return false
  }

  // AEAD AES-256-GCM round-trip (key 32B, nonce 12B).
  const aeadKey = new Uint8Array(32).fill(0x42)
  const nonce = new Uint8Array(12).fill(0x07)
  const ct = b.aeadEncrypt(aeadKey, nonce, SELFTEST_HEX, 0)
  const pt = b.aeadDecrypt(aeadKey, nonce, ct, 0)
  if (pt === null || dec.decode(pt) !== 'hello') {
    return false
  }

  // WebSocket frame: text frame, FIN, no mask → first byte 0x81.
  const frame = b.wsFrameEncode(1, SELFTEST_HEX, false, true)
  if (frame.length === 0 || frame[0] !== 0x81) {
    return false
  }

  // JSON patch: add a key.
  const patched = b.jsonPatch(
    enc.encode(`{"a":"b"}`),
    enc.encode(`[{"op":"add","path":"/c","value":"d"}]`),
  )
  if (!dec.decode(patched).includes(`"c":"d"`)) {
    return false
  }

  // gzip / brotli round-trips.
  const gz = b.gzipCompress(SELFTEST_HEX)
  if (dec.decode(b.gzipDecompress(gz)) !== 'hello') {
    return false
  }
  const br = b.brotliCompress(SELFTEST_HEX)
  if (dec.decode(b.brotliDecompress(br)) !== 'hello') {
    return false
  }

  // Needed-size convention: invalid compressed input throws IMMEDIATELY (the C
  // ABI returns 0 = real error, so the JS wrapper does NOT grow-retry re-runs
  // or allocate up to the 64 MiB decompression cap per bad input).
  let decompressThrew = false
  try {
    b.gzipDecompress(enc.encode('not-a-gzip-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }
  decompressThrew = false
  try {
    b.brotliDecompress(enc.encode('not-brotli-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }

  // Packed parsers (non-empty output). Packed output is LARGER than input (each
  // component gets a u32 length prefix), so size with the Rust allocator's
  // conservative upper bound (`input.len() * 9 + 16` in query_parser.rs).
  const req = enc.encode('GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n')
  const reqOut = new Uint8Array(req.length * 9 + 16)
  if (b.httpParseRequestPackedInto(req, reqOut) === 0) {
    return false
  }
  const qIn = enc.encode('a=1&b=2')
  const qOut = new Uint8Array(qIn.length * 9 + 16)
  if (b.queryParsePackedInto(qIn, qOut) === 0) {
    return false
  }
  const cIn = enc.encode('a=1; b=2')
  const cOut = new Uint8Array(cIn.length * 9 + 16)
  if (b.cookieParsePackedInto(cIn, cOut) === 0) {
    return false
  }

  // ── Excluded-surface additions ────────────────────────────────────
  // form parse shares the query core → 2 pairs.
  const fIn = enc.encode('a=1&b=2')
  const fOut = new Uint8Array(fIn.length * 9 + 16)
  if (b.formParsePackedInto(fIn, fOut) === 0 || fOut[0] !== 2) {
    return false
  }

  // multipart parse → 1 part named "field".
  const boundary = enc.encode('----boundary')
  // Wire format is `--{boundary}` — boundary is `----boundary`, so the body
  // must open with `------boundary`.
  const mBody = enc.encode(
    '------boundary\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n------boundary--',
  )
  const mOut = b.multipartParsePacked(mBody, boundary)
  if (mOut[0] !== 1) {
    return false
  }
  // Packed layout: [u32 count][u32 name_len][name]... → name_len at offset 4.
  const mNameLen = (mOut[4] ?? 0) | ((mOut[5] ?? 0) << 8) | ((mOut[6] ?? 0) << 16) | ((mOut[7] ?? 0) << 24)
  if (dec.decode(mOut.subarray(8, 8 + mNameLen)) !== 'field') {
    return false
  }

  // WS frame decode: encode("hello") → decode → fin=1, opcode=1, payload="hello".
  const wf = b.wsFrameEncode(1, SELFTEST_HEX, true, true)
  const wd = b.wsFrameDecodePacked(wf)
  if (wd === null || wd[0] !== 1 || wd[1] !== 1 || dec.decode(wd.subarray(6)) !== 'hello') {
    return false
  }
  if (b.wsFrameDecodePacked(enc.encode('\x80')) !== null) {
    return false
  }

  // JWT sign with ttl=0 (deterministic — no iat/exp), then verify the
  // signature with the FFI HMAC to prove the binding is real.
  const jwtSecret = enc.encode('my-secret')
  const jwt = b.jwtSignBytes(enc.encode('{"sub":"user-1"}'), jwtSecret, 0, 0)
  const jwtStr = dec.decode(jwt)
  const segs = jwtStr.split('.')
  if (segs.length !== 3 || segs[0] === '' || segs[1] === '' || segs[2] === '') {
    return false
  }
  const signingInput = enc.encode(`${segs[0]}.${segs[1]}`)
  const sigHex = dec.decode(b.hmacSha256(jwtSecret, signingInput))
  const sigBytes = b.base64Decode(enc.encode(segs[2]), true, false)
  if (sigBytes === null || dec.decode(b.hexEncode(sigBytes)) !== sigHex) {
    return false
  }

  return true
}
