// src/rust-ffi/scalar/interface.ts — The `RustScalar` method surface.
//
// One file per public method. The implementation is split into domain
// builders (hashing, json, http, crypto, payload, factories) composed by
// `buildScalar` in index.ts.

import type {
  AcceptNegotiatorInstance,
  AeadCipherInstance,
  Argon2HasherInstance,
  Base64CodecInstance,
  ConditionalRequestInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  EncodingPrefResult,
  FormParserInstance,
  HmacSignerInstance,
  JwtSignerInstance,
  MediaTypeMatcherInstance,
  MediaTypeParserInstance,
  MediaTypeResult,
  MultipartPart,
  PasswordHashOptions,
  RateLimiterInstance,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  UrlBuilderInstance,
  WsFrame,
} from '../../native'

export interface RustScalar {
  // ── Scalar utilities (bytes in → normalized out) ──
  crc32(input: Uint8Array): number
  fnv1a64(input: Uint8Array): bigint
  /**
   * XXH3-64 over raw bytes (high-throughput non-cryptographic hash).
   * Compare against `Bun.hash.xxHash3` — see docs/bun-builtins-decision-matrix.md.
   */
  xxh3(input: Uint8Array): bigint
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | string
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array | string): boolean
  jsonValid(input: Uint8Array): boolean
  /**
   * Parse JSON to a JS value (FFI packed structural parse on Bun — sonic-rs
   * parses ONCE, JS assembles from a token stream with no re-parse; napi
   * sonic-rs DOM fallback). Throws on invalid JSON.
   */
  jsonParse(input: Uint8Array): unknown
  jsonSumIds(input: Uint8Array): bigint
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array | string
  mimeFromExtension(ext: Uint8Array): Uint8Array | string
  randomToken(byteLen: number): Uint8Array | string
  randomTokenInto(byteLen: number, output: Uint8Array): number
  urlEncode(input: Uint8Array): Uint8Array | string
  urlDecode(input: Uint8Array): Uint8Array
  /**
   * Strict percent-decode without UTF-8 validation.
   */
  urlDecodeBytes(input: Uint8Array): Uint8Array
  urlEncodeInto(input: Uint8Array, output: Uint8Array): number
  urlDecodeInto(input: Uint8Array, output: Uint8Array): number
  validateEmail(input: Uint8Array): boolean
  validateUuid(input: Uint8Array): boolean
  validateIpv4(input: Uint8Array): boolean
  validateIpv6(input: Uint8Array): boolean
  wsAcceptKey(key: Uint8Array): Uint8Array | string
  wsAcceptKeyInto(key: Uint8Array, output: Uint8Array): number

  // ── Low-level / packed scalar ──
  httpParseRequestPacked(input: Uint8Array): Uint8Array
  queryParsePacked(input: Uint8Array): Uint8Array
  cookieParsePacked(input: Uint8Array): Uint8Array
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Parse an application/x-www-form-urlencoded body into packed pairs.
   */
  formParsePacked(input: Uint8Array): Uint8Array
  formParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Parse a Content-Type header into a structured media type.
   */
  parseMediaType(input: Uint8Array): MediaTypeResult
  /**
   * Generate a strong/weak ETag (crc32-based).
   */
  etag(data: Uint8Array, weak?: boolean): Uint8Array | string
  etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number
  /**
   * Format a unix timestamp as an IMF-fixdate HTTP-date.
   */
  httpDate(secs?: number): Uint8Array | string
  httpDateInto(secs: number | undefined, output: Uint8Array): number
  parseHttpDate(input: Uint8Array): bigint | null
  parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[]
  /**
   * Base64 encode (standard by default; url-safe/padding configurable).
   */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array | string
  /**
   * Base64 decode (standard); throws on invalid input.
   */
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array
  base64EncodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number
  base64DecodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number
  base64UrlEncode(input: Uint8Array): Uint8Array | string
  base64UrlDecode(input: Uint8Array): Uint8Array
  /**
   * Lowercase hex encode.
   */
  hexEncode(input: Uint8Array): Uint8Array | string
  /**
   * Hex decode; throws on odd length or invalid digits.
   */
  hexDecode(input: Uint8Array): Uint8Array
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number
  hexDecodeInto(input: Uint8Array, output: Uint8Array): number
  hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number
  signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number
  verifyCookieInto(signed: Uint8Array, secret: Uint8Array, output: Uint8Array): number | null
  csrfTokenInto(secret: Uint8Array, output: Uint8Array): number
  aeadEncryptInto(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    output: Uint8Array,
    algorithm?: string | null,
  ): number
  wsFrameEncodeInto(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
    output: Uint8Array,
  ): number
  gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number | null): number
  brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number | null): number
  /**
   * Sign a cookie value as `value.signature` (HMAC-SHA256 hex).
   */
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array | string
  /**
   * Verify a signed cookie; returns the value or null.
   */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | string | null
  /**
   * Create a CSRF token (32-byte random hex + HMAC signature).
   */
  csrfToken(secret: Uint8Array): Uint8Array | string
  /**
   * Constant-time verify a CSRF token.
   */
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean
  /**
   * Resolve a URL reference against a base (RFC 3986).
   */
  urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array | string
  /**
   * Build a percent-encoded query string from params (sorted keys).
   */
  urlEncodeQuery(params: Record<string, string>): Uint8Array | string

  // ── Factories / runtime ──
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance
  createHmacSigner(key: Uint8Array): HmacSignerInstance
  createTemplateRenderer(source: string): TemplateRendererInstance
  createFormParser(capacity?: number): FormParserInstance
  createMediaTypeParser(): MediaTypeParserInstance
  /**
   * Higher-order conditional-request check: per-resource 304 decision (setup once).
   */
  createConditionalRequest(
    etagValue: Uint8Array,
    lastModifiedSecs?: number,
  ): ConditionalRequestInstance
  /**
   * Higher-order negotiator: precompiles supported encodings once.
   */
  createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance
  createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance
  createCookieSigner(secret: Uint8Array): CookieSignerInstance
  createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance
  createUrlBuilder(base: Uint8Array): UrlBuilderInstance
  createJwtSigner(secret: Uint8Array, ttlSeconds?: number): JwtSignerInstance
  createAeadCipher(key: Uint8Array, algorithm?: string): AeadCipherInstance
  createArgon2Hasher(options?: PasswordHashOptions | null): Argon2HasherInstance
  createMediaTypeMatcher(expected: Uint8Array): MediaTypeMatcherInstance
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
  ): RateLimiterInstance
  initThreadPool(rayonThreads?: number): void
  rayonNumThreads(): number

  // ── Backend-framework scalar features ──
  jwtSign(
    claims: Record<string, unknown>,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array
  /**
   * Sign a JWT from pre-serialized claim JSON bytes — skips the napi
   * `serde_json::Value` marshal of `jwtSign` for callers that already hold the
   * bytes (same injection semantics).
   */
  jwtSignBytes(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array | string
  jwtSignBytesInto(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    output: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): number
  jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds?: number): unknown
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array | string
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean
  /**
   * bcrypt password hash → `$2b$` PHC string (cost clamped 4..=31).
   */
  passwordHashBcrypt(password: Uint8Array, cost: number): string
  /**
   * Verify a password against a bcrypt `$2b$` PHC string.
   */
  passwordVerifyBcrypt(password: Uint8Array, hash: string): boolean
  /**
   * PBKDF2-HMAC-SHA256 key derivation (dkLen clamped to 1 MiB).
   */
  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, rounds: number, dkLen: number): Uint8Array
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array | null
  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array
  /**
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  gzipDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array
  /**
   * gzip-decompress into `output` (pooled — caller-owned buffer); returns bytes
   * written. Throws when `output` is too small (the exact required size is
   * reported) or the input is invalid / exceeds `maxDecompressed`.
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  gzipDecompressInto(data: Uint8Array, output: Uint8Array, maxDecompressed?: number | null): number
  brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array
  /**
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  brotliDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array
  /**
   * brotli-decompress into `output` (pooled — caller-owned buffer); returns
   * bytes written. Throws when `output` is too small (the exact required size
   * is reported) or the input is invalid / exceeds `maxDecompressed`.
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   */
  brotliDecompressInto(
    data: Uint8Array,
    output: Uint8Array,
    maxDecompressed?: number | null,
  ): number
  multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[]
  multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array
  multipartParsePackedInto(body: Uint8Array, boundary: Uint8Array, output: Uint8Array): number
  wsFrameEncode(opcode: number, payload: Uint8Array, mask: boolean, fin: boolean): Uint8Array
  wsFrameDecode(data: Uint8Array): WsFrame | null
  wsFrameDecodePackedInto(data: Uint8Array, output: Uint8Array): number | null
  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array
  sseEncodeEventInto(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
    output: Uint8Array,
  ): number
}
