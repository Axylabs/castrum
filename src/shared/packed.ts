import { decoder, encoder } from "./bytes";

// Add this import at the top of src/shared/packed.ts
import type { SchemaValidatorInstance } from "../native";

// Add this type alias near the top with other exports
export type SchemaValidator = SchemaValidatorInstance;

// ... (keep all your existing functions: packBatch, unpackBitset, etc.) ...

// Add these two new functions at the bottom of the file
export function schemaValidateBatch(validator: SchemaValidator, items: Uint8Array[]): Uint8Array {
  return unpackBitset(validator.validateBatchPackedBitset(packBatch(items)));
}

export function schemaValidateBatchCount(validator: SchemaValidator, items: Uint8Array[]): number {
  return validator.validateBatchPackedCount(packBatch(items));
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

export function unpackBitset(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);
  const bits = bytes.subarray(4);

  const out = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = (bits[i >> 3]! >> (i & 7)) & 1;
  }

  return out;
}

export function unpackI32Array(bytes: Uint8Array): Int32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);

  const out = new Int32Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = dv.getInt32(4 + i * 4, true);
  }

  return out;
}

export function unpackI64ArrayAsBigInt(bytes: Uint8Array): BigInt64Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);

  const out = new BigInt64Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = dv.getBigInt64(4 + i * 8, true);
  }

  return out;
}

export function unpackByteResults(bytes: Uint8Array): Uint8Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);

  const out: Uint8Array[] = [];

  let offset = 4;

  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(offset, true);
    offset += 4;

    out.push(bytes.subarray(offset, offset + len));

    offset += len;
  }

  return out;
}

export type Pair = [string, string];

export function readPairsPacked(bytes: Uint8Array): Pair[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const count = dv.getUint32(0, true);

  const out: Pair[] = [];

  let offset = 4;

  for (let i = 0; i < count; i++) {
    const keyLen = dv.getUint32(offset, true);
    offset += 4;

    const key = decoder.decode(bytes.subarray(offset, offset + keyLen));
    offset += keyLen;

    const valueLen = dv.getUint32(offset, true);
    offset += 4;

    const value = decoder.decode(bytes.subarray(offset, offset + valueLen));
    offset += valueLen;

    out.push([key, value]);
  }

  return out;
}

export function pairsToObject(pairs: Pair[]): Record<string, string | string[]> {
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
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;

  const methodLen = dv.getUint32(offset, true);
  offset += 4;

  const method = decoder.decode(bytes.subarray(offset, offset + methodLen));
  offset += methodLen;

  const pathLen = dv.getUint32(offset, true);
  offset += 4;

  const path = decoder.decode(bytes.subarray(offset, offset + pathLen));
  offset += pathLen;

  const versionLen = dv.getUint32(offset, true);
  offset += 4;

  const version = decoder.decode(bytes.subarray(offset, offset + versionLen));
  offset += versionLen;

  const headerCount = dv.getUint32(offset, true);
  offset += 4;

  const headers: Record<string, string> = {};

  for (let i = 0; i < headerCount; i++) {
    const nameLen = dv.getUint32(offset, true);
    offset += 4;

    const name = decoder.decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;

    const valueLen = dv.getUint32(offset, true);
    offset += 4;

    const value = decoder.decode(bytes.subarray(offset, offset + valueLen));
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