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
  validateBatchPackedCount(packed: Uint8Array): number;
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array;
  validateBatchStreaming(batchBytes: Uint8Array): number;
}

/** The native `HmacSigner` class instance. */
export interface HmacSignerInstance {
  sign(data: Uint8Array): Uint8Array;
  verify(data: Uint8Array, sig: Uint8Array): boolean;
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
  jsonSumIds(input: Uint8Array): bigint;

  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;

  mimeFromExtension(ext: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;

  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  urlDecodeBytes(input: Uint8Array): Uint8Array;

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
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array;

  httpParseRequestPacked(input: Uint8Array): Uint8Array;

  queryParsePacked(input: Uint8Array): Uint8Array;

  cookieParsePacked(input: Uint8Array): Uint8Array;

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
