// src/native/ffi/types.ts — bun:ffi C-ABI type surface (pure types).
//
// The bound-function contract (`BunFFI`), the transport selection
// (`FfiMode`), and the raw `(ptr,len)` symbol signatures (`Raw2..Raw10`)
// used by the transport core. No runtime code — erased at compile time.

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

/**
 * bun:ffi transport selection (from `CASTRUM_FFI_MODE`; legacy `RUST_FFI_MODE`
 * accepted):
 *
 * - `auto` (default): use bun:ffi on Bun, silently fall back to napi when the
 *   bind or self-test fails (and always on Node).
 * - `ffi`: force bun:ffi on Bun — throw a clear error if it can't bind or the
 *   self-test fails (use in benches/CI that MUST run ffi).
 * - `napi`: never bind — every call goes through the napi addon (the fallback;
 *   useful for exercising the fallback path on Bun).
 */
export type FfiMode = 'auto' | 'ffi' | 'napi'

export type Raw2 = (a: unknown, b: unknown) => number | bigint
export type Raw3 = (a: unknown, b: unknown, c: unknown) => number | bigint
export type Raw4 = (a: unknown, b: unknown, c: unknown, d: unknown) => number | bigint
export type Raw5 = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown) => number | bigint
export type Raw6 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
) => number | bigint
export type Raw7 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
) => number | bigint
export type Raw8 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
  h: unknown,
) => number | bigint
export type Raw9 = (
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
export type Raw10 = (
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

