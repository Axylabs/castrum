// src/rust-ffi/scalar/interface.ts — The `RustScalar` method surface.
//
// One file per public method (with its perf JSDoc, written by
// `scripts/annotate-performance.ts`). The implementation is split into domain
// builders (hashing, json, http, crypto, payload, factories) composed by
// `buildScalar` in index.ts.

import type {
  HmacSignerInstance,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  FormParserInstance,
  MediaTypeParserInstance,
  MediaTypeResult,
  MediaTypeMatcherInstance,
  ConditionalRequestInstance,
  EncodingPrefResult,
  AcceptNegotiatorInstance,
  Base64CodecInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  UrlBuilderInstance,
  JwtSignerInstance,
  AeadCipherInstance,
  Argon2HasherInstance,
  RateLimiterInstance,
  MultipartPart,
  WsFrame,
  PasswordHashOptions,
} from "../../native";

/** Scalar + factory + runtime methods of the Rust client. */
export interface RustScalar {
  // ── Scalar utilities (bytes in → normalized out) ──
  /**
   * @performance CRC32: ~3.7x slower than the JS baseline (2/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~3.7x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Sub-µs FFI-crossing bound vs the same-engine JS crc-32 loop (~0.23-0.44x across runs); use the packed crc32BatchPacked path which wins on larger inputs. [check:annotate]
   */
  crc32(input: Uint8Array): number;
  /**
   * @performance FNV-1a 64: ~6.6x faster than the JS baseline [check:annotate]
   */
  fnv1a64(input: Uint8Array): bigint;
  /**
   * XXH3-64 over raw bytes (high-throughput non-cryptographic hash).
   * Compare against `Bun.hash.xxHash3` — see docs/bun-builtins-decision-matrix.md.
   */
  xxh3(input: Uint8Array): bigint;
  /**
   * @performance HMAC sign: ~1.1x faster than the JS baseline (2/3 tasks won) [check:annotate]
   */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  /**
   * @performance HMAC verify: ~2.5x faster than the JS baseline [check:annotate]
   */
  hmacSha256Verify(
    key: Uint8Array,
    data: Uint8Array,
    sig: Uint8Array,
  ): boolean;
  /**
   * @performance JSON valid: ~3.2x faster than the JS baseline (8/8 tasks won) [check:annotate]
   */
  jsonValid(input: Uint8Array): boolean;
  /**
   * Parse JSON to a JS value (native sonic-rs DOM → napi). Throws on invalid JSON.
   * @performance JSON parse: ~5.0x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~5.0x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Bun's JSON.parse beats the native DOM + napi marshaling path (~5x). [check:annotate]
   */
  jsonParse(input: Uint8Array): unknown;
  /**
   * @performance JSON sum: ~2.9x faster than the JS baseline (4/4 tasks won) [check:annotate]
   */
  jsonSumIds(input: Uint8Array): bigint;
  /**
   * @performance JSON Patch: ~1.2x faster than the JS baseline [check:annotate]
   * @remarks Modest but real win; swings ~0.9-1.5x run-to-run (DOM marshal dominated). [check:annotate]
   */
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
  /**
   * @performance MIME lookup: ≈ parity with the JS baseline [check:annotate]
   * @remarks Noisy sub-µs op: wins ~1.6x on good runs, loses on bad runs; phf table lookup. [check:annotate]
   */
  mimeFromExtension(ext: Uint8Array): Uint8Array;
  /**
   * @performance Random token: ≈ parity with the JS baseline [check:annotate]
   */
  randomToken(byteLen: number): Uint8Array;
  /**
   * @performance URL encode: ~2.2x slower than the JS baseline (2/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~2.2x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Loses ~2.8x on the shipped baseline release build (only wins in the LOCAL SIMD perf build). [check:annotate]
   */
  urlEncode(input: Uint8Array): Uint8Array;
  /**
   * @performance URL decode: ~2.2x slower than the JS baseline (2/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~2.2x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Loses ~2.8x on the shipped baseline release build (only wins in the LOCAL SIMD perf build). [check:annotate]
   */
  urlDecode(input: Uint8Array): Uint8Array;
  /** Strict percent-decode without UTF-8 validation. */
  urlDecodeBytes(input: Uint8Array): Uint8Array;
  /** Reusable-output percent-encode; returns bytes written. */
  urlEncodeInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output percent-decode; returns bytes written. */
  urlDecodeInto(input: Uint8Array, output: Uint8Array): number;
  /**
   * @performance Email validation: ~3.1x faster than the JS baseline (4/4 tasks won) [check:annotate]
   */
  validateEmail(input: Uint8Array): boolean;
  /**
   * @performance UUID validation: ≈ parity with the JS baseline (2/4 tasks won) [check:annotate]
   */
  validateUuid(input: Uint8Array): boolean;
  /**
   * @performance IPv4 validation: ≈ parity with the JS baseline (2/2 tasks won) [check:annotate]
   */
  validateIpv4(input: Uint8Array): boolean;
  /**
   * @performance IPv6 validation: ~1.9x faster than the JS baseline [check:annotate]
   */
  validateIpv6(input: Uint8Array): boolean;
  /**
   * @performance WebSocket accept: ~1.9x faster than the JS baseline (1/2 tasks won) [check:annotate]
   */
  wsAcceptKey(key: Uint8Array): Uint8Array;

  // ── Low-level / packed scalar ──
  /**
   * @performance HTTP parse: ~5.3x faster than the JS baseline (6/6 tasks won) [check:annotate]
   */
  httpParseRequestPacked(input: Uint8Array): Uint8Array;
  /**
   * @performance Query parse: ~3.8x faster than the JS baseline (6/6 tasks won) [check:annotate]
   */
  queryParsePacked(input: Uint8Array): Uint8Array;
  /**
   * @performance Cookie parse: ~2.6x faster than the JS baseline (5/5 tasks won) [check:annotate]
   */
  cookieParsePacked(input: Uint8Array): Uint8Array;
  /** Reusable-output packed HTTP parse; returns bytes written. */
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output packed query parse; returns bytes written. */
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output packed cookie parse; returns bytes written. */
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number;
  /**
   * Parse an application/x-www-form-urlencoded body into packed pairs.
   * @performance Form parse: ~4.7x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks Benchmarked via the FormParser instance (same parser core). [check:annotate]
   */
  formParsePacked(input: Uint8Array): Uint8Array;
  /**
   * Parse a Content-Type header into a structured media type.
   * @performance Media type parse: ~1.3x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.3x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Consistent ~0.71-0.81x (sub-µs FFI crossing vs the JS baseline); use MediaTypeMatcher (precompiled expected) for the zero-alloc match path. [check:annotate]
   */
  parseMediaType(input: Uint8Array): MediaTypeResult;
  /**
   * Generate a strong/weak ETag (crc32-based).
   * @performance ETag: ≈ parity with the JS baseline [check:annotate]
   */
  etag(data: Uint8Array, weak?: boolean): Uint8Array;
  /** Reusable-output etag; returns bytes written (10 strong / 12 weak). */
  etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number;
  /**
   * Format a unix timestamp as an IMF-fixdate HTTP-date.
   * @performance HTTP date: ~1.5x slower than the JS baseline (2/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.5x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Date.toUTCString() is native (~1.5-1.7x loss); pooled httpDateInto cuts it to ~1.3x. [check:annotate]
   */
  httpDate(secs?: number): Uint8Array;
  /** Reusable-output http-date; returns bytes written (29). Throws if `output` is too small or the year is out of the fixed-width range. */
  httpDateInto(secs: number | undefined, output: Uint8Array): number;
  /** Parse an IMF-fixdate HTTP-date back to unix seconds. */
  parseHttpDate(input: Uint8Array): bigint | null;
  /** Parse an Accept-Encoding header into ordered preferences. */
  parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[];
  /**
   * Base64 encode (standard by default; url-safe/padding configurable).
   * @performance Base64 encode: ~1.6x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.6x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Bun Buffer base64 is SIMD; loses ~1.5x. [check:annotate]
   */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  /**
   * Base64 decode (standard); throws on invalid input.
   * @performance Base64 decode: ≈ parity with the JS baseline [check:annotate]
   */
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  /** Reusable-output base64 encode; returns bytes written. */
  base64EncodeInto(input: Uint8Array, output: Uint8Array, urlSafe?: boolean, padding?: boolean): number;
  /** Reusable-output base64 decode; returns bytes written. Throws on invalid input. */
  base64DecodeInto(input: Uint8Array, output: Uint8Array, urlSafe?: boolean, padding?: boolean): number;
  base64UrlEncode(input: Uint8Array): Uint8Array;
  base64UrlDecode(input: Uint8Array): Uint8Array;
  /**
   * Lowercase hex encode.
   * @performance Hex encode: ~1.4x slower than the JS baseline (1/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.4x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Buffer.toString('hex') is native SIMD; pooled hexEncodeInto cuts the loss from ~2.2x to ~1.35x. [check:annotate]
   */
  hexEncode(input: Uint8Array): Uint8Array;
  /**
   * Hex decode; throws on odd length or invalid digits.
   * @performance Hex decode: ≈ parity with the JS baseline [check:annotate]
   * @remarks Slightly slower than Buffer hex decode (~1.3x). [check:annotate]
   */
  hexDecode(input: Uint8Array): Uint8Array;
  /** Reusable-output lowercase-hex encode; returns bytes written. */
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output hex decode; returns bytes written. Throws on bad input. */
  hexDecodeInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output HMAC-SHA256 hex (64 bytes); returns bytes written. Throws on too-small buffer. */
  hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number;
  /** Reusable-output cookie sign (`value.<64-hex>`); returns bytes written. Throws on too-small buffer. */
  signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number;
  /** Reusable-output AEAD encrypt (ct + 16-byte tag); returns bytes written. Throws on too-small buffer. */
  aeadEncryptInto(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    output: Uint8Array,
    algorithm?: string | null,
  ): number;
  /** Reusable-output WS frame encode; returns bytes written. Throws on too-small buffer. */
  wsFrameEncodeInto(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
    output: Uint8Array,
  ): number;
  /** Reusable-output gzip compress; returns bytes written. Throws on too-small buffer. */
  gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number | null): number;
  /** Reusable-output brotli compress; returns bytes written. Throws on too-small buffer. */
  brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number | null): number;
  /**
   * Sign a cookie value as `value.signature` (HMAC-SHA256 hex).
   * @performance Cookie sign: ~1.0x faster than the JS baseline [check:annotate]
   */
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array;
  /**
   * Verify a signed cookie; returns the value or null.
   * @performance Cookie verify: ~9.5x faster than the JS baseline [check:annotate]
   */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null;
  /**
   * Create a CSRF token (32-byte random hex + HMAC signature).
   * @performance CSRF create: ~13.7x faster than the JS baseline [check:annotate]
   */
  csrfToken(secret: Uint8Array): Uint8Array;
  /**
   * Constant-time verify a CSRF token.
   * @performance CSRF verify: ~3.3x faster than the JS baseline [check:annotate]
   */
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
  /**
   * Resolve a URL reference against a base (RFC 3986).
   * @performance URL resolve: ~1.8x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.8x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Auto-deprecated: 1/1 benchmarks failed in the latest run (static classification was parity). [check:annotate]
   * @remarks Noisy ~1.5µs op; swings 0.74-1.03x run-to-run. UrlBuilder reuses the parsed base. [check:annotate]
   */
  urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array;
  /**
   * Build a percent-encoded query string from params (sorted keys).
   * @performance URL query build: ~1.4x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.4x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks encodeURIComponent baseline wins (~1.2-1.35x). [check:annotate]
   */
  urlEncodeQuery(params: Record<string, string>): Uint8Array;

  // ── Factories / runtime ──
  /**
   * @performance JSON schema validate: ~1.7x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks Zero-DOM fast path validates raw bytes for the common keyword subset (scalar ~1.2-2.4x, batch ~1.0-1.56x vs ajv); unsupported keywords fall back to the jsonschema crate. [check:annotate]
   */
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance;
  createHmacSigner(key: Uint8Array): HmacSignerInstance;
  createTemplateRenderer(source: string): TemplateRendererInstance;
  /** Higher-order form parser: owns a reusable output buffer (setup once). */
  createFormParser(capacity?: number): FormParserInstance;
  /** Higher-order media-type parser: reusable wildcard matcher. */
  createMediaTypeParser(): MediaTypeParserInstance;
  /**
   * Higher-order conditional-request check: per-resource 304 decision (setup once).
   * @performance Conditional request: ~1.7x faster than the JS baseline [check:annotate]
   */
  createConditionalRequest(
    etagValue: Uint8Array,
    lastModifiedSecs?: number,
  ): ConditionalRequestInstance;
  /**
   * Higher-order negotiator: precompiles supported encodings once.
   * @performance Accept-Encoding negotiate: ~4.2x faster than the JS baseline [check:annotate]
   */
  createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance;
  /** Higher-order codec: base64 config compiled once. */
  createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance;
  /** Higher-order cookie signer: HMAC key compiled once. */
  createCookieSigner(secret: Uint8Array): CookieSignerInstance;
  /** Higher-order CSRF protector: HMAC key compiled once. */
  createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance;
  /** Higher-order URL builder: base parsed once, reused. */
  createUrlBuilder(base: Uint8Array): UrlBuilderInstance;
  /** Higher-order JWT signer: HS256 key + ttl compiled once. */
  createJwtSigner(secret: Uint8Array, ttlSeconds?: number): JwtSignerInstance;
  /** Higher-order AEAD cipher: algorithm + key compiled once. */
  createAeadCipher(key: Uint8Array, algorithm?: string): AeadCipherInstance;
  /** Higher-order argon2id hasher: params compiled once. */
  createArgon2Hasher(options?: PasswordHashOptions | null): Argon2HasherInstance;
  /** Higher-order media-type matcher: expected precompiled once. */
  createMediaTypeMatcher(expected: Uint8Array): MediaTypeMatcherInstance;
  /**
   * Sharded fixed-window per-key rate limiter. `maxEntries` clamps internally
   * (default 1,048,576). Each instance owns an independent budget.
   * @remarks Scalar per-check cost: ~3-14x SLOWER than the JS Map baseline —
   * prefer the ingress pipeline (one FFI for all stages) for native rate
   * limiting in a request path. [measured 2026-08]
   */
  createRateLimiter(
    limit: number,
    windowMs: number,
    maxEntries?: number | null,
  ): RateLimiterInstance;
  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  // ── Backend-framework scalar features ──
  /**
   * @performance JWT sign: ~1.1x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.1x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Base64 + claims DOM marshal overhead. Use jwtSignBytes (claims as JSON bytes) which skips the napi Value marshal and flips to a ~1.07x win. [check:annotate]
   */
  jwtSign(
    claims: Record<string, unknown>,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array;
  /**
   * Sign a JWT from pre-serialized claim JSON bytes — skips the napi
   * `serde_json::Value` marshal of `jwtSign` for callers that already hold the
   * bytes (same injection semantics).
   * @performance JWT sign (bytes): ≈ parity with the JS baseline [check:annotate]
   * @remarks Byte-JSON claims overload avoids the napi serde_json::Value DOM marshal; flips jwtSign from a ~1.3x loss to ~1.07x (parity). [check:annotate]
   */
  jwtSignBytes(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array;
  /**
   * @performance JWT verify: ~1.7x faster than the JS baseline (2/2 tasks won) [check:annotate]
   */
  jwtVerify(
    token: Uint8Array,
    secret: Uint8Array,
    nowSeconds?: number,
  ): unknown;
  /**
   * @performance Password hash: ~18.2x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks argon2id vs node:crypto scrypt. [check:annotate]
   */
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array;
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean;
  /** bcrypt password hash → `$2b$` PHC string (cost clamped 4..=31). */
  passwordHashBcrypt(password: Uint8Array, cost: number): string;
  /** Verify a password against a bcrypt `$2b$` PHC string. */
  passwordVerifyBcrypt(password: Uint8Array, hash: string): boolean;
  /** PBKDF2-HMAC-SHA256 key derivation (dkLen clamped to 1 MiB). */
  pbkdf2Sha256(
    password: Uint8Array,
    salt: Uint8Array,
    rounds: number,
    dkLen: number,
  ): Uint8Array;
  /**
   * @performance AEAD encrypt: ~1.3x faster than the JS baseline [check:annotate]
   */
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array;
  /**
   * @performance AEAD decrypt: ~1.4x faster than the JS baseline [check:annotate]
   */
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array | null;
  /**
   * @performance Gzip compress: ≈ parity with the JS baseline (1/2 tasks won) [check:annotate]
   */
  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
  /**
   * @performance Gzip decompress: ~1.0x faster than the JS baseline [check:annotate]
   * @remarks zlib-rs vs node zlib; swings 1.0-1.4x run-to-run. [check:annotate]
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  gzipDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array;
  /**
   * @performance Brotli compress: ~1.7x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.7x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks The native brotli baseline wins for small inputs. [check:annotate]
   */
  brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
  /**
   * @performance Brotli decompress: ~1.4x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.4x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Auto-deprecated: 1/1 benchmarks failed in the latest run (static classification was proven). [check:annotate]
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  brotliDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array;
  /**
   * @performance Multipart parse: ~1.9x faster than the JS baseline [check:annotate]
   */
  multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[];
  /** Zero-copy packed sibling of `multipartParse` (packed parts layout). */
  multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array;
  /**
   * @performance WS frame encode: ~2.0x faster than the JS baseline [check:annotate]
   */
  wsFrameEncode(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
  ): Uint8Array;
  /**
   * @performance WS frame decode: ~2.3x faster than the JS baseline [check:annotate]
   */
  wsFrameDecode(data: Uint8Array): WsFrame | null;
  /**
   * @performance SSE encode: ≈ parity with the JS baseline [check:annotate]
   */
  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array;
}
