/**
 * Tests for src/shared/packed.ts
 *
 * Covers:
 * - packBatch packing logic
 * - unpackBitset bit extraction
 * - unpackByteResults byte array extraction
 * - unpackI64ArrayAsBigInt bigint extraction
 */

import { describe, test, expect } from "bun:test";
import {
  packBatch,
  unpackBitset,
  unpackByteResults,
  unpackI64ArrayAsBigInt,
} from "../../../src/shared/packed";

describe("packBatch", () => {
  test("packs multiple buffers with length prefixes", () => {
    const bufs = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ];
    const packed = packBatch(bufs);

    const dv = new DataView(packed.buffer);
    expect(dv.getUint32(0, true)).toBe(3); // 3 items

    let offset = 4;
    for (let i = 0; i < bufs.length; i++) {
      const len = dv.getUint32(offset, true);
      expect(len).toBe(bufs[i]!.length);
      offset += 4;
      const slice = packed.slice(offset, offset + len);
      expect([...slice]).toEqual([...bufs[i]!]);
      offset += len;
    }
  });

  test("handles empty array", () => {
    const packed = packBatch([]);
    const dv = new DataView(packed.buffer);
    expect(dv.getUint32(0, true)).toBe(0);
    expect(packed.byteLength).toBe(4);
  });

  test("handles array with empty buffers", () => {
    const bufs = [new Uint8Array(0), new Uint8Array([1])];
    const packed = packBatch(bufs);
    const dv = new DataView(packed.buffer);
    expect(dv.getUint32(0, true)).toBe(2);

    let offset = 4;
    const len1 = dv.getUint32(offset, true);
    expect(len1).toBe(0);
    offset += 4;

    const len2 = dv.getUint32(offset, true);
    expect(len2).toBe(1);
    offset += 4;
    expect(packed[offset]).toBe(1);
  });
});

describe("unpackBitset", () => {
  test("extracts bits from packed results", () => {
    // Build: count=8, then 1 byte of bits
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 8, true); // count = 8 items
    buf[4] = 0b10101010;       // bits: 1,0,1,0,1,0,1,0

    const result = unpackBitset(buf);
    expect(result.length).toBe(8);
    // result is Uint8Array where each element is 0 or 1
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(1);
    expect(result[4]).toBe(0);
    expect(result[5]).toBe(1);
    expect(result[6]).toBe(0);
    expect(result[7]).toBe(1);
  });

  test("handles multiple bytes", () => {
    const buf = new Uint8Array(9);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 9, true); // count = 9 items
    buf[4] = 0b11111111;      // first 8 bits all 1
    buf[5] = 0b00000001;      // 9th bit = 1

    const result = unpackBitset(buf);
    expect(result.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(result[i]).toBe(1);
    }
  });

  test("handles empty buffer", () => {
    const result = unpackBitset(new Uint8Array(0));
    expect(result.length).toBe(0);
  });

  test("handles all zeros", () => {
    const buf = new Uint8Array(6);
    new DataView(buf.buffer).setUint32(0, 16, true); // 16 items, no bits set

    const result = unpackBitset(buf);
    expect(result.length).toBe(16);
    expect(result.every((b) => b === 0)).toBe(true);
  });
});

describe("unpackByteResults", () => {
  test("unpacks length-prefixed byte results", () => {
    // Format: count, len1, data1, len2, data2, ...
    // count(4) + len1(4) + data1(3) + len2(4) + data2(1) = 16 bytes
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    let off = 0;
    dv.setUint32(off, 2, true); off += 4; // 2 items
    dv.setUint32(off, 3, true); off += 4; // len1 = 3 bytes
    buf[off++] = 10;                       // data1 start
    buf[off++] = 20;
    buf[off++] = 30;
    dv.setUint32(off, 1, true); off += 4; // len2 = 1 byte
    buf[off++] = 40;                       // data2

    const result = unpackByteResults(buf);
    expect(result.length).toBe(2);
    expect([...result[0]!]).toEqual([10, 20, 30]);
    expect([...result[1]!]).toEqual([40]);
  });

  test("handles empty results", () => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 0, true);
    const result = unpackByteResults(buf);
    expect(result).toEqual([]);
  });

  test("handles results with zero-length items", () => {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 2, true);  // 2 items
    dv.setUint32(4, 0, true);  // first: 0 bytes
    dv.setUint32(8, 1, true);  // second: 1 byte
    buf[12] = 42;

    const result = unpackByteResults(buf);
    expect(result.length).toBe(2);
    expect(result[0]!.byteLength).toBe(0);
    expect([...result[1]!]).toEqual([42]);
  });
});

describe("unpackI64ArrayAsBigInt", () => {
  test("unpacks single i64 value", () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true);   // 1 item
    dv.setBigInt64(4, BigInt("12345678901234"), true); // fits in i64

    const result = unpackI64ArrayAsBigInt(buf);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(BigInt("12345678901234"));
  });

  test("unpacks multiple i64 values", () => {
    const buf = new Uint8Array(20);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 2, true);
    dv.setBigInt64(4, BigInt("9223372036854775807"), true); // max int64
    dv.setBigInt64(12, BigInt("-9223372036854775808"), true); // min int64

    const result = unpackI64ArrayAsBigInt(buf);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(BigInt("9223372036854775807"));
    expect(result[1]).toBe(BigInt("-9223372036854775808"));
  });

  test("handles zero values", () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true);
    dv.setBigInt64(4, BigInt(0), true);

    const result = unpackI64ArrayAsBigInt(buf);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(BigInt(0));
  });

  test("handles empty array", () => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 0, true);
    const result = unpackI64ArrayAsBigInt(buf);
    expect(result.length).toBe(0);
  });
});