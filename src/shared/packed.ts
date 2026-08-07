import { decoder, encoder } from "./bytes";
import { getAddon, lazyAddon, type SchemaValidatorInstance } from "../native";

// Lazy: importing this module does not dlopen the addon until first use.
const addon = lazyAddon(getAddon);

export type SchemaValidator = SchemaValidatorInstance;

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(dv: DataView, offset: number): number {
  if (offset + 4 > dv.byteLength) {
    throw new RangeError("packed buffer: truncated u32");
  }

  return dv.getUint32(offset, true);
}

function readSlice(bytes: Uint8Array, offset: number, len: number): Uint8Array {
  if (len < 0 || offset + len > bytes.byteLength) {
    throw new RangeError("packed buffer: truncated bytes");
  }

  return bytes.subarray(offset, offset + len);
}

export function unpackU32Array(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength < 4) {
    return new Uint32Array(0);
  }

  const dv = dataView(bytes);
  const count = readU32(dv, 0);

  if (count > Math.floor((bytes.byteLength - 4) / 4)) {
    throw new RangeError("packed buffer: invalid u32 count");
  }

  const out = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = readU32(dv, 4 + i * 4);
  }

  return out;
}

export function unpackBitset(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4) {
    return new Uint8Array(0);
  }

  const dv = dataView(bytes);
  const count = readU32(dv, 0);
  const expectedBytes = Math.ceil(count / 8);

  if (bytes.byteLength < 4 + expectedBytes) {
    throw new RangeError("packed buffer: truncated bitset");
  }

  const bits = bytes.subarray(4);
  const out = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const byte = bits[i >> 3] ?? 0;
    out[i] = (byte >> (i & 7)) & 1;
  }

  return out;
}

export function unpackI64ArrayAsBigInt(bytes: Uint8Array): BigInt64Array {
  if (bytes.byteLength < 4) {
    return new BigInt64Array(0);
  }

  const dv = dataView(bytes);
  const count = readU32(dv, 0);

  if (count > Math.floor((bytes.byteLength - 4) / 8)) {
    throw new RangeError("packed buffer: invalid i64 count");
  }

  const out = new BigInt64Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = dv.getBigInt64(4 + i * 8, true);
  }

  return out;
}

export function unpackByteResults(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength < 4) {
    return [];
  }

  const dv = dataView(bytes);
  const count = readU32(dv, 0);

  const out: Uint8Array[] = [];
  let offset = 4;

  for (let i = 0; i < count; i++) {
    const len = readU32(dv, offset);
    offset += 4;

    const slice = readSlice(bytes, offset, len);
    offset += len;

    out.push(slice);
  }

  return out;
}

export type Pair = [string, string];

export function readPairsPacked(bytes: Uint8Array): Pair[] {
  if (bytes.byteLength < 4) {
    return [];
  }

  const dv = dataView(bytes);
  const count = readU32(dv, 0);

  if (count === 0) {
    return [];
  }

  const out: Pair[] = [];
  let offset = 4;

  for (let i = 0; i < count; i++) {
    const keyLen = readU32(dv, offset);
    offset += 4;

    const keyBytes = readSlice(bytes, offset, keyLen);
    offset += keyLen;

    const valueLen = readU32(dv, offset);
    offset += 4;

    const valueBytes = readSlice(bytes, offset, valueLen);
    offset += valueLen;

    out.push([decoder.decode(keyBytes), decoder.decode(valueBytes)]);
  }

  return out;
}

export function pairsToObject(
  pairs: Pair[],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};

  for (const [key, value] of pairs) {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }

  return out;
}

export interface ParsedHttpRequestPacked {
  method: string;
  path: string;
  version: string;
  headers: Record<string, string>;
}

export function readHttpPacked(bytes: Uint8Array): ParsedHttpRequestPacked {
  const dv = dataView(bytes);
  let offset = 0;

  const methodLen = readU32(dv, offset);
  offset += 4;
  const method = decoder.decode(readSlice(bytes, offset, methodLen));
  offset += methodLen;

  const pathLen = readU32(dv, offset);
  offset += 4;
  const path = decoder.decode(readSlice(bytes, offset, pathLen));
  offset += pathLen;

  const versionLen = readU32(dv, offset);
  offset += 4;
  const version = decoder.decode(readSlice(bytes, offset, versionLen));
  offset += versionLen;

  const headerCount = readU32(dv, offset);
  offset += 4;

  const headers: Record<string, string> = {};

  for (let i = 0; i < headerCount; i++) {
    const nameLen = readU32(dv, offset);
    offset += 4;
    const name = decoder.decode(readSlice(bytes, offset, nameLen));
    offset += nameLen;

    const valueLen = readU32(dv, offset);
    offset += 4;
    const value = decoder.decode(readSlice(bytes, offset, valueLen));
    offset += valueLen;

    headers[name] = value;
  }

  return {
    method,
    path,
    version,
    headers,
  };
}

export function packBatch(items: Uint8Array[]): Uint8Array {
  let total = 4;

  for (const item of items) {
    total += 4 + item.byteLength;
  }

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, items.length, true);

  let offset = 4;

  for (const item of items) {
    dv.setUint32(offset, item.byteLength, true);
    offset += 4;

    out.set(item, offset);
    offset += item.byteLength;
  }

  return out;
}

export function packPairs(pairs: Array<[string, string]>): Uint8Array {
  const encoded = pairs.map(
    ([key, value]) => [encoder.encode(key), encoder.encode(value)] as const,
  );

  let total = 4;

  for (const [key, value] of encoded) {
    total += 8 + key.byteLength + value.byteLength;
  }

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, encoded.length, true);

  let offset = 4;

  for (const [key, value] of encoded) {
    dv.setUint32(offset, key.byteLength, true);
    offset += 4;
    out.set(key, offset);
    offset += key.byteLength;

    dv.setUint32(offset, value.byteLength, true);
    offset += 4;
    out.set(value, offset);
    offset += value.byteLength;
  }

  return out;
}

export function schemaValidateBatch(
  validator: SchemaValidator,
  items: Uint8Array[],
): Uint8Array {
  return unpackBitset(validator.validateBatchPackedBitset(packBatch(items)));
}

export function schemaValidateBatchCount(
  validator: SchemaValidator,
  items: Uint8Array[],
): number {
  return validator.validateBatchPackedCount(packBatch(items));
}

// ── High-level string parsers (convenience) ──────────────────────
// Wrap the native packed parsers + decoders for ergonomic use, so consumers
// don't have to hand-pack buffers or decode packed pairs:
//   parseQueryString("a=1&b=2")    // { a: "1", b: "2" }
//   parseCookieHeader("a=1; b=2")  // { a: "1", b: "2" }

export function parseQueryString(
  query: string,
): Record<string, string | string[]> {
  const packed = addon.queryParsePacked(encoder.encode(query));
  return pairsToObject(readPairsPacked(packed));
}

export function parseCookieHeader(
  header: string,
): Record<string, string | string[]> {
  const packed = addon.cookieParsePacked(encoder.encode(header));
  return pairsToObject(readPairsPacked(packed));
}