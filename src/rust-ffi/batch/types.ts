// src/rust-ffi/batch/types.ts — Array-of-bytes batch namespace type.
//
// The `RustBatch` interface — the friendly JS shape of `rust.batch.*`
// (bitsets, u32 arrays, i64 arrays, byte results) — separated from the
// implementation (./build.ts) so type-only consumers don't pull the native
// resolver.

import type { MultipartPart, PasswordHashOptions } from '../../native'
import type { SchemaValidator } from '../../shared/packed'

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
  jsonPatch(docs: Uint8Array[], patches: Uint8Array[]): Uint8Array[]
  hexEncode(items: Uint8Array[]): Uint8Array[]
  hexDecode(items: Uint8Array[]): Uint8Array[]
  base64Encode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[]
  base64Decode(items: Uint8Array[], urlSafe?: boolean, padding?: boolean): Uint8Array[]
  formParse(items: Uint8Array[]): Uint8Array[]
  signCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array[]
  verifyCookie(items: Uint8Array[], secret: Uint8Array): Uint8Array
  csrfVerify(items: Uint8Array[], secret: Uint8Array): Uint8Array
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number
  fnv1a64(items: Uint8Array[]): BigUint64Array
  etag(items: Uint8Array[], weak?: boolean | null): Uint8Array[]
  urlEncode(items: Uint8Array[]): Uint8Array[]
  urlDecode(items: Uint8Array[]): Uint8Array[]
  urlDecodeBytes(items: Uint8Array[]): Uint8Array[]
  mimeFromExtension(items: Uint8Array[]): Uint8Array[]
  wsAcceptKey(items: Uint8Array[]): Uint8Array[]
  base64UrlEncode(items: Uint8Array[]): Uint8Array[]
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
  hmacSha256(items: Uint8Array[], key: Uint8Array): Uint8Array[]
  hmacSha256Verify(items: Uint8Array[], sigs: Uint8Array[], key: Uint8Array): Uint8Array
  passwordVerify(items: Uint8Array[], phcs: Uint8Array[]): Uint8Array
  urlResolve(bases: Uint8Array[], references: Uint8Array[]): Uint8Array[]
  jwtSign(
    items: Uint8Array[],
    secret: Uint8Array,
    ttlSeconds?: number | null,
    nowSeconds?: number,
  ): Uint8Array[]
  sseEncode(
    items: Uint8Array[],
    event?: string | null,
    id?: string | null,
    retry?: number | null,
  ): Uint8Array[]
  wsFrameEncode(items: Uint8Array[], opcode: number, mask: boolean, fin: boolean): Uint8Array[]
  wsFrameDecode(items: Uint8Array[]): Uint8Array[]
  multipartParse(items: Uint8Array[], boundary: Uint8Array): MultipartPart[][]
  templateRender(source: string, contexts: Uint8Array[]): Uint8Array[]
}
