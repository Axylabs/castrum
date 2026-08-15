// src/rust-ffi/batch/build.ts — `buildBatch` implementation.
//
// Packs an array of byte slices into the packed wire format, calls the native
// batch function, and unpacks the result into the friendly JS shape. Each
// method wires one `RustBatch` (./types.ts) member to its `*BatchPacked` napi
// fn via the shared pool-native resolver (context.ts).

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
} from '../../shared/packed'
import { type RustClientContext, resolvePoolNative } from '../context'
import type { RustBatch } from './types'

// Native batch fns are process-wide singletons (one lazy addon). `resolvePoolNative`
// resolves each once (triggering pool init + addon load on first use) and caches
// it, so the hot path skips the lazy-addon Proxy get on every call — the same
// cache `resolveNative`/packed use (context.ts), with pool init for the
// rayon-backed batch surface.
function nativeFn(ctx: RustClientContext, name: string): (...args: unknown[]) => unknown {
  return resolvePoolNative(ctx, name)
}

/** Build the `batch` namespace for a client context. */
export function buildBatch(ctx: RustClientContext): RustBatch {
  return {
    jsonValid(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'jsonValidBatchPacked')(packed) as Buffer),
      )
    },
    crc32(items) {
      return withPackScratch(items, (packed) =>
        unpackU32Array(nativeFn(ctx, 'crc32BatchPacked')(packed) as Buffer),
      )
    },
    validateEmail(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'validateEmailBatchPacked')(packed) as Buffer),
      )
    },
    validateUuid(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'validateUuidBatchPacked')(packed) as Buffer),
      )
    },
    validateIpv4(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'validateIpv4BatchPacked')(packed) as Buffer),
      )
    },
    validateIpv6(items) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'validateIpv6BatchPacked')(packed) as Buffer),
      )
    },
    jsonSumIds(items) {
      return withPackScratch(items, (packed) =>
        unpackI64ArrayAsBigInt(nativeFn(ctx, 'jsonSumBatchPacked')(packed) as Buffer),
      )
    },
    queryParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'queryParseBatchPacked')(packed) as Buffer),
      )
    },
    cookieParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'cookieParseBatchPacked')(packed) as Buffer),
      )
    },
    formParse(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'formParseBatchPacked')(packed) as Buffer),
      )
    },
    signCookie(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'signCookieBatchPacked')(packed, secret) as Buffer),
      )
    },
    verifyCookie(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'verifyCookieBatchPacked')(packed, secret) as Buffer),
      )
    },
    csrfVerify(items, secret) {
      return withPackScratch(items, (packed) =>
        unpackBitset(nativeFn(ctx, 'csrfVerifyBatchPacked')(packed, secret) as Buffer),
      )
    },
    httpParseRequest(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'httpParseRequestBatchPacked')(packed) as Buffer),
      )
    },
    fnv1a64(items) {
      return withPackScratch(items, (packed) =>
        unpackU64ArrayAsBigInt(nativeFn(ctx, 'fnv1A64BatchPacked')(packed) as Buffer),
      )
    },
    etag(items, weak) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'etagBatchPacked')(packed, weak ?? null) as Buffer),
      )
    },
    urlEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'urlEncodeBatchPacked')(packed) as Buffer),
      )
    },
    urlDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'urlDecodeBatchPacked')(packed) as Buffer),
      )
    },
    urlDecodeBytes(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'urlDecodeBytesBatchPacked')(packed) as Buffer),
      )
    },
    mimeFromExtension(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'mimeFromExtensionBatchPacked')(packed) as Buffer),
      )
    },
    wsAcceptKey(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'wsAcceptKeyBatchPacked')(packed) as Buffer),
      )
    },
    base64UrlEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'base64EncodeBatchPacked')(packed, true, false) as Buffer),
      )
    },
    base64UrlDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'base64DecodeBatchPacked')(packed, true, false) as Buffer),
      )
    },
    jsonPatch(docs, patches) {
      return withPackScratch2(docs, patches, (packedDocs, packedPatches) =>
        unpackByteResults(
          nativeFn(ctx, 'jsonPatchBatchPacked')(packedDocs, packedPatches) as Buffer,
        ),
      )
    },
    hexEncode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'hexEncodeBatchPacked')(packed) as Buffer),
      )
    },
    hexDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'hexDecodeBatchPacked')(packed) as Buffer),
      )
    },
    base64Encode(items, urlSafe, padding) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'base64EncodeBatchPacked')(
            packed,
            urlSafe ?? null,
            padding ?? null,
          ) as Buffer,
        ),
      )
    },
    base64Decode(items, urlSafe, padding) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'base64DecodeBatchPacked')(
            packed,
            urlSafe ?? null,
            padding ?? null,
          ) as Buffer,
        ),
      )
    },
    schemaValidate(validator, items) {
      return schemaValidateBatch(validator, items)
    },
    schemaValidateCount(validator, items) {
      return schemaValidateBatchCount(validator, items)
    },

    // ── Backend-framework features ──
    passwordHash(password, salt, options) {
      return withPackScratch(password, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'passwordHashBatchPacked')(packed, salt, options ?? null) as Buffer,
        ),
      )
    },
    aeadEncrypt(key, nonce, items, algorithm) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'aeadEncryptBatchPacked')(packed, key, nonce, algorithm ?? null) as Buffer,
        ),
      )
    },
    aeadDecrypt(key, nonce, items, algorithm) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'aeadDecryptBatchPacked')(packed, key, nonce, algorithm ?? null) as Buffer,
        ),
      )
    },
    gzipCompress(items, level) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'gzipCompressBatchPacked')(packed, level ?? null) as Buffer,
        ),
      )
    },
    gzipDecompress(items, maxDecompressed) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'gzipDecompressBatchPacked')(packed, maxDecompressed ?? null) as Buffer,
        ),
      )
    },
    brotliCompress(items, quality) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'brotliCompressBatchPacked')(packed, quality ?? null) as Buffer,
        ),
      )
    },
    brotliDecompress(items, maxDecompressed) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'brotliDecompressBatchPacked')(packed, maxDecompressed ?? null) as Buffer,
        ),
      )
    },
    jwtVerify(tokens, secret, nowSeconds) {
      return withPackScratch(tokens, (packed) =>
        unpackBitset(nativeFn(ctx, 'jwtVerifyBatchPacked')(packed, secret, nowSeconds) as Buffer),
      )
    },
    hmacSha256(items, key) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'hmacSha256BatchPacked')(packed, key) as Buffer),
      )
    },
    hmacSha256Verify(items, sigs, key) {
      return withPackScratch2(items, sigs, (packedItems, packedSigs) =>
        unpackBitset(
          nativeFn(ctx, 'hmacSha256VerifyBatchPacked')(packedItems, packedSigs, key) as Buffer,
        ),
      )
    },
    templateRender(source, contexts) {
      return withPackScratch(contexts, (packed) =>
        unpackByteResults(nativeFn(ctx, 'templateRenderBatchPacked')(packed, source) as Buffer),
      )
    },
    passwordVerify(items, phcs) {
      return withPackScratch2(items, phcs, (packedItems, packedPhcs) =>
        unpackBitset(nativeFn(ctx, 'passwordVerifyBatchPacked')(packedItems, packedPhcs) as Buffer),
      )
    },
    urlResolve(bases, references) {
      return withPackScratch2(bases, references, (packedBases, packedRefs) =>
        unpackByteResults(
          nativeFn(ctx, 'urlResolveBatchPacked')(packedBases, packedRefs) as Buffer,
        ),
      )
    },
    jwtSign(items, secret, ttlSeconds, nowSeconds) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'jwtSignBatchPacked')(
            packed,
            secret,
            ttlSeconds ?? null,
            nowSeconds ?? Math.floor(Date.now() / 1000),
          ) as Buffer,
        ),
      )
    },
    sseEncode(items, event, id, retry) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'sseEncodeBatchPacked')(
            packed,
            event ?? null,
            id ?? null,
            retry ?? null,
          ) as Buffer,
        ),
      )
    },
    wsFrameEncode(items, opcode, mask, fin) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(
          nativeFn(ctx, 'wsFrameEncodeBatchPacked')(packed, opcode, mask, fin) as Buffer,
        ),
      )
    },
    wsFrameDecode(items) {
      return withPackScratch(items, (packed) =>
        unpackByteResults(nativeFn(ctx, 'wsFrameDecodeBatchPacked')(packed) as Buffer),
      )
    },
    multipartParse(items, boundary) {
      return withPackScratch(items, (packed) =>
        unpackMultipartParts(
          nativeFn(ctx, 'multipartParseBatchPacked')(packed, boundary) as Buffer,
        ),
      )
    },
  }
}
