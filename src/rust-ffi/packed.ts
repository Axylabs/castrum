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
  /** Packed CRC32 batch: packed `[u8[]]` items → packed u32 results. */
  crc32BatchPacked(input: Uint8Array): Uint8Array
  /** Packed JSON-validity batch: packed `[u8[]]` items → packed 0/1 bitset. */
  jsonValidBatchPacked(input: Uint8Array): Uint8Array
  /** Packed email-validator batch: packed `[u8[]]` items → packed 0/1 bitset. */
  validateEmailBatchPacked(input: Uint8Array): Uint8Array
  /** Packed UUID-validator batch: packed `[u8[]]` items → packed 0/1 bitset. */
  validateUuidBatchPacked(input: Uint8Array): Uint8Array
  /** Packed IPv4-validator batch: packed `[u8[]]` items → packed 0/1 bitset. */
  validateIpv4BatchPacked(input: Uint8Array): Uint8Array
  /** Packed IPv6-validator batch: packed `[u8[]]` items → packed 0/1 bitset. */
  validateIpv6BatchPacked(input: Uint8Array): Uint8Array
  /** Packed JSON-sum batch: packed `[{id}]` docs → packed `[ok u8][sum i64 LE]`. */
  jsonSumBatchPacked(input: Uint8Array): Uint8Array
  /** Packed query-string parser batch: packed `[u8[]]` queries → packed pair lists. */
  queryParseBatchPacked(input: Uint8Array): Uint8Array
  /** Packed cookie-header parser batch: packed `[u8[]]` headers → packed pair lists. */
  cookieParseBatchPacked(input: Uint8Array): Uint8Array
  /** Packed HTTP-request parser batch: packed `[u8[]]` requests → packed request sections. */
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array
  /** Batch RFC 6902 JSON Patch (two packed lists, zipped) → packed results. */
  jsonPatchBatchPacked(docs: Uint8Array, patches: Uint8Array): Uint8Array
  /** Packed FNV-1a 64 batch (i64 per item). */
  fnv1A64BatchPacked(input: Uint8Array): Uint8Array
  /** Packed ETag batch (10 strong / 12 weak bytes per item). */
  etagBatchPacked(input: Uint8Array, weak?: boolean | null): Uint8Array
  /** Packed percent-encoding batch: packed `[u8[]]` items → packed hex-percent bytes. */
  urlEncodeBatchPacked(input: Uint8Array): Uint8Array
  /** Packed percent-decoding batch: packed `[u8[]]` items → packed decoded bytes (string-safe). */
  urlDecodeBatchPacked(input: Uint8Array): Uint8Array
  /** Packed percent-decoding batch returning raw bytes (`%FF` preserved). */
  urlDecodeBytesBatchPacked(input: Uint8Array): Uint8Array
  /** Packed MIME-lookup batch: packed `[u8[]]` extensions → packed media-type strings. */
  mimeFromExtensionBatchPacked(input: Uint8Array): Uint8Array
  /** Packed WebSocket accept-key batch: packed `[u8[]]` keys → packed base64 SHA-1 results. */
  wsAcceptKeyBatchPacked(input: Uint8Array): Uint8Array

  // ── Batch metadata / counts ──
  /** Valid JSON count in a packed JSON batch (0..n; invalid items not counted). */
  jsonValidBatchCountPacked(input: Uint8Array): number
  /** Valid-email count in a packed email batch. */
  validateEmailBatchCountPacked(input: Uint8Array): number
  /** Valid-UUID count in a packed UUID batch. */
  validateUuidBatchCountPacked(input: Uint8Array): number
  /** Valid-IPv4 count in a packed IPv4 batch. */
  validateIpv4BatchCountPacked(input: Uint8Array): number
  /** Valid-IPv6 count in a packed IPv6 batch. */
  validateIpv6BatchCountPacked(input: Uint8Array): number
  /** Total `id` sum across a packed JSON batch (valid items only). */
  jsonSumBatchTotalPacked(input: Uint8Array): number
  /** Total packed-output length (bytes) a query batch will produce. */
  queryParseBatchTotalLenPacked(input: Uint8Array): number
  /** Total packed-output length (bytes) a cookie batch will produce. */
  cookieParseBatchTotalLenPacked(input: Uint8Array): number
  /** Total packed-output length (bytes) an HTTP-request batch will produce. */
  httpParseRequestBatchTotalLenPacked(input: Uint8Array): number

  // ── Backend-framework features ──
  /** Packed Argon2id-hash batch: packed `[u8[]]` passwords + shared salt → packed PHC strings. */
  passwordHashBatchPacked(
    input: Uint8Array,
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array
  /** Packed password-verify batch (two packed lists, zipped) → bitset. */
  passwordVerifyBatchPacked(passwords: Uint8Array, phcs: Uint8Array): Uint8Array
  /** Packed URL-resolve batch (two packed lists, zipped) → packed results. */
  urlResolveBatchPacked(bases: Uint8Array, references: Uint8Array): Uint8Array
  /** Packed AEAD-encrypt batch (packed inputs + shared key/nonce) → packed ciphertexts. */
  aeadEncryptBatchPacked(
    input: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  /** Packed AEAD-decrypt batch (packed inputs + shared key/nonce) → packed plaintexts. */
  aeadDecryptBatchPacked(
    input: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm?: string | null,
  ): Uint8Array
  /** Packed gzip-compress batch: packed `[u8[]]` items → packed gzip streams. */
  gzipCompressBatchPacked(input: Uint8Array, level?: number | null): Uint8Array
  /** Packed gzip-decompress batch (64 MiB cap per item) → packed plaintexts. */
  gzipDecompressBatchPacked(input: Uint8Array): Uint8Array
  /** Packed brotli-compress batch: packed `[u8[]]` items → packed brotli streams. */
  brotliCompressBatchPacked(input: Uint8Array, quality?: number | null): Uint8Array
  /** Packed brotli-decompress batch (64 MiB cap per item) → packed plaintexts. */
  brotliDecompressBatchPacked(input: Uint8Array): Uint8Array
  /** Packed HS256 JWT-sign batch (packed claims + shared secret) → packed tokens. */
  jwtSignBatchPacked(
    input: Uint8Array,
    secret: Uint8Array,
    ttlSeconds: number | null,
    nowSeconds: number,
  ): Uint8Array
  /** Packed HS256 JWT-verify batch (packed tokens + shared secret) → packed claims/validity. */
  jwtVerifyBatchPacked(input: Uint8Array, secret: Uint8Array, nowSeconds: number): Uint8Array
  /** Batch HMAC-SHA256 sign (packed in → hex-signature byte results). */
  hmacSha256BatchPacked(input: Uint8Array, key: Uint8Array): Uint8Array
  /** Batch HMAC-SHA256 verify (two packed lists: data + hex sigs, zipped) → bitset. */
  hmacSha256VerifyBatchPacked(input: Uint8Array, sigs: Uint8Array, key: Uint8Array): Uint8Array
  /** Packed multipart/form-data parser batch (packed bodies + shared boundary) → packed parts. */
  multipartParseBatchPacked(input: Uint8Array, boundary: Uint8Array): Uint8Array
  /** Packed minijinja template batch: packed contexts + shared source → packed renders. */
  templateRenderBatchPacked(input: Uint8Array, source: string): Uint8Array
  /** Packed SSE-frame batch: packed data + shared event/id/retry → packed frames. */
  sseEncodeBatchPacked(
    input: Uint8Array,
    event: string | null,
    id: string | null,
    retry: number | null,
  ): Uint8Array
  /** Packed WebSocket-frame encode batch: packed payloads + shared opcode/mask/fin → packed frames. */
  wsFrameEncodeBatchPacked(
    input: Uint8Array,
    opcode: number,
    mask: boolean,
    fin: boolean,
  ): Uint8Array
  /** Packed WebSocket-frame decode batch: packed frames → packed (fin, opcode, payload) results. */
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
