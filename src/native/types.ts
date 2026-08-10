// src/native/types.ts — Type declarations for the native addon surface.
//
// The `NativeAddon` interface mirrors the napi-rs generated declaration
// (index.d.ts) and types every class + function + layout constant exported by
// the Rust cdylib. Keeping it separate from the loader (./loader.ts) means
// type-only consumers never pull in the file-system loading logic.

/** The native Ingress class instance (hot-path pipeline). */
export interface IngressInstance {
  handleRequestPacked(
    input: Uint8Array,
    body: Uint8Array | null,
    output: Uint8Array,
  ): number;

  handleRequestFullSync(
    methodKind: number,
    url: string,
    ip: string,
    requestId: string,
    headers: Array<[string, string]>,
    body: Uint8Array | null,
    outputBufferSize?: number,
  ): Uint8Array;

  /**
   * Reusable-output variant of `handleRequestFullSync`: packs the request in
   * Rust and writes the packed decision into `output`, returning the number of
   * bytes written. Pool the output buffer across requests to avoid per-request
   * allocation (see `src/shared/buffer-pool.ts`).
   */
  handleRequestFullSyncInto(
    methodKind: number,
    url: string,
    ip: string,
    requestId: string,
    headers: Array<[string, string]>,
    body: Uint8Array | null,
    output: Uint8Array,
  ): number;
}

/** The native `SchemaValidator` class instance. */
export interface SchemaValidatorInstance {
  /** Validate a single JSON document. */
  validate(input: Uint8Array): boolean;
  validateBatchPackedCount(packed: Uint8Array): number;
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array;
  validateBatchStreaming(batchBytes: Uint8Array): number;
}

/** The native `HmacSigner` class instance. */
export interface HmacSignerInstance {
  sign(data: Uint8Array): Uint8Array;
  verify(data: Uint8Array, sig: Uint8Array): boolean;
}

/** The native `FormParser` class instance (reusable output buffer). */
export interface FormParserInstance {
  /** Parse an x-www-form-urlencoded body into packed pairs (reuses the buffer). */
  parse(input: Uint8Array): Uint8Array;
  /** Zero-alloc parse into a caller-provided output buffer. */
  parseInto(input: Uint8Array, output: Uint8Array): number;
}

/** A parsed Content-Type / media type. */
export interface MediaTypeResult {
  /** Lowercased `type/subtype`. */
  mediaType: string;
  charset: string | null;
  boundary: string | null;
  params: Record<string, string>;
}

/** The native `MediaTypeParser` class instance. */
export interface MediaTypeParserInstance {
  parse(input: Uint8Array): MediaTypeResult;
  /** Wildcard match: any/any, type/any, or exact type/subtype. */
  matches(actual: Uint8Array, expected: Uint8Array): boolean;
}

/** The native `ConditionalRequest` class instance (per-resource 304 checks). */
export interface ConditionalRequestInstance {
  isNotModified(
    ifNoneMatch: Uint8Array | null,
    ifModifiedSince: Uint8Array | null,
  ): boolean;
}

/** One parsed Accept-Encoding preference. */
export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

/** The native `AcceptNegotiator` class instance. */
export interface AcceptNegotiatorInstance {
  /** Best supported encoding for `header`, or null for identity. */
  negotiate(header: Uint8Array): string | null;
}

/** The native `Base64Codec` class instance (config compiled once). */
export interface Base64CodecInstance {
  encode(input: Uint8Array): Uint8Array;
  decode(input: Uint8Array): Uint8Array;
}

/** The native `CookieSigner` class instance (HMAC key compiled once). */
export interface CookieSignerInstance {
  sign(value: Uint8Array): Uint8Array;
  /** Returns the signed value without its signature, or null on invalid. */
  verify(signed: Uint8Array): Uint8Array | null;
}

/** The native `CsrfProtector` class instance (HMAC key compiled once). */
export interface CsrfProtectorInstance {
  create(): Uint8Array;
  verify(token: Uint8Array): boolean;
}

/** The native `UrlBuilder` class instance (base parsed once). */
export interface UrlBuilderInstance {
  resolve(reference: Uint8Array): Uint8Array;
}

/** Options for `passwordHash` (argon2id). */
export interface PasswordHashOptions {
  mCost?: number;
  tCost?: number;
  pCost?: number;
  outLen?: number;
}

/** A parsed multipart/form-data part. */
export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Uint8Array;
}

/** A decoded RFC 6455 websocket frame. */
export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** The native `TemplateRenderer` class instance. */
export interface TemplateRendererInstance {
  render(context: unknown): Uint8Array;
  /** Parallel batch render: packed contexts in → packed rendered out. */
  renderBatchPacked(data: Uint8Array): Uint8Array;
}

/** The native `MediaTypeMatcher` class instance (expected precompiled once). */
export interface MediaTypeMatcherInstance {
  /** Wildcard match against the precompiled expected type. */
  matches(actual: Uint8Array): boolean;
}

/** The native `JwtSigner` class instance (HS256 key + ttl compiled once). */
export interface JwtSignerInstance {
  sign(claims: unknown, nowSeconds: number): Uint8Array;
  verify(token: Uint8Array, nowSeconds: number): unknown;
}

/** The native `AeadCipher` class instance (algorithm + key compiled once). */
export interface AeadCipherInstance {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array | null;
}

/** The native `Argon2Hasher` class instance (params compiled once). */
export interface Argon2HasherInstance {
  hash(password: Uint8Array, salt: Uint8Array): Uint8Array;
  verify(password: Uint8Array, phc: Uint8Array): boolean;
}

/**
 * Full shape of the native addon module: classes, scalar/batch functions and
 * the ingress binary-layout constants (single source of truth:
 * rust/ingress_constants.rs).
 */
export interface NativeAddon {
  HmacSigner: new (key: Uint8Array) => HmacSignerInstance;
  Ingress: new (options: Record<string, unknown>) => IngressInstance;

  // ── Ingress binary-layout constants (single source of truth: rust/ingress_constants.rs) ──
  INGRESS_OUT_VERDICT: number;
  INGRESS_OUT_ERROR_CODE: number;
  INGRESS_OUT_STATUS: number;
  INGRESS_OUT_FLAGS: number;
  INGRESS_OUT_RATE_LIMIT: number;
  INGRESS_OUT_RATE_REMAINING: number;
  INGRESS_OUT_RATE_RESET: number;
  INGRESS_OUT_RETRY_AFTER: number;
  INGRESS_OUT_COOKIES_JSON_LEN: number;
  INGRESS_OUT_QUERY_JSON_LEN: number;
  INGRESS_OUT_HEADER_VARIANT: number;
  INGRESS_OUT_BODY_JSON_LEN: number;
  INGRESS_OUT_DATA_START: number;
  INGRESS_FLAG_HAS_COOKIES: number;
  INGRESS_FLAG_HAS_QUERY: number;
  INGRESS_FLAG_BODY_VALID_JSON: number;
  INGRESS_FLAG_SCHEMA_VALID: number;
  INGRESS_FLAG_CORS_ALLOWED: number;
  INGRESS_FLAG_IS_PREFLIGHT: number;
  INGRESS_FLAG_RATE_LIMITED: number;
  INGRESS_FLAG_HTTPS: number;
  INGRESS_FLAG_TRUSTED_PROXY: number;
  INGRESS_FLAG_BODY_TRUNCATED: number;
  INGRESS_HV_JSON: number;
  INGRESS_HV_CORS_SIMPLE: number;
  INGRESS_HV_CORS_PREFLIGHT: number;
  INGRESS_HV_RATE_ACTIVE: number;
  INGRESS_HV_RATE_LIMITED: number;
  INGRESS_HV_COUNT: number;
  INGRESS_ERR_NONE: number;
  INGRESS_ERR_CORS_PREFLIGHT: number;
  INGRESS_ERR_RATE_LIMITED: number;
  INGRESS_ERR_BODY_TOO_LARGE: number;
  INGRESS_ERR_INVALID_JSON: number;
  INGRESS_ERR_SCHEMA_VALIDATION: number;
  INGRESS_ERR_BAD_REQUEST: number;
  INGRESS_ERR_REQUEST_TOO_LARGE: number;
  INGRESS_ERR_INTERNAL: number;

  crc32(input: Uint8Array): number;
  fnv1a64(input: Uint8Array): bigint;

  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean;

  jsonValid(input: Uint8Array): boolean;
  jsonParse(input: Uint8Array): unknown;
  jsonSumIds(input: Uint8Array): bigint;

  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
  /** Batch RFC 6902 JSON Patch (two packed lists, zipped) → packed results. */
  jsonPatchBatchPacked(docs: Uint8Array, patches: Uint8Array): Uint8Array;

  mimeFromExtension(ext: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;

  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  urlDecodeBytes(input: Uint8Array): Uint8Array;
  /** Reusable-output percent-encode; returns bytes written. Throws if `output` is too small. */
  urlEncodeInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output percent-decode; returns bytes written. Throws if `output` is too small. */
  urlDecodeInto(input: Uint8Array, output: Uint8Array): number;

  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;

  wsAcceptKey(key: Uint8Array): Uint8Array;

  // ── Backend-framework features ──
  jwtSign(
    claims: unknown,
    secret: Uint8Array,
    ttlSeconds: number | null,
    nowSeconds: number,
  ): Uint8Array;
  jwtVerify(
    token: Uint8Array,
    secret: Uint8Array,
    nowSeconds: number,
  ): unknown;

  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array;
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean;
  passwordHashBatchPacked(
    data: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array;

  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array;
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array | null;
  aeadEncryptBatchPacked(
    data: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array;
  aeadDecryptBatchPacked(
    data: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array;

  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
  gzipDecompress(data: Uint8Array): Uint8Array;
  brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
  brotliDecompress(data: Uint8Array): Uint8Array;
  gzipCompressBatchPacked(data: Uint8Array, level?: number | null): Uint8Array;
  gzipDecompressBatchPacked(data: Uint8Array): Uint8Array;
  brotliCompressBatchPacked(data: Uint8Array, quality?: number | null): Uint8Array;
  brotliDecompressBatchPacked(data: Uint8Array): Uint8Array;

  multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[];
  multipartParseBatchPacked(data: Uint8Array, boundary: Uint8Array): Uint8Array;
  jwtSignBatchPacked(
    data: Uint8Array,
    secret: Uint8Array,
    ttlSeconds: number | null,
    nowSeconds: number,
  ): Uint8Array;
  jwtVerifyBatchPacked(
    data: Uint8Array,
    secret: Uint8Array,
    nowSeconds: number,
  ): Uint8Array;

  TemplateRenderer: new (source: string) => TemplateRendererInstance;
  templateRenderBatchPacked(data: Uint8Array, source: string): Uint8Array;
  JwtSigner: new (
    secret: Uint8Array,
    ttlSeconds?: number | null,
  ) => JwtSignerInstance;
  AeadCipher: new (
    key: Uint8Array,
    algorithm?: string | null,
  ) => AeadCipherInstance;
  Argon2Hasher: new (
    options?: PasswordHashOptions | null,
  ) => Argon2HasherInstance;
  MediaTypeMatcher: new (expected: Uint8Array) => MediaTypeMatcherInstance;

  wsFrameEncode(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
  ): Uint8Array;
  wsFrameDecode(data: Uint8Array): WsFrame | null;
  wsFrameEncodeBatchPacked(
    data: Uint8Array,
    opcode: number,
    mask: boolean,
    fin: boolean,
  ): Uint8Array;
  wsFrameDecodeBatchPacked(data: Uint8Array): Uint8Array;

  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array;
  sseEncodeBatchPacked(
    data: Uint8Array,
    event: string | null,
    id: string | null,
    retry: number | null,
  ): Uint8Array;

  SchemaValidator: new (schema: Uint8Array) => SchemaValidatorInstance;
  FormParser: new (capacity?: number) => FormParserInstance;
  MediaTypeParser: new () => MediaTypeParserInstance;
  ConditionalRequest: new (
    etagValue: Uint8Array,
    lastModifiedSecs?: number,
  ) => ConditionalRequestInstance;
  AcceptNegotiator: new (supported: string[]) => AcceptNegotiatorInstance;
  Base64Codec: new (urlSafe?: boolean, padding?: boolean) => Base64CodecInstance;
  CookieSigner: new (secret: Uint8Array) => CookieSignerInstance;
  CsrfProtector: new (secret: Uint8Array) => CsrfProtectorInstance;
  UrlBuilder: new (base: Uint8Array) => UrlBuilderInstance;
  parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[];
  urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array;
  urlEncodeQuery(params: Record<string, string>): Uint8Array;
  csrfToken(secret: Uint8Array): Uint8Array;
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
  csrfVerifyBatchPacked(data: Uint8Array, secret: Uint8Array): Uint8Array;
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array;
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null;
  signCookieBatchPacked(data: Uint8Array, secret: Uint8Array): Uint8Array;
  verifyCookieBatchPacked(data: Uint8Array, secret: Uint8Array): Uint8Array;
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  /** Reusable-output base64 encode; returns bytes written. Throws if `output` is too small. */
  base64EncodeInto(input: Uint8Array, output: Uint8Array, urlSafe?: boolean, padding?: boolean): number;
  /** Reusable-output base64 decode; returns bytes written. Throws on invalid input or if `output` is too small. */
  base64DecodeInto(input: Uint8Array, output: Uint8Array, urlSafe?: boolean, padding?: boolean): number;
  base64UrlEncode(input: Uint8Array): Uint8Array;
  base64UrlDecode(input: Uint8Array): Uint8Array;
  hexEncode(input: Uint8Array): Uint8Array;
  hexDecode(input: Uint8Array): Uint8Array;
  /** Reusable-output lowercase-hex encode; returns bytes written. Throws if `output` is too small. */
  hexEncodeInto(input: Uint8Array, output: Uint8Array): number;
  /** Reusable-output hex decode; returns bytes written. Throws on bad input or if `output` is too small. */
  hexDecodeInto(input: Uint8Array, output: Uint8Array): number;
  parseMediaType(input: Uint8Array): MediaTypeResult;
  etag(input: Uint8Array, weak?: boolean): Uint8Array;
  /** Reusable-output etag; returns bytes written (10 strong / 12 weak). Throws if `output` is too small. */
  etagInto(input: Uint8Array, output: Uint8Array, weak?: boolean): number;
  httpDate(secs?: number): Uint8Array;
  parseHttpDate(input: Uint8Array): bigint | null;

  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  jsonValidBatchPacked(input: Uint8Array): Uint8Array;
  validateEmailBatchPacked(input: Uint8Array): Uint8Array;
  validateUuidBatchPacked(input: Uint8Array): Uint8Array;
  validateIpv4BatchPacked(input: Uint8Array): Uint8Array;
  validateIpv6BatchPacked(input: Uint8Array): Uint8Array;

  jsonSumBatchPacked(input: Uint8Array): Uint8Array;
  queryParseBatchPacked(input: Uint8Array): Uint8Array;
  cookieParseBatchPacked(input: Uint8Array): Uint8Array;
  formParseBatchPacked(input: Uint8Array): Uint8Array;
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array;
  hexEncodeBatchPacked(input: Uint8Array): Uint8Array;
  hexDecodeBatchPacked(input: Uint8Array): Uint8Array;
  base64EncodeBatchPacked(
    input: Uint8Array,
    urlSafe?: boolean | null,
    padding?: boolean | null,
  ): Uint8Array;
  base64DecodeBatchPacked(
    input: Uint8Array,
    urlSafe?: boolean | null,
    padding?: boolean | null,
  ): Uint8Array;

  httpParseRequestPacked(input: Uint8Array): Uint8Array;
  /** Reusable-output packed HTTP parse; returns bytes written. Throws if `output` is too small. */
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number;

  queryParsePacked(input: Uint8Array): Uint8Array;
  /** Reusable-output packed query parse; returns bytes written. Throws if `output` is too small. */
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number;

  cookieParsePacked(input: Uint8Array): Uint8Array;
  /** Reusable-output packed cookie parse; returns bytes written. Throws if `output` is too small. */
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number;

  formParsePacked(input: Uint8Array): Uint8Array;

  crc32BatchPacked(input: Uint8Array): Uint8Array;

  // ── Batch metadata / counts ──
  jsonValidBatchCountPacked(input: Uint8Array): number;
  validateEmailBatchCountPacked(input: Uint8Array): number;
  validateUuidBatchCountPacked(input: Uint8Array): number;
  validateIpv4BatchCountPacked(input: Uint8Array): number;
  validateIpv6BatchCountPacked(input: Uint8Array): number;
  jsonSumBatchTotalPacked(input: Uint8Array): number;
  queryParseBatchTotalLenPacked(input: Uint8Array): number;
  cookieParseBatchTotalLenPacked(input: Uint8Array): number;
  httpParseRequestBatchTotalLenPacked(input: Uint8Array): number;
}
