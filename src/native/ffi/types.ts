// src/native/ffi/types.ts — bun:ffi C-ABI type surface (pure types).
//
// The bound-function contract (`BunFFI`), the transport selection
// (`FfiMode`), and the raw `(ptr,len)` symbol signatures (`Raw2..Raw10`)
// used by the transport core. No runtime code — erased at compile time.

/**
 * The bound bun:ffi C-ABI surface. Each member is a dlopen'd `castrum_*`
 * symbol wrapped so inputs are `(ptr,len)` byte slices and text outputs are
 * returned as JS strings via JSC's native transfer (cstring clone) — zero
 * `TextEncoder`/`TextDecoder` on the Bun path. `*Into` variants write into a
 * caller buffer and return the byte count; variable-size ops return the exact
 * required size on a too-small buffer so the transport grows once and retries
 * exactly once.
 */
export interface BunFFI {
  crc32(input: Uint8Array): number
  fnv1a64(input: Uint8Array): bigint
  xxh3(input: Uint8Array): bigint
  jsonValid(input: Uint8Array): boolean
  /** UTF-8 validity probe (native replacement for a fatal `TextDecoder`). */
  utf8Valid(input: Uint8Array): boolean
  /** Lowercase-hex encode → string (native transfer, zero encode). */
  hexEncode(input: Uint8Array): string
  /** Lowercase-hex encode into `output`; returns bytes written. */
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number
  /** RFC 3986 percent-encode → string. */
  urlEncode(input: Uint8Array): string
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
  /** RFC 6455 Sec-WebSocket-Accept → string (cstring return). */
  wsAcceptKey(key: Uint8Array): string
  /** RFC 6455 Sec-WebSocket-Accept into `output`; returns bytes written. */
  wsAcceptKeyInto(key: Uint8Array, output: Uint8Array): number
  /** crc32 ETag → string (10 strong / 12 weak chars, cstring return). */
  etag(data: Uint8Array, weak?: boolean): string
  /** crc32 ETag into `output`; returns bytes written. */
  etagInto(data: Uint8Array, output: Uint8Array, weak?: boolean): number
  /** Evaluate a precompiled `ConditionalRequest` (opaque `inner` handle from its
   * napi `inner_ptr()`) — true → 304. `null` header args = absent (flags encode
   * presence so a present-but-empty header is distinct). A null (0) handle → false. */
  conditionalIsNotModified(
    inner: number,
    ifNoneMatch: Uint8Array | null,
    ifModifiedSince: Uint8Array | null,
  ): boolean
  /** Precompiled `MediaTypeMatcher` wildcard match (opaque `inner` handle). */
  mediaTypeMatcherMatches(inner: number, actual: Uint8Array): boolean
  /** Precompiled `AcceptNegotiator` → best supported encoding (opaque `inner`
   * handle); `null` = identity. */
  acceptNegotiatorNegotiate(inner: number, header: Uint8Array): string | null
  /** Precompiled `JwtSigner` → compact token from pre-serialized claim JSON
   * (opaque `inner` handle); throws on invalid claims / null handle. */
  jwtSignerSign(inner: number, claimsJson: Uint8Array, nowSeconds: number): Uint8Array
  /** Precompiled `JwtSigner` → claims JSON bytes (opaque `inner` handle);
   * `null` = invalid signature / expired / malformed. */
  jwtSignerVerify(inner: number, token: Uint8Array, nowSeconds: number): Uint8Array | null
  /** Compiled `TemplateRenderer` → UTF-8 bytes from a pre-serialized JSON
   * context (opaque `inner` handle); throws on invalid context / render error. */
  templateRender(inner: number, contextJson: Uint8Array): Uint8Array
  /** Compiled `SchemaValidator` → whether a document is valid (opaque `inner` handle). */
  schemaValidatorValidate(inner: number, doc: Uint8Array): boolean
  /** `RateLimiter` string-key check → { allowed, remaining, resetMs } (opaque
   * `inner` handle); throws on a null handle. */
  rateLimiterCheck(inner: number, key: Uint8Array, nowMs: number): RateLimiterVerdict
  /** `RateLimiter` pre-hashed key check → { allowed, remaining, resetMs }. */
  rateLimiterCheckKey(inner: number, key: number, nowMs: number): RateLimiterVerdict
  /** `byteLen` random bytes → `byteLen * 2` hex-char string (cstring return). */
  randomToken(byteLen: number): string
  /** base64-encode → string. */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): string
  /** base64-encode into `output`; returns bytes written. */
  base64EncodeInto(
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number
  /** HMAC-SHA256 → 64-char lowercase-hex string. */
  hmacSha256(key: Uint8Array, data: Uint8Array): string
  /** HMAC-SHA256 hex into `output`; returns bytes written (throws if too small). */
  hmacSha256Into(key: Uint8Array, data: Uint8Array, output: Uint8Array): number
  /** Sign cookie `value` as `value.<64-hex>` → string (cstring return). */
  signCookie(value: Uint8Array, secret: Uint8Array): string
  /** Sign cookie into `output`; returns bytes written (throws if too small). */
  signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number
  /** Verify a signed cookie → value string, or `null` on bad signature. */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): string | null
  /** Verify a signed cookie into `output`; returns value length or `null` on bad signature. */
  verifyCookieInto(signed: Uint8Array, secret: Uint8Array, output: Uint8Array): number | null
  /** CSRF token (129 chars: 64 rnd-hex + '.' + 64 sig-hex) → string. */
  csrfToken(secret: Uint8Array): string
  /** CSRF token into `output`; returns bytes written (throws if too small). */
  csrfTokenInto(secret: Uint8Array, output: Uint8Array): number
  /** Argon2id PHC hash → string (m/t/p/out_len params). */
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    mCost: number,
    tCost: number,
    pCost: number,
    outLen: number,
  ): string
  /** bcrypt `$2b$` PHC → string (cost clamped 4..=31). */
  passwordHashBcrypt(password: Uint8Array, cost: number): string
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
  /** RFC 6902 JSON patch → JSON text string. */
  jsonPatch(doc: Uint8Array, patch: Uint8Array): string
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
  /** Sign JWT (HS256) from pre-serialized claim JSON (ttl<=0 → no iat/exp) → string. */
  jwtSignBytes(claimsJson: Uint8Array, secret: Uint8Array, ttl: number, now: number): string
  /** Sign JWT into `output`; returns bytes written (throws if too small). */
  jwtSignBytesInto(
    claimsJson: Uint8Array,
    secret: Uint8Array,
    ttl: number,
    now: number,
    output: Uint8Array,
  ): number
  /** Decode a WS frame into packed `[flags][opcode][u32 len][payload]`; null on malformed. */
  wsFrameDecodePacked(data: Uint8Array): Uint8Array | null
  /**
   * Decode a WS frame into `output` (sized ≥ `data.length + 6`); returns bytes
   * written, null on malformed. Pooled sibling of `wsFrameDecodePacked`.
   */
  wsFrameDecodePackedInto(data: Uint8Array, output: Uint8Array): number | null
  /** Parse multipart/form-data into the packed parts layout. */
  multipartParsePacked(body: Uint8Array, boundary: Uint8Array): Uint8Array
  /** Parse multipart/form-data into `output`; returns bytes written (throws if too small). */
  multipartParsePackedInto(body: Uint8Array, boundary: Uint8Array, output: Uint8Array): number
  /** Parse x-www-form-urlencoded into packed pairs into `output`. */
  formParsePackedInto(input: Uint8Array, output: Uint8Array): number
  /**
   * Verify an HS256 JWT → claims JSON text (cstring return; `null` on invalid
   * signature / expired / malformed). `nowSeconds` is an i64 C arg.
   */
  jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds: number): string | null
  /**
   * Parse JSON → packed token stream bytes (structural, no re-parse). Layout:
   * `[u32 strCount]{[u32 len][utf8]}... [u32 treeLen][tree]` — a deduplicated
   * string table followed by a start/end-marker value tree:
   * `0=null 1=false 2=true 3=number(f64 LE) 4=string(u32 table idx)
   * 5=array start 6=object start 7=array end 8=object end
   * 9=object key(u32 table idx)` (object body `6,(9,keyIdx,value)*,8`).
   * Throws on invalid JSON / too-small output. The scalar wrapper decodes the
   * table once and assembles the value — no second parse.
   */
  jsonParsePacked(input: Uint8Array): Uint8Array
  /**
   * Parse a Content-Type header → packed verdict bytes:
   * `[u32 mediaTypeLen][mediaType][u32 charsetLen (0xFFFFFFFF = none)][charset]
   * [u32 boundaryLen][boundary][u32 paramCount]{[u32 keyLen][key][u32 valLen][val]}`.
   * Throws on invalid media type / too-small output.
   */
  parseMediaType(input: Uint8Array): Uint8Array
  /** Parse an IMF-fixdate → unix seconds, or `null` on malformed (packed
   * `[u8 ok][i64 secs LE]` output, decoded here). */
  parseHttpDate(input: Uint8Array): bigint | null
  /**
   * Parse an Accept-Encoding header → packed verdict bytes:
   * `[u32 count]{[u32 encLen][enc][f32 q][u32 order]}` (empty header → count 0).
   * Throws on too-small output.
   */
  parseAcceptEncoding(input: Uint8Array): Uint8Array
  /** Percent-encode a query from packed pairs (the `packPairs` layout) → string,
   * keys SORTED (matches napi `BTreeMap` ordering); `null` on malformed input. */
  urlEncodeQuery(input: Uint8Array): string | null
  /** RFC 3986 URL resolution (base + reference) → string; `null` on non-UTF-8. */
  urlResolve(base: Uint8Array, reference: Uint8Array): string | null
  /** Resolve a reference against a `UrlBuilder`'s PRECOMPILED base (opaque
   * `inner` handle from its napi `inner_ptr()`) → bytes; throws on a null
   * handle / non-UTF-8 reference / too-small output. */
  urlBuilderResolve(inner: number, reference: Uint8Array): Uint8Array
  /** Extension → MIME type → string (unknown → `application/octet-stream`). */
  mimeFromExtension(ext: Uint8Array): string | null
  /**
   * 29-byte HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`) into `output`; returns
   * bytes written (throws on too-small / out-of-range year). FFI sibling of the
   * napi `httpDateInto` — kills the napi crossing on the hot path.
   */
  httpDateInto(secs: number, output: Uint8Array): number
  /** 29-byte HTTP-date → string (allocating sibling of httpDateInto). */
  httpDate(secs?: number): string
  /**
   * Encode one SSE event → bytes (fresh buffer). event/id null = line omitted
   * (a present-but-empty string emits the line, matching napi `Option`).
   * FFI sibling of the napi `sse_encode_event` — kills the napi crossing.
   */
  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array
  /**
   * Encode one SSE event into `output` (sized ≥ `data.length + 64`); returns
   * bytes written (throws if too small / invalid UTF-8). Pooled sibling of
   * `sseEncodeEvent` — removes the per-call output-buffer alloc.
   */
  sseEncodeEventInto(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
    output: Uint8Array,
  ): number
  /** Random hex token into `output`; returns bytes written (throws if too small). */
  randomTokenInto(byteLen: number, output: Uint8Array): number
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

/** Unpacked rate-limit verdict (from the packed
 * `[u8 allowed][u32 remaining LE][i64 reset_ms LE]` C-ABI output). */
export interface RateLimiterVerdict {
  allowed: boolean
  remaining: number
  resetMs: number
}

/** Raw 2-arg C-ABI symbol signature (`(ptr,len)` pairs → scalar result). */
export type Raw2 = (a: unknown, b: unknown) => number | bigint
/** Raw 3-arg C-ABI symbol signature. */
export type Raw3 = (a: unknown, b: unknown, c: unknown) => number | bigint
/** Raw 4-arg C-ABI symbol signature. */
export type Raw4 = (a: unknown, b: unknown, c: unknown, d: unknown) => number | bigint
/** Raw 5-arg C-ABI symbol signature. */
export type Raw5 = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown) => number | bigint
/** Raw 6-arg C-ABI symbol signature. */
export type Raw6 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
) => number | bigint
/** Raw 7-arg C-ABI symbol signature. */
export type Raw7 = (
  a: unknown,
  b: unknown,
  c: unknown,
  d: unknown,
  e: unknown,
  f: unknown,
  g: unknown,
) => number | bigint
/** Raw 8-arg C-ABI symbol signature. */
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
/** Raw 9-arg C-ABI symbol signature. */
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
/** Raw 10-arg C-ABI symbol signature. */
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

/** A raw C-ABI symbol whose return type is `cstring` — the engine clones the
 * null-terminated string at return (`null` = C NULL, i.e. a failure sentinel).
 * Used by the fixed-size ASCII writers (ws_accept_key, etag, random_token,
 * sign/verify_cookie, csrf_token, jwt_sign_bytes).
 */
export type RawCStr = (...a: unknown[]) => string | null
