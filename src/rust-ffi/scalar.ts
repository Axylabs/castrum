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

  // ── Factories / runtime ──
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance;
  createHmacSigner(key: Uint8Array): HmacSignerInstance;
  createTemplateRenderer(source: string): TemplateRendererInstance;
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
