// src/rust-ffi/packed.ts — Raw packed-wire FFI namespace.
//
// `rust.packed.*` is the zero-copy API: callers pass already-packed buffers and
// receive the raw packed output, plus the batch metadata/count helpers.

import type { PasswordHashOptions } from '../native'
import { type RustClientContext, resolvePoolNative } from './context'
import { asNumber } from './options'

/** Raw packed-wire FFI namespace. */
export interface RustPacked {
  // ── Sync batch (packed in → packed out) ──
  crc32BatchPacked(input: Uint8Array): Uint8Array
  jsonValidBatchPacked(input: Uint8Array): Uint8Array
  validateEmailBatchPacked(input: Uint8Array): Uint8Array
  validateUuidBatchPacked(input: Uint8Array): Uint8Array
  validateIpv4BatchPacked(input: Uint8Array): Uint8Array
  validateIpv6BatchPacked(input: Uint8Array): Uint8Array
  jsonSumBatchPacked(input: Uint8Array): Uint8Array
  queryParseBatchPacked(input: Uint8Array): Uint8Array
  cookieParseBatchPacked(input: Uint8Array): Uint8Array
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array
  /** Batch RFC 6902 JSON Patch (two packed lists, zipped) → packed results. */
  jsonPatchBatchPacked(docs: Uint8Array, patches: Uint8Array): Uint8Array
  /** Packed FNV-1a 64 batch (i64 per item). */
  fnv1A64BatchPacked(input: Uint8Array): Uint8Array
  /** Packed ETag batch (10 strong / 12 weak bytes per item). */
  etagBatchPacked(input: Uint8Array, weak?: boolean | null): Uint8Array
  urlEncodeBatchPacked(input: Uint8Array): Uint8Array
  urlDecodeBatchPacked(input: Uint8Array): Uint8Array
  urlDecodeBytesBatchPacked(input: Uint8Array): Uint8Array
  mimeFromExtensionBatchPacked(input: Uint8Array): Uint8Array
  wsAcceptKeyBatchPacked(input: Uint8Array): Uint8Array

  // ── Batch metadata / counts ──
  jsonValidBatchCountPacked(input: Uint8Array): number
  validateEmailBatchCountPacked(input: Uint8Array): number
  validateUuidBatchCountPacked(input: Uint8Array): number
  validateIpv4BatchCountPacked(input: Uint8Array): number
  validateIpv6BatchCountPacked(input: Uint8Array): number
  jsonSumBatchTotalPacked(input: Uint8Array): number
  queryParseBatchTotalLenPacked(input: Uint8Array): number
  cookieParseBatchTotalLenPacked(input: Uint8Array): number
  httpParseRequestBatchTotalLenPacked(input: Uint8Array): number

  // ── Backend-framework features ──
  passwordHashBatchPacked(
    input: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array
  /** Packed password-verify batch (two packed lists, zipped) → bitset. */
  passwordVerifyBatchPacked(passwords: Uint8Array, phcs: Uint8Array): Uint8Array
  /** Packed URL-resolve batch (two packed lists, zipped) → packed results. */
  urlResolveBatchPacked(bases: Uint8Array, references: Uint8Array): Uint8Array
  aeadEncryptBatchPacked(
    input: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  aeadDecryptBatchPacked(
    input: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  gzipCompressBatchPacked(input: Uint8Array, level?: number | null): Uint8Array
  gzipDecompressBatchPacked(input: Uint8Array): Uint8Array
  brotliCompressBatchPacked(input: Uint8Array, quality?: number | null): Uint8Array
  brotliDecompressBatchPacked(input: Uint8Array): Uint8Array
  jwtSignBatchPacked(
    input: Uint8Array,
    secret: Uint8Array,
    ttlSeconds: number | null,
    nowSeconds: number,
  ): Uint8Array
  jwtVerifyBatchPacked(input: Uint8Array, secret: Uint8Array, nowSeconds: number): Uint8Array
  /** Batch HMAC-SHA256 sign (packed in → hex-signature byte results). */
  hmacSha256BatchPacked(input: Uint8Array, key: Uint8Array): Uint8Array
  /** Batch HMAC-SHA256 verify (two packed lists: data + hex sigs, zipped) → bitset. */
  hmacSha256VerifyBatchPacked(input: Uint8Array, sigs: Uint8Array, key: Uint8Array): Uint8Array
  multipartParseBatchPacked(input: Uint8Array, boundary: Uint8Array): Uint8Array
  templateRenderBatchPacked(input: Uint8Array, source: string): Uint8Array
  sseEncodeBatchPacked(
    input: Uint8Array,
    event: string | null,
    id: string | null,
    retry: number | null,
  ): Uint8Array
  wsFrameEncodeBatchPacked(
    input: Uint8Array,
    opcode: number,
    mask: boolean,
    fin: boolean,
  ): Uint8Array
  wsFrameDecodeBatchPacked(input: Uint8Array): Uint8Array
}

/** Build the `packed` namespace for a client context. */
export function buildPacked(ctx: RustClientContext): RustPacked {
  // Packed ops are rayon-backed NAPI calls (no C ABI). Resolve each native fn
  // on first use — ensuring the process-wide pool initializes at that point so
  // `rust.configure({ rayonThreads })` still takes effect — and cache it via
  // `resolvePoolNative` (shared with `resolveNative`/batch, context.ts). This
  // removes BOTH the lazy-addon Proxy `get` and the old `withPoolInit`
  // per-access Proxy from the packed hot path. The object keeps the
  // `NativeAddon` type so the method bodies below typecheck unchanged.
  const addon = new Proxy(ctx.addon, {
    get: (_target, name) => resolvePoolNative(ctx, String(name)),
  }) as typeof ctx.addon

  return {
    crc32BatchPacked(input) {
      return addon.crc32BatchPacked(input)
    },
    jsonValidBatchPacked(input) {
      return addon.jsonValidBatchPacked(input)
    },
    validateEmailBatchPacked(input) {
      return addon.validateEmailBatchPacked(input)
    },
    validateUuidBatchPacked(input) {
      return addon.validateUuidBatchPacked(input)
    },
    validateIpv4BatchPacked(input) {
      return addon.validateIpv4BatchPacked(input)
    },
    validateIpv6BatchPacked(input) {
      return addon.validateIpv6BatchPacked(input)
    },
    jsonSumBatchPacked(input) {
      return addon.jsonSumBatchPacked(input)
    },
    queryParseBatchPacked(input) {
      return addon.queryParseBatchPacked(input)
    },
    cookieParseBatchPacked(input) {
      return addon.cookieParseBatchPacked(input)
    },
    httpParseRequestBatchPacked(input) {
      return addon.httpParseRequestBatchPacked(input)
    },
    jsonPatchBatchPacked(docs, patches) {
      return addon.jsonPatchBatchPacked(docs, patches)
    },
    fnv1A64BatchPacked(input) {
      return addon.fnv1A64BatchPacked(input)
    },
    etagBatchPacked(input, weak) {
      return addon.etagBatchPacked(input, weak ?? null)
    },
    urlEncodeBatchPacked(input) {
      return addon.urlEncodeBatchPacked(input)
    },
    urlDecodeBatchPacked(input) {
      return addon.urlDecodeBatchPacked(input)
    },
    urlDecodeBytesBatchPacked(input) {
      return addon.urlDecodeBytesBatchPacked(input)
    },
    mimeFromExtensionBatchPacked(input) {
      return addon.mimeFromExtensionBatchPacked(input)
    },
    wsAcceptKeyBatchPacked(input) {
      return addon.wsAcceptKeyBatchPacked(input)
    },

    jsonValidBatchCountPacked(input) {
      return asNumber(addon.jsonValidBatchCountPacked(input))
    },
    validateEmailBatchCountPacked(input) {
      return asNumber(addon.validateEmailBatchCountPacked(input))
    },
    validateUuidBatchCountPacked(input) {
      return asNumber(addon.validateUuidBatchCountPacked(input))
    },
    validateIpv4BatchCountPacked(input) {
      return asNumber(addon.validateIpv4BatchCountPacked(input))
    },
    validateIpv6BatchCountPacked(input) {
      return asNumber(addon.validateIpv6BatchCountPacked(input))
    },
    jsonSumBatchTotalPacked(input) {
      return asNumber(addon.jsonSumBatchTotalPacked(input))
    },
    queryParseBatchTotalLenPacked(input) {
      return asNumber(addon.queryParseBatchTotalLenPacked(input))
    },
    cookieParseBatchTotalLenPacked(input) {
      return asNumber(addon.cookieParseBatchTotalLenPacked(input))
    },
    httpParseRequestBatchTotalLenPacked(input) {
      return asNumber(addon.httpParseRequestBatchTotalLenPacked(input))
    },

    // ── Backend-framework features ──
    passwordHashBatchPacked(input, salt, options) {
      return addon.passwordHashBatchPacked(input, salt, options ?? null)
    },
    passwordVerifyBatchPacked(passwords, phcs) {
      return addon.passwordVerifyBatchPacked(passwords, phcs)
    },
    urlResolveBatchPacked(bases, references) {
      return addon.urlResolveBatchPacked(bases, references)
    },
    aeadEncryptBatchPacked(input, key, nonce, algorithm) {
      return addon.aeadEncryptBatchPacked(input, key, nonce, algorithm ?? null)
    },
    aeadDecryptBatchPacked(input, key, nonce, algorithm) {
      return addon.aeadDecryptBatchPacked(input, key, nonce, algorithm ?? null)
    },
    gzipCompressBatchPacked(input, level) {
      return addon.gzipCompressBatchPacked(input, level ?? null)
    },
    gzipDecompressBatchPacked(input) {
      return addon.gzipDecompressBatchPacked(input)
    },
    brotliCompressBatchPacked(input, quality) {
      return addon.brotliCompressBatchPacked(input, quality ?? null)
    },
    brotliDecompressBatchPacked(input) {
      return addon.brotliDecompressBatchPacked(input)
    },
    jwtSignBatchPacked(input, secret, ttlSeconds, nowSeconds) {
      return addon.jwtSignBatchPacked(input, secret, ttlSeconds ?? null, nowSeconds)
    },
    jwtVerifyBatchPacked(input, secret, nowSeconds) {
      return addon.jwtVerifyBatchPacked(input, secret, nowSeconds)
    },
    hmacSha256BatchPacked(input, key) {
      return addon.hmacSha256BatchPacked(input, key)
    },
    hmacSha256VerifyBatchPacked(input, sigs, key) {
      return addon.hmacSha256VerifyBatchPacked(input, sigs, key)
    },
    multipartParseBatchPacked(input, boundary) {
      return addon.multipartParseBatchPacked(input, boundary)
    },
    templateRenderBatchPacked(input, source) {
      return addon.templateRenderBatchPacked(input, source)
    },
    sseEncodeBatchPacked(input, event, id, retry) {
      return addon.sseEncodeBatchPacked(input, event ?? null, id ?? null, retry ?? null)
    },
    wsFrameEncodeBatchPacked(input, opcode, mask, fin) {
      return addon.wsFrameEncodeBatchPacked(input, opcode, mask, fin)
    },
    wsFrameDecodeBatchPacked(input) {
      return addon.wsFrameDecodeBatchPacked(input)
    },
  }
}
