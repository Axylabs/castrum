// src/rust-ffi/batch/build.ts — `buildBatch` implementation.
//
// Packs an array of byte slices into the packed wire format, calls the native
// batch function, and unpacks the result into the friendly JS shape. Each
// method wires one `RustBatch` (./types.ts) member to its `*BatchPacked` napi
// fn via the shared pool-native resolver (context.ts).
//
// The `via` / `via2` builders below collapse the pack → native → unpack
// plumbing every bulk op shares; each public method keeps its exact signature,
// so the table stays type-safe against `RustBatch`.

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

/**
 * Build a single-list bulk op: `withPackScratch(items)` →
 * `unpack(native(packed, ...extras))`. `R` is inferred from `unpack`, so the
 * result stays assignable to the matching `RustBatch` method.
 */
function via<R>(
  ctx: RustClientContext,
  name: string,
  unpack: (bytes: Uint8Array) => R,
  extras: unknown[] = [],
): (items: Uint8Array[]) => R {
  return (items) =>
    withPackScratch(items, (packed) => unpack(nativeFn(ctx, name)(packed, ...extras) as Buffer))
}

/**
 * Build a two-list bulk op (docs+patches, items+sigs, ...): `withPackScratch2(a, b)`
 * → `unpack(native(packedA, packedB, ...extras))`.
 */
function via2<R>(
  ctx: RustClientContext,
  name: string,
  unpack: (bytes: Uint8Array) => R,
  extras: unknown[] = [],
): (a: Uint8Array[], b: Uint8Array[]) => R {
  return (a, b) =>
    withPackScratch2(a, b, (packedA, packedB) =>
      unpack(nativeFn(ctx, name)(packedA, packedB, ...extras) as Buffer),
    )
}

/** Build the `batch` namespace for a client context. */
export function buildBatch(ctx: RustClientContext): RustBatch {
  return {
    // ── Single-list, no extras ──
    jsonValid: via(ctx, 'jsonValidBatchPacked', unpackBitset),
    crc32: via(ctx, 'crc32BatchPacked', unpackU32Array),
    validateEmail: via(ctx, 'validateEmailBatchPacked', unpackBitset),
    validateUuid: via(ctx, 'validateUuidBatchPacked', unpackBitset),
    validateIpv4: via(ctx, 'validateIpv4BatchPacked', unpackBitset),
    validateIpv6: via(ctx, 'validateIpv6BatchPacked', unpackBitset),
    jsonSumIds: via(ctx, 'jsonSumBatchPacked', unpackI64ArrayAsBigInt),
    queryParse: via(ctx, 'queryParseBatchPacked', unpackByteResults),
    cookieParse: via(ctx, 'cookieParseBatchPacked', unpackByteResults),
    formParse: via(ctx, 'formParseBatchPacked', unpackByteResults),
    signCookie: (items, secret) =>
      via(ctx, 'signCookieBatchPacked', unpackByteResults, [secret])(items),
    verifyCookie: (items, secret) =>
      via(ctx, 'verifyCookieBatchPacked', unpackBitset, [secret])(items),
    csrfVerify: (items, secret) => via(ctx, 'csrfVerifyBatchPacked', unpackBitset, [secret])(items),
    httpParseRequest: via(ctx, 'httpParseRequestBatchPacked', unpackByteResults),
    fnv1a64: via(ctx, 'fnv1A64BatchPacked', unpackU64ArrayAsBigInt),
    etag: (items, weak) => via(ctx, 'etagBatchPacked', unpackByteResults, [weak ?? null])(items),
    urlEncode: via(ctx, 'urlEncodeBatchPacked', unpackByteResults),
    urlDecode: via(ctx, 'urlDecodeBatchPacked', unpackByteResults),
    urlDecodeBytes: via(ctx, 'urlDecodeBytesBatchPacked', unpackByteResults),
    mimeFromExtension: via(ctx, 'mimeFromExtensionBatchPacked', unpackByteResults),
    wsAcceptKey: via(ctx, 'wsAcceptKeyBatchPacked', unpackByteResults),
    base64UrlEncode: (items) =>
      via(ctx, 'base64EncodeBatchPacked', unpackByteResults, [true, false])(items),
    base64UrlDecode: (items) =>
      via(ctx, 'base64DecodeBatchPacked', unpackByteResults, [true, false])(items),
    jsonPatch: (docs, patches) =>
      via2(ctx, 'jsonPatchBatchPacked', unpackByteResults)(docs, patches),
    hexEncode: via(ctx, 'hexEncodeBatchPacked', unpackByteResults),
    hexDecode: via(ctx, 'hexDecodeBatchPacked', unpackByteResults),
    base64Encode: (items, urlSafe, padding) =>
      via(ctx, 'base64EncodeBatchPacked', unpackByteResults, [urlSafe ?? null, padding ?? null])(
        items,
      ),
    base64Decode: (items, urlSafe, padding) =>
      via(ctx, 'base64DecodeBatchPacked', unpackByteResults, [urlSafe ?? null, padding ?? null])(
        items,
      ),
    schemaValidate(validator, items) {
      return schemaValidateBatch(validator, items)
    },
    schemaValidateCount(validator, items) {
      return schemaValidateBatchCount(validator, items)
    },

    // ── Backend-framework features ──
    passwordHash: (passwords, salt, options) =>
      via(ctx, 'passwordHashBatchPacked', unpackByteResults, [salt, options ?? null])(passwords),
    aeadEncrypt: (key, nonce, items, algorithm) =>
      via(ctx, 'aeadEncryptBatchPacked', unpackByteResults, [key, nonce, algorithm ?? null])(items),
    aeadDecrypt: (key, nonce, items, algorithm) =>
      via(ctx, 'aeadDecryptBatchPacked', unpackByteResults, [key, nonce, algorithm ?? null])(items),
    gzipCompress: (items, level) =>
      via(ctx, 'gzipCompressBatchPacked', unpackByteResults, [level ?? null])(items),
    gzipDecompress: (items, maxDecompressed) =>
      via(ctx, 'gzipDecompressBatchPacked', unpackByteResults, [maxDecompressed ?? null])(items),
    brotliCompress: (items, quality) =>
      via(ctx, 'brotliCompressBatchPacked', unpackByteResults, [quality ?? null])(items),
    brotliDecompress: (items, maxDecompressed) =>
      via(ctx, 'brotliDecompressBatchPacked', unpackByteResults, [maxDecompressed ?? null])(items),
    jwtVerify: (tokens, secret, nowSeconds) =>
      via(ctx, 'jwtVerifyBatchPacked', unpackBitset, [secret, nowSeconds])(tokens),
    hmacSha256: (items, key) => via(ctx, 'hmacSha256BatchPacked', unpackByteResults, [key])(items),
    hmacSha256Verify: (items, sigs, key) =>
      via2(ctx, 'hmacSha256VerifyBatchPacked', unpackBitset, [key])(items, sigs),
    // ── Two-list ──
    passwordVerify: (items, phcs) =>
      via2(ctx, 'passwordVerifyBatchPacked', unpackBitset)(items, phcs),
    urlResolve: (bases, references) =>
      via2(ctx, 'urlResolveBatchPacked', unpackByteResults)(bases, references),
    templateRender: (source, contexts) =>
      via(ctx, 'templateRenderBatchPacked', unpackByteResults, [source])(contexts),
    jwtSign: (items, secret, ttlSeconds, nowSeconds) =>
      via(ctx, 'jwtSignBatchPacked', unpackByteResults, [
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      ])(items),
    sseEncode: (items, event, id, retry) =>
      via(ctx, 'sseEncodeBatchPacked', unpackByteResults, [
        event ?? null,
        id ?? null,
        retry ?? null,
      ])(items),
    wsFrameEncode: (items, opcode, mask, fin) =>
      via(ctx, 'wsFrameEncodeBatchPacked', unpackByteResults, [opcode, mask, fin])(items),
    wsFrameDecode: via(ctx, 'wsFrameDecodeBatchPacked', unpackByteResults),
    multipartParse: (items, boundary) =>
      via(ctx, 'multipartParseBatchPacked', unpackMultipartParts, [boundary])(items),
  }
}
