// src/rust-ffi/raw.ts — v4: REDUCED RAYON THREADS FOR BUN 1.4 COEXISTENCE
//
// Bun 1.4's Rust runtime uses its own thread pool for HTTP, GC, and I/O.
// We reduce Rayon threads to avoid CPU contention.

import addon from "../native";
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
import { rustNative } from "../native/wrapper";

// ⭐ Reduced from min(8, cores) to min(4, cores-2) to leave room for Bun 1.4's
// internal Rust threads (HTTP accept, GC, I/O poll).
const cores = navigator.hardwareConcurrency || 4;
const rayonThreads = Math.max(1, Math.min(4, cores - 2));
rustNative.initThreadPool(rayonThreads);

export function createRawRustClient() {
  return {
    crc32: rustNative.crc32,
    fnv1A64: rustNative.fnv1a64,
    hmacSha256: rustNative.hmacSha256,
    hmacSha256Verify: rustNative.hmacSha256Verify,
    jsonValid: rustNative.jsonValid,
    jsonSumIds: rustNative.jsonSumIds,
    jsonPatch: rustNative.jsonPatch,
    mimeFromExtension: rustNative.mimeFromExtension,
    randomToken: rustNative.randomToken,
    urlEncode: rustNative.urlEncode,
    urlDecode: rustNative.urlDecode,
    validateEmail: rustNative.validateEmail,
    validateUuid: rustNative.validateUuid,
    validateIpv4: rustNative.validateIpv4,
    validateIpv6: rustNative.validateIpv6,
    wsAcceptKey: rustNative.wsAcceptKey,
    createSchemaValidator: rustNative.createSchemaValidator,
    httpParseRequestPacked: rustNative.httpParseRequestPacked,
    httpParseRequestPackedInto: rustNative.httpParseRequestPackedInto,
    queryParsePacked: rustNative.queryParsePacked,
    queryParsePackedInto: rustNative.queryParsePackedInto,
    cookieParsePacked: rustNative.cookieParsePacked,
    cookieParsePackedInto: rustNative.cookieParsePackedInto,
  };
}

export const rustBatch = {
  jsonValid(items: Uint8Array[]): Uint8Array {
    return unpackBitset(addon.jsonValidBatchPacked(packBatch(items)));
  },
  crc32(items: Uint8Array[]): Uint32Array {
    return unpackU32Array(addon.crc32BatchPacked(packBatch(items)));
  },
  validateEmail(items: Uint8Array[]): Uint8Array {
    return unpackBitset(addon.validateEmailBatchPacked(packBatch(items)));
  },
  validateUuid(items: Uint8Array[]): Uint8Array {
    return unpackBitset(addon.validateUuidBatchPacked(packBatch(items)));
  },
  validateIpv4(items: Uint8Array[]): Uint8Array {
    return unpackBitset(addon.validateIpv4BatchPacked(packBatch(items)));
  },
  validateIpv6(items: Uint8Array[]): Uint8Array {
    return unpackBitset(addon.validateIpv6BatchPacked(packBatch(items)));
  },
  jsonSumIds(items: Uint8Array[]): BigInt64Array {
    return unpackI64ArrayAsBigInt(addon.jsonSumBatchPacked(packBatch(items)));
  },
  queryParse(items: Uint8Array[]): Uint8Array[] {
    return unpackByteResults(addon.queryParseBatchPacked(packBatch(items)));
  },
  cookieParse(items: Uint8Array[]): Uint8Array[] {
    return unpackByteResults(addon.cookieParseBatchPacked(packBatch(items)));
  },
  httpParseRequest(items: Uint8Array[]): Uint8Array[] {
    return unpackByteResults(addon.httpParseRequestBatchPacked(packBatch(items)));
  },
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array {
    return schemaValidateBatch(validator, items);
  },
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number {
    return schemaValidateBatchCount(validator, items);
  },
};

export type RawRustClient = ReturnType<typeof createRawRustClient>;
export const rust = createRawRustClient();