// src/rust-ffi/scalar/interface.ts — The `RustScalar` method surface.
//
// One file per public method (with its perf JSDoc, written by
// `scripts/annotate-performance.ts`). The implementation is split into domain
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

/** Scalar + factory + runtime methods of the Rust client. */
export interface RustScalar {
  // ── Scalar utilities (bytes in → normalized out) ──
  /**
   * @performance CRC32: ~2.4x slower than the JS baseline (1/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~2.4x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Raw addon vs the same-engine JS crc-32 loop (~0.23-0.44x across runs). Under Bun the public rust.crc32 delegates to Bun.hash.crc32 (BUN_WINS, ~2.8-8.4x) — this row measures the raw addon (src/bench/raw-native.ts). [check:annotate]
   */
  crc32(input: Uint8Array): number
  /**
   * @performance FNV-1a 64: ~13.4x faster than the JS baseline [check:annotate]
   */
  fnv1a64(input: Uint8Array): bigint
  /**
   * XXH3-64 over raw bytes (high-throughput non-cryptographic hash).
   * Compare against `Bun.hash.xxHash3` — see docs/bun-builtins-decision-matrix.md.
   * @performance XXH3-64: ~1.1x faster than the JS baseline in the latest run [check:annotate]
   * @deprecated Historically slower than the native JS baseline on release builds — prefer the JS/Bun baseline until promoted. [check:annotate]
   * @remarks Promotion candidate: 1/1 benchmarks won in the latest run (static: not-competitive). [check:annotate]
   * @remarks Bun.hash.xxHash3 wins ~4x (in-process C++ beats the FFI crossing). The public rust.xxh3 now DELEGATES to Bun.hash.xxHash3 under Bun (BUN_WINS); the addon remains the Node/non-Bun fast path. See docs/bun-builtins-decision-matrix.md. [check:annotate]
   */
  xxh3(input: Uint8Array): bigint
  /**
   * @performance HMAC sign: ~1.2x faster than the JS baseline (3/4 tasks won) [check:annotate]
   * @remarks Classification vs the node:crypto baseline. Under Bun the public rust.hmacSha256 delegates to Bun.CryptoHasher (BUN_WINS — hex re-encoded to the same contract); this row measures the raw addon (see src/bench/raw-native.ts). [check:annotate]
   */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | string
  /**
   * @performance HMAC verify: ~2.6x faster than the JS baseline [check:annotate]
   */
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean
  /**
   * @performance JSON valid: ~2.0x faster than the JS baseline (8/8 tasks won) [check:annotate]
   */
  jsonValid(input: Uint8Array): boolean
  /**
   * Parse JSON to a JS value (FFI packed structural parse on Bun — sonic-rs
   * parses ONCE, JS assembles from a token stream with no re-parse; napi
   * sonic-rs DOM fallback). Throws on invalid JSON.
   * @performance JSON parse: ~1.9x slower than the JS baseline [check:annotate]
   * @remarks Bun's JSON.parse still wins for DOM construction (the packed path
   *   closed the old 3.92x gap to ~1.9x; exact parity needs Bun delegation). [check:annotate]
   */
  jsonParse(input: Uint8Array): unknown
  /**
   * @performance JSON sum: ~2.0x faster than the JS baseline (4/4 tasks won) [check:annotate]
   */
  jsonSumIds(input: Uint8Array): bigint
  /**
   * @performance JSON Patch: ~1.0x faster than the JS baseline [check:annotate]
   * @remarks Modest but real win; swings ~0.9-1.5x run-to-run (DOM marshal dominated). [check:annotate]
   */
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array | string
  /**
   * @performance MIME lookup: ≈ parity with the JS baseline [check:annotate]
   * @remarks Consistently ~1.38-1.44x rust after the 2026-08-12 marshal reduction (cachedMime no longer per-call slices; text.mimeFromExtension memoizes the decoded string). phf table lookup. [check:annotate]
   */
  mimeFromExtension(ext: Uint8Array): Uint8Array | string
  /**
   * @performance Random token: ≈ parity with the JS baseline [check:annotate]
   * @remarks Raw addon vs crypto.getRandomValues baseline. Under Bun the public rust.randomToken delegates to crypto.getRandomValues + native hex (BUN_WINS, same 2n-hex format + 16 MiB guard) — this row measures the raw addon (src/bench/raw-native.ts). [check:annotate]
   */
  randomToken(byteLen: number): Uint8Array | string
  /** Pooled random hex token — writes `byteLen*2` hex chars into `output`. */
  randomTokenInto(byteLen: number, output: Uint8Array): number
  /**
   * @performance URL encode: ~1.9x slower than the JS baseline (1/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.9x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Promotion candidate: 2/3 benchmarks won in the latest run (static: not-competitive). [check:annotate]
   * @remarks Public rust.urlEncode delegates to encodeURIComponent under Bun (BUN_WINS — ~3-4x faster than the FFI crossing; skips the C-ABI call). The rust: column measures the RAW addon (src/bench/raw-native.ts): the small-input FFI crossing loses (~0.58x), but LARGE inputs win (rust:url_encode_large ~1.45x) — the honest report no longer self-compares the built-in. Rust addon remains the Node path. Byte parity pinned by test/unit/features/url.test.ts + test/unit/features/wiring.test.ts. [check:annotate]
   */
  urlEncode(input: Uint8Array): Uint8Array | string
  /**
   * @performance URL decode: ~2.0x slower than the JS baseline (1/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~2.0x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Promotion candidate: 2/3 benchmarks won in the latest run (static: not-competitive). [check:annotate]
   * @remarks Public rust.urlDecode delegates to decodeURIComponent under Bun (BUN_WINS — ~4-8x faster than the FFI crossing; strict UTF-8 semantics match: both throw on malformed/invalid). The rust: column measures the RAW addon (src/bench/raw-native.ts): the small-input FFI crossing loses (~0.55x), but LARGE inputs win (rust:url_decode_large ~3.45x) — the honest report no longer self-compares the built-in. Rust addon remains the Node path and the raw-bytes urlDecodeBytes stays native. Parity pinned by test/unit/features/url.test.ts + test/unit/features/wiring.test.ts. [check:annotate]
   */
  urlDecode(input: Uint8Array): Uint8Array
  /**
   * Strict percent-decode without UTF-8 validation.
   * @performance URL decode (bytes): ≈ parity with the JS baseline [check:annotate]
   * @remarks Raw-bytes percent-decode (no UTF-8 validation, no +→space) vs a hand-rolled JS baseline with identical semantics. Previously unmeasured; added 2026-08-14. [check:annotate]
   */
  urlDecodeBytes(input: Uint8Array): Uint8Array
  /** Reusable-output percent-encode; returns bytes written. */
  urlEncodeInto(input: Uint8Array, output: Uint8Array): number
  /** Reusable-output percent-decode; returns bytes written. */
  urlDecodeInto(input: Uint8Array, output: Uint8Array): number
  /**
   * @performance Email validation: ~8.3x faster than the JS baseline (4/4 tasks won) [check:annotate]
   */
  validateEmail(input: Uint8Array): boolean
  /**
   * @performance UUID validation: ≈ parity with the JS baseline (4/4 tasks won) [check:annotate]
   */
  validateUuid(input: Uint8Array): boolean
  /**
   * @performance IPv4 validation: ≈ parity with the JS baseline (2/2 tasks won) [check:annotate]
   */
  validateIpv4(input: Uint8Array): boolean
  /**
   * @performance IPv6 validation: ~3.0x faster than the JS baseline [check:annotate]
   */
  validateIpv6(input: Uint8Array): boolean
  /**
   * @performance WebSocket accept: ~2.7x faster than the JS baseline (2/2 tasks won) [check:annotate]
   */
  wsAcceptKey(key: Uint8Array): Uint8Array | string
  /** Reusable-output WebSocket accept key (28 bytes); returns bytes written. */
  wsAcceptKeyInto(key: Uint8Array, output: Uint8Array): number

  // ── Low-level / packed scalar ──
  /**
   * @performance HTTP parse: ~5.1x faster than the JS baseline (6/6 tasks won) [check:annotate]
   */
  httpParseRequestPacked(input: Uint8Array): Uint8Array
  /**
   * @performance Query parse: ~6.7x faster than the JS baseline (6/6 tasks won) [check:annotate]
   */
  queryParsePacked(input: Uint8Array): Uint8Array
  /**
   * @performance Cookie parse: ~6.1x faster than the JS baseline (5/5 tasks won) [check:annotate]
   */
  cookieParsePacked(input: Uint8Array): Uint8Array
  /** Reusable-output packed HTTP parse; returns bytes written. */
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number
  /** Reusable-output packed query parse; returns bytes written. */
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /** Reusable-output packed cookie parse; returns bytes written. */
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Parse an application/x-www-form-urlencoded body into packed pairs.
   * @performance Form parse: ~10.0x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks Benchmarked via the FormParser instance (same parser core). [check:annotate]
   */
  formParsePacked(input: Uint8Array): Uint8Array
  /** Pooled packed form parse — writes packed pairs into `output`. */
  formParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Parse a Content-Type header into a structured media type.
   * @performance Media type parse: ~1.3x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.3x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Consistent ~0.71-0.81x (sub-µs FFI crossing vs the JS baseline); use MediaTypeMatcher (precompiled expected) for the zero-alloc match path. [check:annotate]
   */
  parseMediaType(input: Uint8Array): MediaTypeResult
  /**
   * Generate a strong/weak ETag (crc32-based).
   * @performance ETag: ≈ parity with the JS baseline (2/2 tasks won) [check:annotate]
   */
  etag(data: Uint8Array, weak?: boolean): Uint8Array | string
  /** Reusable-output etag; returns bytes written (10 strong / 12 weak). */
  etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number
  /**
   * Format a unix timestamp as an IMF-fixdate HTTP-date.
   * @performance HTTP date: ~1.1x slower than the JS baseline (0/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.1x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Delegates to Date.toUTCString() under Bun (BUN_WINS — ~3.7x faster than the FFI crossing; byte-identical RFC 1123 for HTTP timestamps, incl. leap years/epoch). Rust addon remains the Node path; pooled httpDateInto stays native. [check:annotate]
   */
  httpDate(secs?: number): Uint8Array | string
  /** Reusable-output http-date; returns bytes written (29). Throws if `output` is too small or the year is out of the fixed-width range. */
  httpDateInto(secs: number | undefined, output: Uint8Array): number
  /** Parse an IMF-fixdate HTTP-date back to unix seconds. */
  parseHttpDate(input: Uint8Array): bigint | null
  /** Parse an Accept-Encoding header into ordered preferences. */
  parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[]
  /**
   * Base64 encode (standard by default; url-safe/padding configurable).
   * @performance Base64 encode: ~1.3x slower than the JS baseline (0/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.3x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Delegates to Buffer base64 under Bun for the standard padded, non-url-safe case (BUN_WINS — ~2x faster than the FFI crossing); url-safe/unpadded falls through to native. Rust addon remains the Node path. Parity pinned by test/unit/features/encoding.test.ts. [check:annotate]
   */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array | string
  /**
   * Base64 decode (standard); throws on invalid input.
   * @performance Base64 decode: ≈ parity with the JS baseline (1/2 tasks won) [check:annotate]
   */
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array
  /** Reusable-output base64 encode; returns bytes written. */
  base64EncodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number
  /** Reusable-output base64 decode; returns bytes written. Throws on invalid input. */
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
   * @performance Hex encode: ~1.1x slower than the JS baseline (0/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.1x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Buffer.toString('hex') is native SIMD; pooled hexEncodeInto cuts the loss from ~2.2x to ~1.35x. [check:annotate]
   */
  hexEncode(input: Uint8Array): Uint8Array | string
  /**
   * Hex decode; throws on odd length or invalid digits.
   * @performance Hex decode: ≈ parity with the JS baseline (1/2 tasks won) [check:annotate]
   * @remarks Slightly slower than Buffer hex decode (~1.3x). [check:annotate]
   */
  hexDecode(input: Uint8Array): Uint8Array
  /** Reusable-output lowercase-hex encode; returns bytes written. */
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number
  /** Reusable-output hex decode; returns bytes written. Throws on bad input. */
  hexDecodeInto(input: Uint8Array, output: Uint8Array): number
  /** Reusable-output HMAC-SHA256 hex (64 bytes); returns bytes written. Throws on too-small buffer. */
  hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number
  /** Reusable-output cookie sign (`value.<64-hex>`); returns bytes written. Throws on too-small buffer. */
  signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number
  /** Reusable-output cookie verify; returns value length or `null` on bad signature. */
  verifyCookieInto(signed: Uint8Array, secret: Uint8Array, output: Uint8Array): number | null
  /** Reusable-output CSRF token (129 bytes); returns bytes written. Throws on too-small buffer. */
  csrfTokenInto(secret: Uint8Array, output: Uint8Array): number
  /** Reusable-output AEAD encrypt (ct + 16-byte tag); returns bytes written. Throws on too-small buffer. */
  aeadEncryptInto(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    output: Uint8Array,
    algorithm?: string | null,
  ): number
  /** Reusable-output WS frame encode; returns bytes written. Throws on too-small buffer. */
  wsFrameEncodeInto(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
    output: Uint8Array,
  ): number
  /** Reusable-output gzip compress; returns bytes written. Throws on too-small buffer. */
  gzipCompressInto(data: Uint8Array, output: Uint8Array, level?: number | null): number
  /** Reusable-output brotli compress; returns bytes written. Throws on too-small buffer. */
  brotliCompressInto(data: Uint8Array, output: Uint8Array, quality?: number | null): number
  /**
   * Sign a cookie value as `value.signature` (HMAC-SHA256 hex).
   * @performance Cookie sign: ~1.6x faster than the JS baseline [check:annotate]
   */
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array | string
  /**
   * Verify a signed cookie; returns the value or null.
   * @performance Cookie verify: ~2.8x faster than the JS baseline [check:annotate]
   */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | string | null
  /**
   * Create a CSRF token (32-byte random hex + HMAC signature).
   * @performance CSRF create: ~13.5x faster than the JS baseline [check:annotate]
   */
  csrfToken(secret: Uint8Array): Uint8Array | string
  /**
   * Constant-time verify a CSRF token.
   * @performance CSRF verify: ~2.9x faster than the JS baseline [check:annotate]
   */
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean
  /**
   * Resolve a URL reference against a base (RFC 3986).
   * @performance URL resolve: ≈ parity with the JS baseline [check:annotate]
   * @remarks Noisy ~1.5µs op; swings 0.74-1.03x run-to-run. UrlBuilder reuses the parsed base. [check:annotate]
   */
  urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array | string
  /**
   * Build a percent-encoded query string from params (sorted keys).
   * @performance URL query build: ~1.6x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.6x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks encodeURIComponent baseline wins (~1.2-1.35x). [check:annotate]
   */
  urlEncodeQuery(params: Record<string, string>): Uint8Array | string

  // ── Factories / runtime ──
  /**
   * @performance JSON schema validate: ~2.3x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks Zero-DOM fast path validates raw bytes for the common keyword subset (scalar ~1.2-2.4x, batch ~1.0-1.56x vs ajv); unsupported keywords fall back to the jsonschema crate. [check:annotate]
   */
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance
  createHmacSigner(key: Uint8Array): HmacSignerInstance
  createTemplateRenderer(source: string): TemplateRendererInstance
  /** Higher-order form parser: owns a reusable output buffer (setup once). */
  createFormParser(capacity?: number): FormParserInstance
  /** Higher-order media-type parser: reusable wildcard matcher. */
  createMediaTypeParser(): MediaTypeParserInstance
  /**
   * Higher-order conditional-request check: per-resource 304 decision (setup once).
   * @performance Conditional request: ~1.6x faster than the JS baseline [check:annotate]
   */
  createConditionalRequest(
    etagValue: Uint8Array,
    lastModifiedSecs?: number,
  ): ConditionalRequestInstance
  /**
   * Higher-order negotiator: precompiles supported encodings once.
   * @performance Accept-Encoding negotiate: ~4.5x faster than the JS baseline [check:annotate]
   */
  createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance
  /** Higher-order codec: base64 config compiled once. */
  createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance
  /** Higher-order cookie signer: HMAC key compiled once. */
  createCookieSigner(secret: Uint8Array): CookieSignerInstance
  /** Higher-order CSRF protector: HMAC key compiled once. */
  createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance
  /** Higher-order URL builder: base parsed once, reused. */
  createUrlBuilder(base: Uint8Array): UrlBuilderInstance
  /** Higher-order JWT signer: HS256 key + ttl compiled once. */
  createJwtSigner(secret: Uint8Array, ttlSeconds?: number): JwtSignerInstance
  /** Higher-order AEAD cipher: algorithm + key compiled once. */
  createAeadCipher(key: Uint8Array, algorithm?: string): AeadCipherInstance
  /** Higher-order argon2id hasher: params compiled once. */
  createArgon2Hasher(options?: PasswordHashOptions | null): Argon2HasherInstance
  /** Higher-order media-type matcher: expected precompiled once. */
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
  /**
   * @performance JWT sign: ~1.5x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.5x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Base64 + claims DOM marshal overhead. Use jwtSignBytes (claims as JSON bytes) which skips the napi Value marshal and flips to a ~1.07x win. [check:annotate]
   */
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
   * @performance JWT sign (bytes): ≈ parity with the JS baseline [check:annotate]
   * @remarks Byte-JSON claims overload avoids the napi serde_json::Value DOM marshal; flips jwtSign from a ~1.3x loss to ~1.07x (parity). [check:annotate]
   */
  jwtSignBytes(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array | string
  /** Reusable-output JWT sign; returns bytes written. Throws on too-small buffer. */
  jwtSignBytesInto(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    output: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): number
  /**
   * @performance JWT verify: ~1.2x faster than the JS baseline (2/2 tasks won) [check:annotate]
   */
  jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds?: number): unknown
  /**
   * @performance Password hash: ~19.2x faster than the JS baseline (2/2 tasks won) [check:annotate]
   * @remarks argon2id vs node:crypto scrypt. [check:annotate]
   */
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array | string
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean
  /**
   * bcrypt password hash → `$2b$` PHC string (cost clamped 4..=31).
   * @performance Password hash (bcrypt): ≈ parity with the JS baseline [check:annotate]
   * @remarks Bun.password.bcrypt ~1.24x faster at cost 10 (noisy KDF); rust is self-contained and non-Bun. See docs/bun-builtins-decision-matrix.md. [check:annotate]
   */
  passwordHashBcrypt(password: Uint8Array, cost: number): string
  /**
   * Verify a password against a bcrypt `$2b$` PHC string.
   * @performance Password verify (bcrypt): ≈ parity with the JS baseline [check:annotate]
   * @remarks Rust ~1.49x vs Bun.password.verify at cost 10; KDF timings noisy — parity for gate stability. [check:annotate]
   */
  passwordVerifyBcrypt(password: Uint8Array, hash: string): boolean
  /**
   * PBKDF2-HMAC-SHA256 key derivation (dkLen clamped to 1 MiB).
   * @performance PBKDF2-HMAC-SHA256: ≈ parity with the JS baseline [check:annotate]
   * @remarks ~1.08x vs node:crypto pbkdf2Sync at 100k rounds (parity); Bun has no synchronous PBKDF2. [check:annotate]
   */
  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, rounds: number, dkLen: number): Uint8Array
  /**
   * @performance AEAD encrypt: ~2.0x faster than the JS baseline (2/2 tasks won) [check:annotate]
   */
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  /**
   * @performance AEAD decrypt: ~2.4x faster than the JS baseline [check:annotate]
   */
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array | null
  /**
   * @performance Gzip compress: ≈ parity with the JS baseline (1/3 tasks won) [check:annotate]
   * @remarks Raw addon vs node zlib baseline. Under Bun the public rust.gzipCompress delegates to Bun.gzipSync (BUN_WINS, ~2x; decompression-parity with the addon — only the header OS byte differs) — this row measures the raw addon (src/bench/raw-native.ts). [check:annotate]
   */
  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array
  /**
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   * @performance Gzip decompress: ~1.2x faster than the JS baseline [check:annotate]
   * @remarks zlib-rs vs node zlib; swings 1.0-1.4x run-to-run. Deliberately NOT delegated to Bun.gunzipSync under Bun (NOT in BUN_WINS): Bun's decompressor has no output-size bound, and the native path keeps the 64 MiB decompression-bomb cap. [check:annotate]
   */
  gzipDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array
  /**
   * @performance Brotli compress: ~1.9x slower than the JS baseline (2/2 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.9x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks The native brotli baseline wins for small inputs. [check:annotate]
   */
  brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array
  /**
   * @param maxDecompressed Caps decompressed output (default 64 MiB) as a
   *   decompression-bomb guard; a larger value errors.
   * @performance Brotli decompress: ~1.7x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.7x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Auto-deprecated: 1/1 benchmarks failed in the latest run (static classification was proven). [check:annotate]
   */
  brotliDecompress(data: Uint8Array, maxDecompressed?: number | null): Uint8Array
  /**
   * @performance Multipart parse: ~1.5x faster than the JS baseline [check:annotate]
   */
  multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[]
  /** Zero-copy packed sibling of `multipartParse` (packed parts layout). */
  multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array
  /** Pooled packed multipart parse — writes the packed parts layout into `output`. */
  multipartParsePackedInto(body: Uint8Array, boundary: Uint8Array, output: Uint8Array): number
  /**
   * @performance WS frame encode: ~1.9x faster than the JS baseline (2/2 tasks won) [check:annotate]
   */
  wsFrameEncode(opcode: number, payload: Uint8Array, mask: boolean, fin: boolean): Uint8Array
  /**
   * @performance WS frame decode: ~3.3x faster than the JS baseline [check:annotate]
   */
  wsFrameDecode(data: Uint8Array): WsFrame | null
  /** Pooled packed WS-frame decode — writes packed `[flags][opcode][u32 len][payload]`. */
  wsFrameDecodePackedInto(data: Uint8Array, output: Uint8Array): number | null
  /**
   * @performance SSE encode: ≈ parity with the JS baseline (2/2 tasks won) [check:annotate]
   */
  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array
  /** Pooled SSE encode — writes into `output` (sized ≥ `data.length + 64`); returns bytes written. */
  sseEncodeEventInto(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
    output: Uint8Array,
  ): number
}
