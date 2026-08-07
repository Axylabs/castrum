// src/rust-ffi/batch.ts — Array-of-bytes FFI namespace.
//
// `rust.batch.*` packs an array of byte slices into the packed wire format,
// calls the native batch function, and unpacks the result into the friendly
// JS shape (bitsets, u32 arrays, i64 arrays, byte results).

import {
  packBatch,
  schemaValidateBatch,
  schemaValidateBatchCount,
  unpackBitset,
  unpackByteResults,
  unpackI64ArrayAsBigInt,
  unpackU32Array,
  type SchemaValidator,
} from "../shared/packed";
import type { RustClientContext } from "./context";
import type { PasswordHashOptions } from "../native";

/** Array-of-bytes FFI namespace. */
export interface RustBatch {
  jsonValid(items: Uint8Array[]): Uint8Array;
  crc32(items: Uint8Array[]): Uint32Array;
  validateEmail(items: Uint8Array[]): Uint8Array;
  validateUuid(items: Uint8Array[]): Uint8Array;
  validateIpv4(items: Uint8Array[]): Uint8Array;
  validateIpv6(items: Uint8Array[]): Uint8Array;
  jsonSumIds(items: Uint8Array[]): BigInt64Array;
  queryParse(items: Uint8Array[]): Uint8Array[];
  cookieParse(items: Uint8Array[]): Uint8Array[];
  httpParseRequest(items: Uint8Array[]): Uint8Array[];
  formParse(items: Uint8Array[]): Uint8Array[];
  /** Sign N cookie values (packed → byte results). */
  signCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array[];
  /** Verify N signed cookies (bitset of valid). */
  verifyCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array;
  /** Verify N CSRF tokens (bitset of valid). */
  csrfVerify(items: Uint8Array[], secret: Uint8Array): Uint8Array;
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array;
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number;

  // ── Backend-framework features ──
  passwordHash(
    passwords: Uint8Array[],
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array[];
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    items: Uint8Array[],
    algorithm?: string | null,
  ): Uint8Array[];
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    items: Uint8Array[],
    algorithm?: string | null,
  ): Uint8Array[];
  gzipCompress(items: Uint8Array[], level?: number | null): Uint8Array[];
  gzipDecompress(items: Uint8Array[]): Uint8Array[];
  brotliCompress(items: Uint8Array[], quality?: number | null): Uint8Array[];
  brotliDecompress(items: Uint8Array[]): Uint8Array[];
  jwtVerify(
    tokens: Uint8Array[],
    secret: Uint8Array,
    nowSeconds: number,
  ): Uint8Array;
  templateRender(source: string, contexts: Uint8Array[]): Uint8Array[];
}

/** Build the `batch` namespace for a client context. */
export function buildBatch(ctx: RustClientContext): RustBatch {
  const { addon, withPoolInit } = ctx;

  return withPoolInit<RustBatch>({
    jsonValid(items) {
      return unpackBitset(addon.jsonValidBatchPacked(packBatch(items)));
    },
    crc32(items) {
      return unpackU32Array(addon.crc32BatchPacked(packBatch(items)));
    },
    validateEmail(items) {
      return unpackBitset(addon.validateEmailBatchPacked(packBatch(items)));
    },
    validateUuid(items) {
      return unpackBitset(addon.validateUuidBatchPacked(packBatch(items)));
    },
    validateIpv4(items) {
      return unpackBitset(addon.validateIpv4BatchPacked(packBatch(items)));
    },
    validateIpv6(items) {
      return unpackBitset(addon.validateIpv6BatchPacked(packBatch(items)));
    },
    jsonSumIds(items) {
      return unpackI64ArrayAsBigInt(addon.jsonSumBatchPacked(packBatch(items)));
    },
    queryParse(items) {
      return unpackByteResults(addon.queryParseBatchPacked(packBatch(items)));
    },
    cookieParse(items) {
      return unpackByteResults(addon.cookieParseBatchPacked(packBatch(items)));
    },
    formParse(items) {
      return unpackByteResults(addon.formParseBatchPacked(packBatch(items)));
    },
    signCookie(items, secret) {
      return unpackByteResults(
        addon.signCookieBatchPacked(packBatch(items), secret),
      );
    },
    verifyCookie(items, secret) {
      return unpackBitset(
        addon.verifyCookieBatchPacked(packBatch(items), secret),
      );
    },
    csrfVerify(items, secret) {
      return unpackBitset(
        addon.csrfVerifyBatchPacked(packBatch(items), secret),
      );
    },
    httpParseRequest(items) {
      return unpackByteResults(
        addon.httpParseRequestBatchPacked(packBatch(items)),
      );
    },
    schemaValidate(validator, items) {
      return schemaValidateBatch(validator, items);
    },
    schemaValidateCount(validator, items) {
      return schemaValidateBatchCount(validator, items);
    },

    // ── Backend-framework features ──
    passwordHash(password, salt, options) {
      return unpackByteResults(
        addon.passwordHashBatchPacked(packBatch(password), salt, options ?? null),
      );
    },
    aeadEncrypt(key, nonce, items, algorithm) {
      return unpackByteResults(
        addon.aeadEncryptBatchPacked(
          packBatch(items),
          key,
          nonce,
          algorithm ?? null,
        ),
      );
    },
    aeadDecrypt(key, nonce, items, algorithm) {
      return unpackByteResults(
        addon.aeadDecryptBatchPacked(
          packBatch(items),
          key,
          nonce,
          algorithm ?? null,
        ),
      );
    },
    gzipCompress(items, level) {
      return unpackByteResults(
        addon.gzipCompressBatchPacked(packBatch(items), level ?? null),
      );
    },
    gzipDecompress(items) {
      return unpackByteResults(addon.gzipDecompressBatchPacked(packBatch(items)));
    },
    brotliCompress(items, quality) {
      return unpackByteResults(
        addon.brotliCompressBatchPacked(packBatch(items), quality ?? null),
      );
    },
    brotliDecompress(items) {
      return unpackByteResults(
        addon.brotliDecompressBatchPacked(packBatch(items)),
      );
    },
    jwtVerify(tokens, secret, nowSeconds) {
      return unpackBitset(
        addon.jwtVerifyBatchPacked(packBatch(tokens), secret, nowSeconds),
      );
    },
    templateRender(source, contexts) {
      return unpackByteResults(
        addon.templateRenderBatchPacked(packBatch(contexts), source),
      );
    },
  });
}
