// src/loader/ops.ts — Curated loader-op registry.
//
// Each op pairs a scalar FFI call (single item) with the packed batch call
// (bulk items → ONE native crossing). Result kinds mirror `rust.batch.*`:
//
//   - "boolean" → single `boolean`, bulk bitset `Uint8Array` (0/1 per item)
//   - "number"  → single `number`, bulk `Uint32Array`
//   - "bigint"  → single `bigint`, bulk `BigInt64Array | BigUint64Array`
//   - "bytes"   → single `Uint8Array`, bulk `Uint8Array[]`
//
// Ops marked "paired" (see `LoaderOpSpec.pairedRest`) take a per-item
// companion in bulk form (e.g. `jsonPatch` = doc + patch). Ops whose scalar
// returns something richer than the batch bitset (`verifyCookie` returning the
// value, `jwtVerify` returning the decoded payload) are exposed as
// BOOLEAN-validity ops so single and bulk semantics stay identical — use
// `rust.<op>` directly for the decoded value.
//
// The bulk result shapes are intentionally IDENTICAL to `rust.batch.<op>` so
// the loader never pays a conversion cost on the hot path. This module is the
// single source of truth for what the loader can dispatch.

import { rust } from "../rust-ffi";
import { addon } from "../rust-ffi/addon";
import { decoder } from "../shared/bytes";
import type { PasswordHashOptions } from "../native";
import type { SchemaValidator } from "../shared/packed";

/** Empty bytes sentinel for skip-on-error scalar parity (e.g. AEAD decrypt). */
export const EMPTY_BYTES = new Uint8Array(0);

/** Result kinds supported by the loader (mirrors the packed batch wire shapes). */
export type LoaderResultKind = "boolean" | "number" | "bigint" | "bytes";

/** Single-item (scalar) result type for a kind. */
export type ScalarResult<K extends LoaderResultKind> = K extends "boolean"
  ? boolean
  : K extends "number"
    ? number
    : K extends "bigint"
      ? bigint
      : Uint8Array;

/** Bulk (array-input) result type for a kind — same shape as `rust.batch.*`. */
export type BulkResult<K extends LoaderResultKind> = K extends "boolean"
  ? Uint8Array
  : K extends "number"
    ? Uint32Array
    : K extends "bigint"
      ? BigInt64Array
      : Uint8Array[];

/**
 * Bulk-result type overrides per op. Bigint ops whose hashes can set the high
 * bit (e.g. `fnv1a64`) return an UNSIGNED `BigUint64Array` to match the scalar
 * `rust.<op>`; the default signed `BigInt64Array` stays for sum-style ops.
 */
export interface LoaderOpBulkOverride {
  fnv1a64: BigUint64Array;
}

/** Bulk result type of a specific op (per-op override wins). */
export type LoaderBulk<K extends LoaderOpName> = K extends keyof LoaderOpBulkOverride
  ? LoaderOpBulkOverride[K]
  : BulkResult<LoaderOpKind<K>>;

/** Every op the loader can dispatch. */
export type LoaderOpName =
  | "crc32"
  | "fnv1a64"
  | "jsonValid"
  | "jsonSumIds"
  | "validateEmail"
  | "validateUuid"
  | "validateIpv4"
  | "validateIpv6"
  | "queryParse"
  | "cookieParse"
  | "formParse"
  | "httpParseRequest"
  | "hexEncode"
  | "hexDecode"
  | "base64Encode"
  | "base64Decode"
  | "base64UrlEncode"
  | "base64UrlDecode"
  | "gzipCompress"
  | "gzipDecompress"
  | "brotliCompress"
  | "brotliDecompress"
  | "etag"
  | "urlEncode"
  | "urlDecode"
  | "urlDecodeBytes"
  | "wsAcceptKey"
  | "mimeFromExtension"
  | "signCookie"
  | "verifyCookie"
  | "csrfVerify"
  | "passwordHash"
  | "passwordVerify"
  | "hmacSha256"
  | "hmacSha256Verify"
  | "aeadEncrypt"
  | "aeadDecrypt"
  | "jwtSign"
  | "jwtVerify"
  | "jsonPatch"
  | "urlResolve"
  | "wsFrameEncode"
  | "sseEncode"
  | "schemaValidate";

/** Extra arguments (after the item/items) for each op — the SINGLE call shape. */
export interface LoaderOpArgs {
  crc32: [];
  fnv1a64: [];
  jsonValid: [];
  jsonSumIds: [];
  validateEmail: [];
  validateUuid: [];
  validateIpv4: [];
  validateIpv6: [];
  queryParse: [];
  cookieParse: [];
  formParse: [];
  httpParseRequest: [];
  hexEncode: [];
  hexDecode: [];
  base64Encode: [urlSafe?: boolean, padding?: boolean];
  base64Decode: [urlSafe?: boolean, padding?: boolean];
  base64UrlEncode: [];
  base64UrlDecode: [];
  gzipCompress: [level?: number | null];
  gzipDecompress: [];
  brotliCompress: [quality?: number | null];
  brotliDecompress: [];
  etag: [weak?: boolean | null];
  urlEncode: [];
  urlDecode: [];
  urlDecodeBytes: [];
  wsAcceptKey: [];
  mimeFromExtension: [];
  signCookie: [secret: Uint8Array];
  /** Boolean-validity op: returns valid/invalid (use `rust.verifyCookie` for the value). */
  verifyCookie: [secret: Uint8Array];
  csrfVerify: [secret: Uint8Array];
  passwordHash: [salt: Uint8Array, options?: PasswordHashOptions | null];
  passwordVerify: [phc: Uint8Array];
  hmacSha256: [key: Uint8Array];
  hmacSha256Verify: [key: Uint8Array, sig: Uint8Array];
  aeadEncrypt: [key: Uint8Array, nonce: Uint8Array, algorithm?: string | null];
  aeadDecrypt: [key: Uint8Array, nonce: Uint8Array, algorithm?: string | null];
  jwtSign: [secret: Uint8Array, ttlSeconds?: number | null, nowSeconds?: number];
  /** Boolean-validity op: returns valid/invalid (use `rust.jwtVerify` for the payload). */
  jwtVerify: [secret: Uint8Array, nowSeconds?: number];
  jsonPatch: [patch: Uint8Array];
  urlResolve: [base: Uint8Array];
  wsFrameEncode: [opcode: number, mask: boolean, fin: boolean];
  sseEncode: [event?: string | null, id?: string | null, retry?: number | null];
  schemaValidate: [validator: SchemaValidator];
}

/**
 * Extra arguments for the BULK call shape. Paired ops take a per-item
 * companion ARRAY here; every other op inherits the scalar `LoaderOpArgs`
 * shape (companions are shared across the batch).
 */
export interface LoaderOpBulkArgs {
  jsonPatch: [patches: Uint8Array[]];
  hmacSha256Verify: [key: Uint8Array, sigs: Uint8Array[]];
  passwordVerify: [phcs: Uint8Array[]];
  urlResolve: [bases: Uint8Array[]];
}

/** Bulk call shape for any op (defaults to the scalar shape). */
export type LoaderBulkArgs<K extends LoaderOpName> = K extends keyof LoaderOpBulkArgs
  ? LoaderOpBulkArgs[K]
  : LoaderOpArgs[K];

/**
 * Zero-alloc fast-bulk wiring used by the coalesced `load()` flush for
 * boolean/number/bigint ops. The loader packs the inputs into a reusable
 * scratch, calls `batch` (a native `_into` packed variant) to write the packed
 * result straight into a reusable output buffer, then reads each element out
 * of that buffer — no intermediate unpack array, no per-call native Vec.
 */
export interface LoaderFastSpec {
  /** Write the packed batch result for `packed` into `output`; returns bytes written. */
  batch(packed: Uint8Array, output: Uint8Array): number;
  /** Read the i-th scalar result out of the packed `output` written by `batch`. */
  element(
    view: DataView,
    output: Uint8Array,
    index: number,
  ): boolean | number | bigint;
  /** Exact number of bytes `output` needs for `count` items. */
  outSize(count: number): number;
}

/** Per-op runtime spec: single + bulk execution, plus element access. */
export interface LoaderOpSpec {
  kind: LoaderResultKind;
  /** Single-item execution: `(input, ...rest) → scalar result`. */
  scalar(input: Uint8Array, ...rest: unknown[]): unknown;
  /** Bulk execution: `(items, ...rest) → rust.batch-shaped result`. */
  batch(items: Uint8Array[], ...rest: unknown[]): unknown;
  /** Read the i-th scalar result out of a bulk result. */
  element(bulk: unknown, index: number): unknown;
  /**
   * Zero-alloc fast bulk path for the coalesced `load()` flush. Ops with this
   * MUST keep `element` returning the same per-item value as `fast.element`.
   */
  fast?: LoaderFastSpec;
  /**
   * Indices into the bulk `rest` args that are PER-ITEM companion arrays
   * (paired ops). Used only by the adaptive scalar-loop fallback to split
   * companions per item; the packed batch path passes them through unchanged.
   */
  pairedRest?: number[];
  /**
   * Bigint ops whose bulk result is UNSIGNED (`BigUint64Array`). The adaptive
   * scalar-loop fallback builds the same unsigned array so single/bulk parity
   * holds for high-bit hashes.
   */
  unsigned?: boolean;
}

function boolElem(bulk: unknown, index: number): boolean {
  return ((bulk as Uint8Array)[index] ?? 0) === 1;
}
function numElem(bulk: unknown, index: number): number {
  return (bulk as Uint32Array)[index] as number;
}
function bigElem(bulk: unknown, index: number): bigint {
  return (bulk as BigInt64Array)[index] as bigint;
}
function byteElem(bulk: unknown, index: number): Uint8Array {
  return (bulk as Uint8Array[])[index] as Uint8Array;
}

// ── Zero-alloc fast-bulk readers (packed output → scalar) ──────────

function boolFast(_view: DataView, output: Uint8Array, index: number): boolean {
  return (((output[4 + (index >> 3)] ?? 0) >> (index & 7)) & 1) === 1;
}
function bitsetOutSize(count: number): number {
  return 4 + Math.ceil(count / 8);
}
function u32Fast(view: DataView, _output: Uint8Array, index: number): number {
  return view.getUint32(4 + index * 4, true);
}
function u32OutSize(count: number): number {
  return 4 + count * 4;
}
function i64Fast(view: DataView, _output: Uint8Array, index: number): bigint {
  return view.getBigInt64(4 + index * 8, true);
}
function u64Fast(view: DataView, _output: Uint8Array, index: number): bigint {
  return view.getBigUint64(4 + index * 8, true);
}
function i64OutSize(count: number): number {
  return 4 + count * 8;
}

// Native `_into` packed batch fns (lazy addon; resolved + cached on first use
// so the flush path skips the lazy-addon Proxy get after warm-up).
const fastNative = new Map<
  string,
  (packed: Uint8Array, output: Uint8Array) => number
>();
function fastInto(
  name: string,
): (packed: Uint8Array, output: Uint8Array) => number {
  let f = fastNative.get(name);
  if (f === undefined) {
    f = (
      addon as unknown as Record<
        string,
        (packed: Uint8Array, output: Uint8Array) => number
      >
    )[name] as (packed: Uint8Array, output: Uint8Array) => number;
    fastNative.set(name, f);
  }
  return f;
}

const BOOLEAN = "boolean";
const NUMBER = "number";
const BIGINT = "bigint";
const BYTES = "bytes";

/**
 * Registry — single source of truth for loader-op wiring. Every op must have
 * a scalar variant and a packed batch variant; ops whose scalar returns
 * something other than the bulk element (e.g. `jwtVerify` returning the
 * decoded payload, `verifyCookie` returning the value) are deliberately
 * EXCLUDED so single and bulk semantics stay identical.
 */
export const LOADER_OPS = {
  crc32: {
    kind: NUMBER,
    scalar: (i: Uint8Array) => rust.crc32(i),
    batch: (items: Uint8Array[]) => rust.batch.crc32(items),
    element: numElem,
    fast: {
      batch: (packed, output) => fastInto("crc32BatchPackedInto")(packed, output),
      element: u32Fast,
      outSize: u32OutSize,
    },
  },
  fnv1a64: {
    kind: BIGINT,
    unsigned: true,
    scalar: (i: Uint8Array) => rust.fnv1a64(i),
    batch: (items: Uint8Array[]) => rust.batch.fnv1a64(items),
    element: bigElem,
    fast: {
      batch: (packed, output) => fastInto("fnv1A64BatchPackedInto")(packed, output),
      element: u64Fast,
      outSize: i64OutSize,
    },
  },
  jsonValid: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array) => rust.jsonValid(i),
    batch: (items: Uint8Array[]) => rust.batch.jsonValid(items),
    element: boolElem,
    fast: {
      batch: (packed, output) => fastInto("jsonValidBatchPackedInto")(packed, output),
      element: boolFast,
      outSize: bitsetOutSize,
    },
  },
  jsonSumIds: {
    kind: BIGINT,
    scalar: (i: Uint8Array) => rust.jsonSumIds(i),
    batch: (items: Uint8Array[]) => rust.batch.jsonSumIds(items),
    element: bigElem,
    fast: {
      batch: (packed, output) => fastInto("jsonSumBatchPackedInto")(packed, output),
      element: i64Fast,
      outSize: i64OutSize,
    },
  },
  validateEmail: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array) => rust.validateEmail(i),
    batch: (items: Uint8Array[]) => rust.batch.validateEmail(items),
    element: boolElem,
    fast: {
      batch: (packed, output) => fastInto("validateEmailBatchPackedInto")(packed, output),
      element: boolFast,
      outSize: bitsetOutSize,
    },
  },
  validateUuid: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array) => rust.validateUuid(i),
    batch: (items: Uint8Array[]) => rust.batch.validateUuid(items),
    element: boolElem,
    fast: {
      batch: (packed, output) => fastInto("validateUuidBatchPackedInto")(packed, output),
      element: boolFast,
      outSize: bitsetOutSize,
    },
  },
  validateIpv4: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array) => rust.validateIpv4(i),
    batch: (items: Uint8Array[]) => rust.batch.validateIpv4(items),
    element: boolElem,
    fast: {
      batch: (packed, output) => fastInto("validateIpv4BatchPackedInto")(packed, output),
      element: boolFast,
      outSize: bitsetOutSize,
    },
  },
  validateIpv6: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array) => rust.validateIpv6(i),
    batch: (items: Uint8Array[]) => rust.batch.validateIpv6(items),
    element: boolElem,
    fast: {
      batch: (packed, output) => fastInto("validateIpv6BatchPackedInto")(packed, output),
      element: boolFast,
      outSize: bitsetOutSize,
    },
  },
  queryParse: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.queryParsePacked(i),
    batch: (items: Uint8Array[]) => rust.batch.queryParse(items),
    element: byteElem,
  },
  cookieParse: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.cookieParsePacked(i),
    batch: (items: Uint8Array[]) => rust.batch.cookieParse(items),
    element: byteElem,
  },
  formParse: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.formParsePacked(i),
    batch: (items: Uint8Array[]) => rust.batch.formParse(items),
    element: byteElem,
  },
  httpParseRequest: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.httpParseRequestPacked(i),
    batch: (items: Uint8Array[]) => rust.batch.httpParseRequest(items),
    element: byteElem,
  },
  hexEncode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.hexEncode(i),
    batch: (items: Uint8Array[]) => rust.batch.hexEncode(items),
    element: byteElem,
  },
  hexDecode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.hexDecode(i),
    batch: (items: Uint8Array[]) => rust.batch.hexDecode(items),
    element: byteElem,
  },
  base64Encode: {
    kind: BYTES,
    scalar: (i: Uint8Array, urlSafe?: boolean, padding?: boolean) =>
      rust.base64Encode(i, urlSafe, padding),
    batch: (items: Uint8Array[], urlSafe?: boolean, padding?: boolean) =>
      rust.batch.base64Encode(items, urlSafe, padding),
    element: byteElem,
  },
  base64Decode: {
    kind: BYTES,
    scalar: (i: Uint8Array, urlSafe?: boolean, padding?: boolean) =>
      rust.base64Decode(i, urlSafe, padding),
    batch: (items: Uint8Array[], urlSafe?: boolean, padding?: boolean) =>
      rust.batch.base64Decode(items, urlSafe, padding),
    element: byteElem,
  },
  base64UrlEncode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.base64UrlEncode(i),
    batch: (items: Uint8Array[]) => rust.batch.base64UrlEncode(items),
    element: byteElem,
  },
  base64UrlDecode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.base64UrlDecode(i),
    batch: (items: Uint8Array[]) => rust.batch.base64UrlDecode(items),
    element: byteElem,
  },
  gzipCompress: {
    kind: BYTES,
    scalar: (i: Uint8Array, level?: number | null) => rust.gzipCompress(i, level),
    batch: (items: Uint8Array[], level?: number | null) =>
      rust.batch.gzipCompress(items, level),
    element: byteElem,
  },
  gzipDecompress: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.gzipDecompress(i),
    batch: (items: Uint8Array[]) => rust.batch.gzipDecompress(items),
    element: byteElem,
  },
  brotliCompress: {
    kind: BYTES,
    scalar: (i: Uint8Array, quality?: number | null) =>
      rust.brotliCompress(i, quality),
    batch: (items: Uint8Array[], quality?: number | null) =>
      rust.batch.brotliCompress(items, quality),
    element: byteElem,
  },
  brotliDecompress: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.brotliDecompress(i),
    batch: (items: Uint8Array[]) => rust.batch.brotliDecompress(items),
    element: byteElem,
  },
  etag: {
    kind: BYTES,
    scalar: (i: Uint8Array, weak?: boolean | null) =>
      rust.etag(i, weak ?? undefined),
    batch: (items: Uint8Array[], weak?: boolean | null) =>
      rust.batch.etag(items, weak),
    element: byteElem,
  },
  urlEncode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.urlEncode(i),
    batch: (items: Uint8Array[]) => rust.batch.urlEncode(items),
    element: byteElem,
  },
  urlDecode: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.urlDecode(i),
    batch: (items: Uint8Array[]) => rust.batch.urlDecode(items),
    element: byteElem,
  },
  urlDecodeBytes: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.urlDecodeBytes(i),
    batch: (items: Uint8Array[]) => rust.batch.urlDecodeBytes(items),
    element: byteElem,
  },
  wsAcceptKey: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.wsAcceptKey(i),
    batch: (items: Uint8Array[]) => rust.batch.wsAcceptKey(items),
    element: byteElem,
  },
  mimeFromExtension: {
    kind: BYTES,
    scalar: (i: Uint8Array) => rust.mimeFromExtension(i),
    batch: (items: Uint8Array[]) => rust.batch.mimeFromExtension(items),
    element: byteElem,
  },
  signCookie: {
    kind: BYTES,
    scalar: (i: Uint8Array, secret: Uint8Array) => rust.signCookie(i, secret),
    batch: (items: Uint8Array[], secret: Uint8Array) =>
      rust.batch.signCookie(items, secret),
    element: byteElem,
  },
  // Boolean-validity op: single returns valid/invalid (not the decoded value).
  // Use `rust.verifyCookie` when you need the signed value back.
  verifyCookie: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array, secret: Uint8Array) =>
      rust.verifyCookie(i, secret) !== null,
    batch: (items: Uint8Array[], secret: Uint8Array) =>
      rust.batch.verifyCookie(items, secret),
    element: boolElem,
  },
  csrfVerify: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array, secret: Uint8Array) => rust.csrfVerify(i, secret),
    batch: (items: Uint8Array[], secret: Uint8Array) =>
      rust.batch.csrfVerify(items, secret),
    element: boolElem,
  },
  passwordHash: {
    kind: BYTES,
    scalar: (i: Uint8Array, salt: Uint8Array, options?: PasswordHashOptions | null) =>
      rust.passwordHash(i, salt, options),
    batch: (
      items: Uint8Array[],
      salt: Uint8Array,
      options?: PasswordHashOptions | null,
    ) => rust.batch.passwordHash(items, salt, options),
    element: byteElem,
  },
  passwordVerify: {
    kind: BOOLEAN,
    pairedRest: [0],
    scalar: (i: Uint8Array, phc: Uint8Array) => rust.passwordVerify(i, phc),
    batch: (items: Uint8Array[], phcs: Uint8Array[]) =>
      rust.batch.passwordVerify(items, phcs),
    element: boolElem,
  },
  aeadEncrypt: {
    kind: BYTES,
    scalar: (i: Uint8Array, key: Uint8Array, nonce: Uint8Array, algorithm?: string | null) =>
      rust.aeadEncrypt(key, nonce, i, algorithm),
    batch: (items: Uint8Array[], key: Uint8Array, nonce: Uint8Array, algorithm?: string | null) =>
      rust.batch.aeadEncrypt(key, nonce, items, algorithm),
    element: byteElem,
  },
  aeadDecrypt: {
    kind: BYTES,
    scalar: (i: Uint8Array, key: Uint8Array, nonce: Uint8Array, algorithm?: string | null) =>
      rust.aeadDecrypt(key, nonce, i, algorithm) ?? EMPTY_BYTES,
    batch: (items: Uint8Array[], key: Uint8Array, nonce: Uint8Array, algorithm?: string | null) =>
      rust.batch.aeadDecrypt(key, nonce, items, algorithm),
    element: byteElem,
  },
  jwtSign: {
    kind: BYTES,
    // Input is a JSON claim document (bytes); the scalar parses it to the
    // claims object the native signer expects.
    scalar: (
      i: Uint8Array,
      secret: Uint8Array,
      ttlSeconds?: number | null,
      nowSeconds?: number,
    ) => rust.jwtSign(JSON.parse(decoder.decode(i)) as Record<string, unknown>, secret, ttlSeconds, nowSeconds),
    batch: (items: Uint8Array[], secret: Uint8Array, ttlSeconds?: number | null, nowSeconds?: number) =>
      rust.batch.jwtSign(items, secret, ttlSeconds, nowSeconds),
    element: byteElem,
  },
  // Boolean-validity op: single returns valid/invalid (not the payload).
  // Use `rust.jwtVerify` when you need the decoded claims back.
  jwtVerify: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array, secret: Uint8Array, nowSeconds?: number) =>
      rust.jwtVerify(i, secret, nowSeconds) !== null,
    batch: (
      items: Uint8Array[],
      secret: Uint8Array,
      nowSeconds?: number,
    ) =>
      rust.batch.jwtVerify(
        items,
        secret,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      ),
    element: boolElem,
  },
  jsonPatch: {
    kind: BYTES,
    pairedRest: [0],
    scalar: (i: Uint8Array, patch: Uint8Array) => rust.jsonPatch(i, patch),
    batch: (items: Uint8Array[], patches: Uint8Array[]) =>
      rust.batch.jsonPatch(items, patches),
    element: byteElem,
  },
  urlResolve: {
    kind: BYTES,
    pairedRest: [0],
    scalar: (i: Uint8Array, base: Uint8Array) => rust.urlResolve(base, i),
    batch: (items: Uint8Array[], bases: Uint8Array[]) =>
      rust.batch.urlResolve(bases, items),
    element: byteElem,
  },
  wsFrameEncode: {
    kind: BYTES,
    scalar: (i: Uint8Array, opcode: number, mask: boolean, fin: boolean) =>
      rust.wsFrameEncode(opcode, i, mask, fin),
    batch: (items: Uint8Array[], opcode: number, mask: boolean, fin: boolean) =>
      rust.batch.wsFrameEncode(items, opcode, mask, fin),
    element: byteElem,
  },
  sseEncode: {
    kind: BYTES,
    scalar: (i: Uint8Array, event?: string | null, id?: string | null, retry?: number | null) =>
      rust.sseEncodeEvent(event ?? null, i, id ?? null, retry ?? null),
    batch: (items: Uint8Array[], event?: string | null, id?: string | null, retry?: number | null) =>
      rust.batch.sseEncode(items, event, id, retry),
    element: byteElem,
  },
  schemaValidate: {
    kind: BOOLEAN,
    scalar: (i: Uint8Array, validator: SchemaValidator) => validator.validate(i),
    batch: (items: Uint8Array[], validator: SchemaValidator) =>
      rust.batch.schemaValidate(validator, items),
    element: boolElem,
  },
  hmacSha256: {
    kind: BYTES,
    // NOTE: scalar arg order is (key, data); the loader normalizes to
    // (input, ...rest) so callers pass the key as the trailing argument.
    scalar: (i: Uint8Array, key: Uint8Array) => rust.hmacSha256(key, i),
    batch: (items: Uint8Array[], key: Uint8Array) =>
      rust.batch.hmacSha256(items, key),
    element: byteElem,
  },
  hmacSha256Verify: {
    kind: BOOLEAN,
    pairedRest: [1],
    // scalar arg order is (key, data, sig); normalized to (input=data, key, sig).
    scalar: (i: Uint8Array, key: Uint8Array, sig: Uint8Array) =>
      rust.hmacSha256Verify(key, i, sig),
    batch: (items: Uint8Array[], key: Uint8Array, sigs: Uint8Array[]) =>
      rust.batch.hmacSha256Verify(items, sigs, key),
    element: boolElem,
  },
} as const satisfies Record<LoaderOpName, LoaderOpSpec>;

/** Kind of a specific op. */
export type LoaderOpKind<K extends LoaderOpName> = (typeof LOADER_OPS)[K]["kind"];
/** Single-item result type of a specific op. */
export type LoaderScalar<K extends LoaderOpName> = ScalarResult<LoaderOpKind<K>>;

/** All op names, as a readonly array (for iteration). */
export const LOADER_OP_NAMES = Object.keys(LOADER_OPS) as LoaderOpName[];
