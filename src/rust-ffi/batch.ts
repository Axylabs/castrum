// src/rust-ffi/batch.ts — Array-of-bytes FFI namespace.
//
// `rust.batch.*` packs an array of byte slices into the packed wire format,
// calls the native batch function, and unpacks the result into the friendly
// JS shape (bitsets, u32 arrays, i64 arrays, byte results).

import {
  schemaValidateBatch,
  schemaValidateBatchCount,
  unpackBitset,
  unpackByteResults,
  unpackI64ArrayAsBigInt,
  unpackMultipartParts,
  unpackU32Array,
  unpackU64ArrayAsBigInt,
  withPackScratch,
  withPackScratch2,
  type SchemaValidator,
} from "../shared/packed";
import type { RustClientContext } from "./context";
import type { MultipartPart, PasswordHashOptions } from "../native";

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
  /** Apply N RFC 6902 patches (docs and patches zipped). Fail-fast on error. */
  jsonPatch(docs: Uint8Array[], patches: Uint8Array[]): Uint8Array[];
  /** Encode N items to lowercase hex (packed in → byte results). */
  hexEncode(items: Uint8Array[]): Uint8Array[];
  /** Decode N lowercase/uppercase hex strings to bytes. */
  hexDecode(items: Uint8Array[]): Uint8Array[];
  /** Base64-encode N items (standard by default; url-safe/padding configurable). */
  base64Encode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[];
  /** Base64-decode N items (standard by default; url-safe/padding configurable). */
  base64Decode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[];
  formParse(items: Uint8Array[]): Uint8Array[];
  /** Sign N cookie values (packed → byte results). */
  signCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array[];
  /** Verify N signed cookies (bitset of valid). */
  verifyCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array;
  /** Verify N CSRF tokens (bitset of valid). */
  csrfVerify(items: Uint8Array[], secret: Uint8Array): Uint8Array;
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array;
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number;
  /** Hash N items with FNV-1a 64 (packed → unsigned u64 array). */
  fnv1a64(items: Uint8Array[]): BigUint64Array;
  /** Generate N ETags (strong by default; weak flag applies to all items). */
  etag(items: Uint8Array[], weak?: boolean | null): Uint8Array[];
  urlEncode(items: Uint8Array[]): Uint8Array[];
  /** Percent-decode N strings (UTF-8 validated; malformed items → empty). */
  urlDecode(items: Uint8Array[]): Uint8Array[];
  /** Strict percent-decode N strings (no UTF-8 validation). */
  urlDecodeBytes(items: Uint8Array[]): Uint8Array[];
  mimeFromExtension(items: Uint8Array[]): Uint8Array[];
  wsAcceptKey(items: Uint8Array[]): Uint8Array[];
  /** Base64url-encode N items (URL-safe, no padding). */
  base64UrlEncode(items: Uint8Array[]): Uint8Array[];
  /** Base64url-decode N items (URL-safe, no padding). */
  base64UrlDecode(items: Uint8Array[]): Uint8Array[];

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
  /** Sign N messages to lowercase-hex HMAC-SHA256 signatures (packed → byte results). */
  hmacSha256(items: Uint8Array[], key: Uint8Array): Uint8Array[];
  /** Verify N message + hex-signature pairs (two packed lists, zipped) → bitset of valid. */
  hmacSha256Verify(
    items: Uint8Array[],
    sigs: Uint8Array[],
    key: Uint8Array,
  ): Uint8Array;
  /** Verify N password+PHC pairs (two packed lists, zipped) → bitset of valid. */
  passwordVerify(items: Uint8Array[], phcs: Uint8Array[]): Uint8Array;
  /** Resolve N references against N bases (two packed lists, zipped). */
  urlResolve(bases: Uint8Array[], references: Uint8Array[]): Uint8Array[];
  /** Sign N JSON claim documents (packed → signed tokens). */
  jwtSign(
    items: Uint8Array[],
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array[];
  /** Encode N SSE events with shared event/id/retry. */
  sseEncode(
    items: Uint8Array[],
    event?: string | null,
    id?: string | null,
    retry?: number | null,
  ): Uint8Array[];
  /** Encode N frames (same opcode/mask/fin) from payloads. */
  wsFrameEncode(
    items: Uint8Array[],
    opcode: number,
    mask: boolean,
    fin: boolean,
  ): Uint8Array[];
  /** Decode N frames → payloads (opcodes/flags dropped; failed items → empty). */
  wsFrameDecode(items: Uint8Array[]): Uint8Array[];
  /** Parse N multipart bodies → array of parts per item (same boundary). */
  multipartParse(items: Uint8Array[], boundary: Uint8Array): MultipartPart[][];
  /**
   * @performance Template render: ~2.4x slower than the JS baseline [check:annotate]
   * @deprecated Slower than the native JS baseline (~2.4x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks The hand-rolled JS mini-template wins for small templates. [check:annotate]
   */
  templateRender(source: string, contexts: Uint8Array[]): Uint8Array[];
}

// Native batch fns are process-wide singletons (one lazy addon). Resolve each
// once — triggering pool init + addon load on first use — and cache it so the
// hot path skips the lazy-addon Proxy get on every call. This also makes the
// `withPoolInit` Proxy unnecessary for the batch namespace (pool init happens
// here on first native use).
const nativeFns = new Map<string, unknown>();

function nativeFn(
  ctx: RustClientContext,
  name: string,
): (...args: unknown[]) => unknown {
  let f = nativeFns.get(name);
  if (f === undefined) {
    ctx.ensurePool();
    f = (ctx.addon as unknown as Record<string, unknown>)[name];
    nativeFns.set(name, f);
  }
  return f as (...args: unknown[]) => unknown;
}

/** Build the `batch` namespace for a client context. */
export function buildBatch(ctx: RustClientContext): RustBatch {
  return {
    jsonValid(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, "jsonValidBatchPacked")(packed) as Buffer),
      );
    },
    crc32(items) {
      return withPackScratch(items, (packed) =>
        unpackU32Array(nativeFn(ctx, "crc32BatchPacked")(packed) as Buffer),
      );
    },
    validateEmail(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "validateEmailBatchPacked")(packed) as Buffer,
        ),
      );
    },
    validateUuid(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "validateUuidBatchPacked")(packed) as Buffer,
        ),
      );
    },
    validateIpv4(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "validateIpv4BatchPacked")(packed) as Buffer,
        ),
      );
    },
    validateIpv6(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "validateIpv6BatchPacked")(packed) as Buffer,
        ),
      );
    },
    jsonSumIds(items) {
      return withPackScratch(items, (packed) =>
        unpackI64ArrayAsBigInt(
          nativeFn(ctx, "jsonSumBatchPacked")(packed) as Buffer,
        ),
      );
    },
    queryParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "queryParseBatchPacked")(packed) as Buffer,
        ),
      );
    },
    cookieParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "cookieParseBatchPacked")(packed) as Buffer,
        ),
      );
    },
    formParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "formParseBatchPacked")(packed) as Buffer,
        ),
      );
    },
    signCookie(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "signCookieBatchPacked")(packed, secret) as Buffer,
        ),
      );
    },
    verifyCookie(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "verifyCookieBatchPacked")(packed, secret) as Buffer,
        ),
      );
    },
    csrfVerify(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackBitset(
          nativeFn(ctx, "csrfVerifyBatchPacked")(packed, secret) as Buffer,
        ),
      );
    },
    httpParseRequest(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "httpParseRequestBatchPacked")(packed) as Buffer,
        ),
      );
    },
    fnv1a64(items) {
      return withPackScratch(items, (packed) =>
        unpackU64ArrayAsBigInt(
          nativeFn(ctx, "fnv1A64BatchPacked")(packed) as Buffer,
        ),
      );
    },
    etag(items, weak) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "etagBatchPacked")(packed, weak ?? null) as Buffer,
        ),
      );
    },
    urlEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "urlEncodeBatchPacked")(packed) as Buffer,
        ),
      );
    },
    urlDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "urlDecodeBatchPacked")(packed) as Buffer,
        ),
      );
    },
    urlDecodeBytes(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "urlDecodeBytesBatchPacked")(packed) as Buffer,
        ),
      );
    },
    mimeFromExtension(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "mimeFromExtensionBatchPacked")(packed) as Buffer,
        ),
      );
    },
    wsAcceptKey(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "wsAcceptKeyBatchPacked")(packed) as Buffer,
        ),
      );
    },
    base64UrlEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "base64EncodeBatchPacked")(packed, true, false) as Buffer,
        ),
      );
    },
    base64UrlDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "base64DecodeBatchPacked")(packed, true, false) as Buffer,
        ),
      );
    },
    jsonPatch(docs, patches) {
      return withPackScratch2(docs, patches, (packedDocs, packedPatches) =>
        unpackByteResults(
          nativeFn(ctx, "jsonPatchBatchPacked")(
            packedDocs,
            packedPatches,
          ) as Buffer,
        ),
      );
    },
    hexEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "hexEncodeBatchPacked")(packed) as Buffer,
        ),
      );
    },
    hexDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "hexDecodeBatchPacked")(packed) as Buffer,
        ),
      );
    },
    base64Encode(items, urlSafe, padding) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "base64EncodeBatchPacked")(
            packed,
            urlSafe ?? null,
            padding ?? null,
          ) as Buffer,
        ),
      );
    },
    base64Decode(items, urlSafe, padding) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "base64DecodeBatchPacked")(
            packed,
            urlSafe ?? null,
            padding ?? null,
          ) as Buffer,
        ),
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
      return withPackScratch(password, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "passwordHashBatchPacked")(
            packed,
            salt,
            options ?? null,
          ) as Buffer,
        ),
      );
    },
    aeadEncrypt(key, nonce, items, algorithm) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "aeadEncryptBatchPacked")(
            packed,
            key,
            nonce,
            algorithm ?? null,
          ) as Buffer,
        ),
      );
    },
    aeadDecrypt(key, nonce, items, algorithm) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "aeadDecryptBatchPacked")(
            packed,
            key,
            nonce,
            algorithm ?? null,
          ) as Buffer,
        ),
      );
    },
    gzipCompress(items, level) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "gzipCompressBatchPacked")(
            packed,
            level ?? null,
          ) as Buffer,
        ),
      );
    },
    gzipDecompress(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "gzipDecompressBatchPacked")(packed) as Buffer,
        ),
      );
    },
    brotliCompress(items, quality) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "brotliCompressBatchPacked")(
            packed,
            quality ?? null,
          ) as Buffer,
        ),
      );
    },
    brotliDecompress(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "brotliDecompressBatchPacked")(packed) as Buffer,
        ),
      );
    },
    jwtVerify(tokens, secret, nowSeconds) {
      return withPackScratch(tokens, (packed) =>
        unpackBitset(
          nativeFn(ctx, "jwtVerifyBatchPacked")(
            packed,
            secret,
            nowSeconds,
          ) as Buffer,
        ),
      );
    },
    hmacSha256(items, key) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "hmacSha256BatchPacked")(packed, key) as Buffer,
        ),
      );
    },
    hmacSha256Verify(items, sigs, key) {
      return withPackScratch2(items, sigs, (packedItems, packedSigs) =>
        unpackBitset(
          nativeFn(ctx, "hmacSha256VerifyBatchPacked")(
            packedItems,
            packedSigs,
            key,
          ) as Buffer,
        ),
      );
    },
    templateRender(source, contexts) {
      return withPackScratch(contexts, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "templateRenderBatchPacked")(packed, source) as Buffer,
        ),
      );
    },
    passwordVerify(items, phcs) {
      return withPackScratch2(items, phcs, (packedItems, packedPhcs) =>
        unpackBitset(
          nativeFn(ctx, "passwordVerifyBatchPacked")(
            packedItems,
            packedPhcs,
          ) as Buffer,
        ),
      );
    },
    urlResolve(bases, references) {
      return withPackScratch2(bases, references, (packedBases, packedRefs) =>
        unpackByteResults(
          nativeFn(ctx, "urlResolveBatchPacked")(
            packedBases,
            packedRefs,
          ) as Buffer,
        ),
      );
    },
    jwtSign(items, secret, ttlSeconds, nowSeconds) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "jwtSignBatchPacked")(
            packed,
            secret,
            ttlSeconds ?? null,
            nowSeconds ?? Math.floor(Date.now() / 1000),
          ) as Buffer,
        ),
      );
    },
    sseEncode(items, event, id, retry) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "sseEncodeBatchPacked")(
            packed,
            event ?? null,
            id ?? null,
            retry ?? null,
          ) as Buffer,
        ),
      );
    },
    wsFrameEncode(items, opcode, mask, fin) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "wsFrameEncodeBatchPacked")(
            packed,
            opcode,
            mask,
            fin,
          ) as Buffer,
        ),
      );
    },
    wsFrameDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, "wsFrameDecodeBatchPacked")(packed) as Buffer,
        ),
      );
    },
    multipartParse(items, boundary) {
      return withPackScratch(items, (packed) =>
        unpackMultipartParts(
          nativeFn(ctx, "multipartParseBatchPacked")(packed, boundary) as Buffer,
        ),
      );
    },
  };
}
