// src/rust-ffi/scalar.ts — Scalar + feature FFI methods.
//
// The byte-level single-value methods of the Rust client (crc32, hmac, json,
// jwt, password, aead, compress, ... plus the class factories and runtime
// controls). Composed into the client by ./client.ts.

import { asBigInt, asNumber } from "./options";
import type { RustClientContext } from "./context";
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
  MultipartPart,
  WsFrame,
  PasswordHashOptions,
} from "../native";

/** Scalar + factory + runtime methods of the Rust client. */
export interface RustScalar {
  // ── Scalar utilities (bytes in → normalized out) ──
  crc32(input: Uint8Array): number;
  fnv1a64(input: Uint8Array): bigint;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha256Verify(
    key: Uint8Array,
    data: Uint8Array,
    sig: Uint8Array,
  ): boolean;
  jsonValid(input: Uint8Array): boolean;
  /** Parse JSON to a JS value (native sonic-rs DOM → napi). Throws on invalid JSON. */
  jsonParse(input: Uint8Array): unknown;
  jsonSumIds(input: Uint8Array): bigint;
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
  mimeFromExtension(ext: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;
  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  /** Strict percent-decode without UTF-8 validation. */
  urlDecodeBytes(input: Uint8Array): Uint8Array;
  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;
  wsAcceptKey(key: Uint8Array): Uint8Array;

  // ── Low-level / packed scalar ──
  httpParseRequestPacked(input: Uint8Array): Uint8Array;
  queryParsePacked(input: Uint8Array): Uint8Array;
  cookieParsePacked(input: Uint8Array): Uint8Array;
  /** Parse an application/x-www-form-urlencoded body into packed pairs. */
  formParsePacked(input: Uint8Array): Uint8Array;
  /** Parse a Content-Type header into a structured media type. */
  parseMediaType(input: Uint8Array): MediaTypeResult;
  /** Generate a strong/weak ETag (crc32-based). */
  etag(data: Uint8Array, weak?: boolean): Uint8Array;
  /** Format a unix timestamp as an IMF-fixdate HTTP-date. */
  httpDate(secs?: number): Uint8Array;
  /** Parse an IMF-fixdate HTTP-date back to unix seconds. */
  parseHttpDate(input: Uint8Array): bigint | null;
  /** Parse an Accept-Encoding header into ordered preferences. */
  parseAcceptEncoding(input: Uint8Array): EncodingPrefResult[];
  /** Base64 encode (standard by default; url-safe/padding configurable). */
  base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  /** Base64 decode (standard); throws on invalid input. */
  base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array;
  base64UrlEncode(input: Uint8Array): Uint8Array;
  base64UrlDecode(input: Uint8Array): Uint8Array;
  /** Lowercase hex encode. */
  hexEncode(input: Uint8Array): Uint8Array;
  /** Hex decode; throws on odd length or invalid digits. */
  hexDecode(input: Uint8Array): Uint8Array;
  /** Sign a cookie value as `value.signature` (HMAC-SHA256 hex). */
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array;
  /** Verify a signed cookie; returns the value or null. */
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null;
  /** Create a CSRF token (32-byte random hex + HMAC signature). */
  csrfToken(secret: Uint8Array): Uint8Array;
  /** Constant-time verify a CSRF token. */
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
  /** Resolve a URL reference against a base (RFC 3986). */
  urlResolve(base: Uint8Array, reference: Uint8Array): Uint8Array;
  /** Build a percent-encoded query string from params (sorted keys). */
  urlEncodeQuery(params: Record<string, string>): Uint8Array;

  // ── Factories / runtime ──
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance;
  createHmacSigner(key: Uint8Array): HmacSignerInstance;
  createTemplateRenderer(source: string): TemplateRendererInstance;
  /** Higher-order form parser: owns a reusable output buffer (setup once). */
  createFormParser(capacity?: number): FormParserInstance;
  /** Higher-order media-type parser: reusable wildcard matcher. */
  createMediaTypeParser(): MediaTypeParserInstance;
  /** Higher-order conditional-request check: per-resource 304 decision (setup once). */
  createConditionalRequest(
    etagValue: Uint8Array,
    lastModifiedSecs?: number,
  ): ConditionalRequestInstance;
  /** Higher-order negotiator: precompiles supported encodings once. */
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
  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  // ── Backend-framework scalar features ──
  jwtSign(
    claims: Record<string, unknown>,
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array;
  jwtVerify(
    token: Uint8Array,
    secret: Uint8Array,
    nowSeconds?: number,
  ): unknown;
  passwordHash(
    password: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array;
  passwordVerify(password: Uint8Array, phc: Uint8Array): boolean;
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
  gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
  gzipDecompress(data: Uint8Array): Uint8Array;
  brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
  brotliDecompress(data: Uint8Array): Uint8Array;
  multipartParse(body: Uint8Array, boundary: Uint8Array): MultipartPart[];
  wsFrameEncode(
    opcode: number,
    payload: Uint8Array,
    mask: boolean,
    fin: boolean,
  ): Uint8Array;
  wsFrameDecode(data: Uint8Array): WsFrame | null;
  sseEncodeEvent(
    event: string | null,
    data: Uint8Array,
    id: string | null,
    retry: number | null,
  ): Uint8Array;
}

/** Build the scalar/feature method set for a client context. */
export function buildScalar(ctx: RustClientContext): RustScalar {
  const { addon } = ctx;

  return {
    // ── Scalar ──
    crc32(bytes) {
      return asNumber(addon.crc32(bytes) as unknown) >>> 0;
    },
    fnv1a64(bytes) {
      return asBigInt(addon.fnv1a64(bytes) as unknown);
    },
    hmacSha256(key, data) {
      return ctx.hmacSigner(key).sign(data);
    },
    hmacSha256Verify(key, data, sig) {
      return ctx.hmacSigner(key).verify(data, sig);
    },
    jsonValid(bytes) {
      return addon.jsonValid(bytes);
    },
    jsonParse(bytes) {
      return addon.jsonParse(bytes);
    },
    jsonSumIds(bytes) {
      return asBigInt(addon.jsonSumIds(bytes) as unknown);
    },
    jsonPatch(doc, patch) {
      return addon.jsonPatch(doc, patch);
    },
    mimeFromExtension(ext) {
      return ctx.cachedMime(ext);
    },
    randomToken(byteLen) {
      return addon.randomToken(byteLen);
    },
    urlEncode(bytes) {
      return addon.urlEncode(bytes);
    },
    urlDecode(bytes) {
      return addon.urlDecode(bytes);
    },
    urlDecodeBytes(bytes) {
      return addon.urlDecodeBytes(bytes);
    },
    validateEmail(bytes) {
      return addon.validateEmail(bytes);
    },
    validateUuid(bytes) {
      return addon.validateUuid(bytes);
    },
    validateIpv4(bytes) {
      return addon.validateIpv4(bytes);
    },
    validateIpv6(bytes) {
      return addon.validateIpv6(bytes);
    },
    wsAcceptKey(key) {
      return addon.wsAcceptKey(key);
    },

    // ── Low-level / packed scalar ──
    httpParseRequestPacked(bytes) {
      return addon.httpParseRequestPacked(bytes);
    },
    queryParsePacked(bytes) {
      return addon.queryParsePacked(bytes);
    },
    cookieParsePacked(bytes) {
      return addon.cookieParsePacked(bytes);
    },
    formParsePacked(bytes) {
      return addon.formParsePacked(bytes);
    },
    parseMediaType(bytes) {
      const r = addon.parseMediaType(bytes);
      // napi serializes Option fields as undefined; normalize to null to match
      // the declared `string | null` public type.
      return {
        mediaType: r.mediaType,
        charset: r.charset ?? null,
        boundary: r.boundary ?? null,
        params: r.params,
      };
    },
    etag(data, weak) {
      return addon.etag(data, weak ?? undefined);
    },
    httpDate(secs) {
      return addon.httpDate(secs ?? undefined);
    },
    parseHttpDate(input) {
      return addon.parseHttpDate(input);
    },
    parseAcceptEncoding(input) {
      return addon.parseAcceptEncoding(input);
    },
    base64Encode(input, urlSafe, padding) {
      return addon.base64Encode(input, urlSafe ?? undefined, padding ?? undefined);
    },
    base64Decode(input, urlSafe, padding) {
      return addon.base64Decode(input, urlSafe ?? undefined, padding ?? undefined);
    },
    base64UrlEncode(input) {
      return addon.base64UrlEncode(input);
    },
    base64UrlDecode(input) {
      return addon.base64UrlDecode(input);
    },
    hexEncode(input) {
      return addon.hexEncode(input);
    },
    hexDecode(input) {
      return addon.hexDecode(input);
    },
    signCookie(value, secret) {
      return addon.signCookie(value, secret);
    },
    verifyCookie(signed, secret) {
      return addon.verifyCookie(signed, secret);
    },
    csrfToken(secret) {
      return addon.csrfToken(secret);
    },
    csrfVerify(token, secret) {
      return addon.csrfVerify(token, secret);
    },
    urlResolve(base, reference) {
      return addon.urlResolve(base, reference);
    },
    urlEncodeQuery(params) {
      return addon.urlEncodeQuery(params);
    },

    // ── Factories / runtime ──
    createSchemaValidator(schema) {
      return new addon.SchemaValidator(schema);
    },
    createHmacSigner(key) {
      return new addon.HmacSigner(key);
    },
    createTemplateRenderer(source) {
      return new addon.TemplateRenderer(source);
    },
    createFormParser(capacity) {
      return new addon.FormParser(capacity);
    },
    createMediaTypeParser() {
      return new addon.MediaTypeParser();
    },
    createConditionalRequest(etagValue, lastModifiedSecs) {
      return new addon.ConditionalRequest(etagValue, lastModifiedSecs ?? undefined);
    },
    createAcceptNegotiator(supported) {
      return new addon.AcceptNegotiator(supported);
    },
    createBase64Codec(urlSafe, padding) {
      return new addon.Base64Codec(urlSafe ?? undefined, padding ?? undefined);
    },
    createCookieSigner(secret) {
      return new addon.CookieSigner(secret);
    },
    createCsrfProtector(secret) {
      return new addon.CsrfProtector(secret);
    },
    createUrlBuilder(base) {
      return new addon.UrlBuilder(base);
    },
    createJwtSigner(secret, ttlSeconds) {
      return new addon.JwtSigner(secret, ttlSeconds ?? undefined);
    },
    createAeadCipher(key, algorithm) {
      return new addon.AeadCipher(key, algorithm ?? undefined);
    },
    createArgon2Hasher(options) {
      return new addon.Argon2Hasher(options ?? undefined);
    },
    createMediaTypeMatcher(expected) {
      return new addon.MediaTypeMatcher(expected);
    },
    initThreadPool(threads) {
      // Explicit user call also establishes the pool state locally.
      ctx.markPoolInitialized();
      if (threads !== undefined) ctx.setPendingThreads(threads);
      return addon.initThreadPool(threads);
    },
    rayonNumThreads() {
      return asNumber(addon.rayonNumThreads() as unknown);
    },

    // ── Backend-framework scalar features ──
    jwtSign(claims, secret, ttlSeconds, nowSeconds) {
      return addon.jwtSign(
        claims,
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      );
    },
    jwtVerify(token, secret, nowSeconds) {
      return addon.jwtVerify(
        token,
        secret,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      );
    },
    passwordHash(password, salt, options) {
      return addon.passwordHash(password, salt, options ?? null);
    },
    passwordVerify(password, phc) {
      return addon.passwordVerify(password, phc);
    },
    aeadEncrypt(key, nonce, plaintext, algorithm) {
      return addon.aeadEncrypt(key, nonce, plaintext, algorithm ?? null);
    },
    aeadDecrypt(key, nonce, ciphertext, algorithm) {
      return addon.aeadDecrypt(key, nonce, ciphertext, algorithm ?? null);
    },
    gzipCompress(data, level) {
      return addon.gzipCompress(data, level ?? null);
    },
    gzipDecompress(data) {
      return addon.gzipDecompress(data);
    },
    brotliCompress(data, quality) {
      return addon.brotliCompress(data, quality ?? null);
    },
    brotliDecompress(data) {
      return addon.brotliDecompress(data);
    },
    multipartParse(body, boundary) {
      // Normalize napi `Option<String>` (undefined) → null and expose the
      // camelCase `contentType` key (napi renames `content_type` to camelCase).
      return addon.multipartParse(body, boundary).map((p) => ({
        name: p.name,
        filename: p.filename ?? null,
        contentType: p.contentType ?? null,
        data: p.data,
      }));
    },
    wsFrameEncode(opcode, payload, mask, fin) {
      return addon.wsFrameEncode(opcode, payload, mask, fin);
    },
    wsFrameDecode(data) {
      return addon.wsFrameDecode(data);
    },
    sseEncodeEvent(event, data, id, retry) {
      return addon.sseEncodeEvent(
        event ?? null,
        data,
        id ?? null,
        retry ?? null,
      );
    },
  };
}
