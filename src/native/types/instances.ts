// src/native/types/instances.ts — Native addon class-instance types.
//
// The per-class instance interfaces + their result/option payload types,
// separated from `NativeAddon` (the module surface in ../types.ts) so the
// class-shaped types live in one place. `../types.ts` re-exports everything
// here, so `import { IngressInstance } from '../native/types'` keeps working.

/** The native Ingress class instance (hot-path pipeline). */
export interface IngressInstance {
  handleRequestPacked(input: Uint8Array, body: Uint8Array | null, output: Uint8Array): number

  handleRequestFullSync(
    methodKind: number,
    url: string,
    ip: string,
    requestId: string,
    headers: Array<[string, string]>,
    body: Uint8Array | null,
    outputBufferSize?: number,
  ): Uint8Array

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
  ): number

  /**
   * Opaque handle to the inner pipeline state for the `bun:ffi` fast path.
   * Internal only — the returned pointer is valid only while THIS instance is
   * alive and must never be dereferenced from JS. Present only on addons built
   * with the `castrum_ingress_handle_packed` C-ABI export; guard with
   * `typeof handler.ingressInnerPtr === 'function'`.
   */
  ingressInnerPtr?(): bigint
}

/** A single JSON Schema validation error (fast path + DOM fallback). */
export interface SchemaError {
  /** RFC 6901 JSON pointer to the failing instance value ("" = root). */
  instancePath: string
  /** JSON pointer into the schema at the failing keyword. */
  schemaPath: string
  /** The failing keyword (e.g. "type", "pattern", "required"). */
  keyword: string
  /** Human-readable failure message. */
  message: string
}

/** The native `SchemaValidator` class instance. */
export interface SchemaValidatorInstance {
  /** Validate a single JSON document. */
  validate(input: Uint8Array): boolean
  /** Opaque handle (bun:ffi fast path) — `castrum_schema_validator_validate`. */
  innerPtr?(): bigint
  /** Validate a single JSON document, returning detailed errors (empty = valid). */
  validateDetailed(input: Uint8Array): SchemaError[]
  /** Validate a single JSON document, returning only the first error (null = valid). */
  validateFirstError(input: Uint8Array): SchemaError | null
  validateBatchPackedCount(packed: Uint8Array): number
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array
  /**
   * One-pass validate + extract: validate `input` against the schema and
   * capture scalar values / array lengths at `paths` during the same native
   * walk (no `JSON.parse`, no DOM). For "derive" routes (response built from a
   * handful of body fields) this replaces `JSON.parse` + Ajv on the happy path
   * and rejects invalid bodies with zero DOM/GC.
   *
   * `paths` are RFC 6901 JSON pointers of OBJECT KEYS; a trailing `/-`
   * captures the ARRAY LENGTH at that path (e.g. `"/totalCents"`,
   * `"/lineItems/-"`). Array-index steps are not supported.
   */
  derive(input: Uint8Array, paths: string[]): JsonDeriveResult
}

/** A single derived value captured during one-pass validation. */
export interface JsonDeriveValue {
  /** `"int" | "number" | "string" | "bool" | "null"`. */
  kind: string
  int: number | null
  number: number | null
  text: string | null
  boolean: boolean | null
}

/** Result of a one-pass `validate + derive`. */
export interface JsonDeriveResult {
  /** `true` when the document is schema-valid; `false` → caller rejects. */
  ok: boolean
  /** One entry per requested path (`null` = path absent from the document). */
  values: Array<JsonDeriveValue | null>
}

/** The native `HmacSigner` class instance. */
export interface HmacSignerInstance {
  sign(data: Uint8Array): Uint8Array
  verify(data: Uint8Array, sig: Uint8Array): boolean
}

/** The native `FormParser` class instance (reusable output buffer). */
export interface FormParserInstance {
  /** Parse an x-www-form-urlencoded body into packed pairs (reuses the buffer). */
  parse(input: Uint8Array): Uint8Array
  /** Zero-alloc parse into a caller-provided output buffer. */
  parseInto(input: Uint8Array, output: Uint8Array): number
}

/** A parsed Content-Type / media type. */
export interface MediaTypeResult {
  /** Lowercased `type/subtype`. */
  mediaType: string
  charset: string | null
  boundary: string | null
  params: Record<string, string>
}

/** The native `MediaTypeParser` class instance. */
export interface MediaTypeParserInstance {
  parse(input: Uint8Array): MediaTypeResult
  /** Wildcard match: any/any, type/any, or exact type/subtype. */
  matches(actual: Uint8Array, expected: Uint8Array): boolean
}

/** The native `ConditionalRequest` class instance (per-resource 304 checks). */
export interface ConditionalRequestInstance {
  isNotModified(ifNoneMatch: Uint8Array | null, ifModifiedSince: Uint8Array | null): boolean
  /** Opaque handle to the precompiled state (present when the bun:ffi fast path
   * is active) — `castrum_conditional_is_not_modified` in rust/ffi.rs. */
  innerPtr?(): bigint
}

/** One parsed Accept-Encoding preference. */
export interface EncodingPrefResult {
  encoding: string
  q: number
  order: number
}

/**
 * The native `AcceptNegotiator` class instance (supported encodings compiled
 * once). Best supported encoding for a header, or `null` for identity.
 */
export interface AcceptNegotiatorInstance {
  /** Best supported encoding for `header`, or null for identity. */
  negotiate(header: Uint8Array): string | null
  /** Opaque handle (bun:ffi fast path) — `castrum_accept_negotiator_negotiate`. */
  innerPtr?(): bigint
}

/** The native `Base64Codec` class instance (config compiled once). */
export interface Base64CodecInstance {
  encode(input: Uint8Array): Uint8Array
  decode(input: Uint8Array): Uint8Array
}

/** Result of a native rate-limit check for one key at a point in time. */
export interface RateCheckResult {
  allowed: boolean
  remaining: number
  resetMs: number
}

/** The native `RateLimiter` class instance (sharded fixed-window state). */
export interface RateLimiterInstance {
  check(key: string, nowMs: number): RateCheckResult
  checkKey(key: number, nowMs: number): RateCheckResult
  /** Opaque handle (bun:ffi fast path) — `castrum_rate_limiter_check*`. */
  innerPtr?(): bigint
}

/** The native `CookieSigner` class instance (HMAC key compiled once). */
export interface CookieSignerInstance {
  sign(value: Uint8Array): Uint8Array
  /** Returns the signed value without its signature, or null on invalid. */
  verify(signed: Uint8Array): Uint8Array | null
}

/** The native `CsrfProtector` class instance (HMAC key compiled once). */
export interface CsrfProtectorInstance {
  create(): Uint8Array
  verify(token: Uint8Array): boolean
}

/** The native `UrlBuilder` class instance (base parsed once). */
export interface UrlBuilderInstance {
  resolve(reference: Uint8Array): Uint8Array
  /** Opaque handle to the precompiled base (present when the bun:ffi fast path
   * is active) — `castrum_url_builder_resolve` in rust/ffi.rs. */
  innerPtr?(): bigint
}

/** Options for `passwordHash` (argon2id). */
export interface PasswordHashOptions {
  mCost?: number
  tCost?: number
  pCost?: number
  outLen?: number
}

/** A parsed multipart/form-data part. */
export interface MultipartPart {
  name: string
  filename: string | null
  contentType: string | null
  data: Uint8Array
}

/** A decoded RFC 6455 websocket frame. */
export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Uint8Array
}

/** The native `TemplateRenderer` class instance. */
export interface TemplateRendererInstance {
  render(context: unknown): Uint8Array
  /** Render from pre-serialized JSON context bytes (no napi Value marshal). */
  renderBytes(contextJson: Uint8Array): Uint8Array
  /** Parallel batch render: packed contexts in → packed rendered out. */
  renderBatchPacked(data: Uint8Array): Uint8Array
  /** Opaque handle (bun:ffi fast path) — `castrum_template_render`. */
  innerPtr?(): bigint
}

/** The native `MediaTypeMatcher` class instance (expected precompiled once). */
export interface MediaTypeMatcherInstance {
  /** Wildcard match against the precompiled expected type. */
  matches(actual: Uint8Array): boolean
  /** Opaque handle (bun:ffi fast path) — `castrum_media_type_matcher_matches`. */
  innerPtr?(): bigint
}

/** The native `JwtSigner` class instance (HS256 key + ttl compiled once). */
export interface JwtSignerInstance {
  sign(claims: unknown, nowSeconds: number): Uint8Array
  /** Sign from pre-serialized claim JSON bytes (no napi Value marshal). */
  signBytes(claimsJson: Uint8Array, nowSeconds: number): Uint8Array
  verify(token: Uint8Array, nowSeconds: number): unknown
  /** Opaque handle (bun:ffi fast path) — `castrum_jwt_signer_*`. */
  innerPtr?(): bigint
}

/** The native `AeadCipher` class instance (algorithm + key compiled once). */
export interface AeadCipherInstance {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array | null
}

/** The native `Argon2Hasher` class instance (params compiled once). */
export interface Argon2HasherInstance {
  hash(password: Uint8Array, salt: Uint8Array): Uint8Array
  verify(password: Uint8Array, phc: Uint8Array): boolean
}
