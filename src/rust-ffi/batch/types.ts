// src/rust-ffi/batch/types.ts — Array-of-bytes batch namespace type.
//
// The `RustBatch` interface — the friendly JS shape of `rust.batch.*`
// (bitsets, u32 arrays, i64 arrays, byte results) — separated from the
// implementation (./build.ts) so type-only consumers don't pull the native
// resolver.

import type { MultipartPart, PasswordHashOptions } from '../../native'
import type { SchemaValidator } from '../../shared/packed'

/** Array-of-bytes FFI namespace. */
export interface RustBatch {
  jsonValid(items: Uint8Array[]): Uint8Array
  crc32(items: Uint8Array[]): Uint32Array
  validateEmail(items: Uint8Array[]): Uint8Array
  validateUuid(items: Uint8Array[]): Uint8Array
  validateIpv4(items: Uint8Array[]): Uint8Array
  validateIpv6(items: Uint8Array[]): Uint8Array
  jsonSumIds(items: Uint8Array[]): BigInt64Array
  queryParse(items: Uint8Array[]): Uint8Array[]
  cookieParse(items: Uint8Array[]): Uint8Array[]
  httpParseRequest(items: Uint8Array[]): Uint8Array[]
  /** Apply N RFC 6902 patches (docs and patches zipped). Fail-fast on error. */
  jsonPatch(docs: Uint8Array[], patches: Uint8Array[]): Uint8Array[]
  /** Encode N items to lowercase hex (packed in → byte results). */
  hexEncode(items: Uint8Array[]): Uint8Array[]
  /** Decode N lowercase/uppercase hex strings to bytes. */
  hexDecode(items: Uint8Array[]): Uint8Array[]
  /** Base64-encode N items (standard by default; url-safe/padding configurable). */
  base64Encode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[]
  /** Base64-decode N items (standard by default; url-safe/padding configurable). */
  base64Decode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[]
  formParse(items: Uint8Array[]): Uint8Array[]
  /** Sign N cookie values (packed → byte results). */
  signCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array[]
  /** Verify N signed cookies (bitset of valid). */
  verifyCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array
  /** Verify N CSRF tokens (bitset of valid). */
  csrfVerify(items: Uint8Array[], secret: Uint8Array): Uint8Array
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number
  /** Hash N items with FNV-1a 64 (packed → unsigned u64 array). */
  fnv1a64(items: Uint8Array[]): BigUint64Array
  /** Generate N ETags (strong by default; weak flag applies to all items). */
  etag(items: Uint8Array[], weak?: boolean | null): Uint8Array[]
  urlEncode(items: Uint8Array[]): Uint8Array[]
  /** Percent-decode N strings (UTF-8 validated; malformed items → empty). */
  urlDecode(items: Uint8Array[]): Uint8Array[]
  /** Strict percent-decode N strings (no UTF-8 validation). */
  urlDecodeBytes(items: Uint8Array[]): Uint8Array[]
  mimeFromExtension(items: Uint8Array[]): Uint8Array[]
  wsAcceptKey(items: Uint8Array[]): Uint8Array[]
  /** Base64url-encode N items (URL-safe, no padding). */
  base64UrlEncode(items: Uint8Array[]): Uint8Array[]
  /** Base64url-decode N items (URL-safe, no padding). */
  base64UrlDecode(items: Uint8Array[]): Uint8Array[]

  // ── Backend-framework features ──
  passwordHash(
    passwords: Uint8Array[],
    salt: Uint8Array,
    options?: PasswordHashOptions | null,
  ): Uint8Array[]
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    items: Uint8Array[],
    algorithm?: string | null,
  ): Uint8Array[]
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    items: Uint8Array[],
    algorithm?: string | null,
  ): Uint8Array[]
  gzipCompress(items: Uint8Array[], level?: number | null): Uint8Array[]
  gzipDecompress(items: Uint8Array[], maxDecompressed?: number | null): Uint8Array[]
  brotliCompress(items: Uint8Array[], quality?: number | null): Uint8Array[]
  brotliDecompress(items: Uint8Array[], maxDecompressed?: number | null): Uint8Array[]
  jwtVerify(tokens: Uint8Array[], secret: Uint8Array, nowSeconds: number): Uint8Array
  /** Sign N messages to lowercase-hex HMAC-SHA256 signatures (packed → byte results). */
  hmacSha256(items: Uint8Array[], key: Uint8Array): Uint8Array[]
  /** Verify N message + hex-signature pairs (two packed lists, zipped) → bitset of valid. */
  hmacSha256Verify(items: Uint8Array[], sigs: Uint8Array[], key: Uint8Array): Uint8Array
  /** Verify N password+PHC pairs (two packed lists, zipped) → bitset of valid. */
  passwordVerify(items: Uint8Array[], phcs: Uint8Array[]): Uint8Array
  /** Resolve N references against N bases (two packed lists, zipped). */
  urlResolve(bases: Uint8Array[], references: Uint8Array[]): Uint8Array[]
  /** Sign N JSON claim documents (packed → signed tokens). */
  jwtSign(
    items: Uint8Array[],
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array[]
  /** Encode N SSE events with shared event/id/retry. */
  sseEncode(
    items: Uint8Array[],
    event?: string | null,
    id?: string | null,
    retry?: number | null,
  ): Uint8Array[]
  /** Encode N frames (same opcode/mask/fin) from payloads. */
  wsFrameEncode(items: Uint8Array[], opcode: number, mask: boolean, fin: boolean): Uint8Array[]
  /** Decode N frames → payloads (opcodes/flags dropped; failed items → empty). */
  wsFrameDecode(items: Uint8Array[]): Uint8Array[]
  /** Parse N multipart bodies → array of parts per item (same boundary). */
  multipartParse(items: Uint8Array[], boundary: Uint8Array): MultipartPart[][]
  /**
   * @performance Template render: ~1.8x slower than the JS baseline (1/3 tasks failed) [check:annotate]
   * @deprecated Slower than the native JS baseline (~1.8x) — prefer the JS/Bun baseline. [check:annotate]
   * @remarks Promotion candidate: 2/3 benchmarks won in the latest run (static: not-competitive). [check:annotate]
   * @remarks The allocating render marshals the context via napi DOM (~1.5x loss). Use TemplateRenderer.renderBytes (JSON-bytes context) which avoids it and wins ~1.37x. [check:annotate]
   */
  templateRender(source: string, contexts: Uint8Array[]): Uint8Array[]
}
