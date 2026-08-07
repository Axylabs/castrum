/**
 * Tests for the Rust encoding FFI: `rust.base64Encode/Decode`,
 * `rust.base64urlEncode/Decode`, `rust.hexEncode/Decode`, and
 * `rust.createBase64Codec` (higher-order instance) — cross-checked against
 * the Buffer baseline.
 */

import { describe, test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";
import {
  nativeBase64Decode,
  nativeBase64Encode,
  nativeHexDecode,
  nativeHexEncode,
} from "../../../src/bench/encoding-baseline";

const DATA = new Uint8Array([104, 105, 0, 255, 32, 64, 126, 10]); // "hi\0\xff @~\n"

describe("base64", () => {
  test("encode matches Buffer baseline", () => {
    expect(Array.from(rust.base64Encode(DATA))).toEqual(
      Array.from(encoder.encode(Buffer.from(DATA).toString("base64"))),
    );
    expect(Array.from(rust.base64UrlEncode(DATA))).toEqual(
      Array.from(encoder.encode(Buffer.from(DATA).toString("base64url"))),
    );
  });

  test("decode roundtrips byte-for-byte", () => {
    const enc = rust.base64Encode(DATA);
    expect(Array.from(rust.base64Decode(enc))).toEqual(Array.from(DATA));
  });

  test("decode throws on invalid input", () => {
    expect(() => rust.base64Decode(encoder.encode("!!!"))).toThrow();
  });

  test("Base64Codec instance (url-safe, no pad)", () => {
    const codec = rust.createBase64Codec(true, false);
    expect(decoder.decode(codec.encode(DATA))).toBe(
      Buffer.from(DATA).toString("base64url"),
    );
    expect(Array.from(codec.decode(codec.encode(DATA)))).toEqual(
      Array.from(DATA),
    );
  });
});

describe("hex", () => {
  test("encode matches Buffer baseline", () => {
    expect(Array.from(rust.hexEncode(DATA))).toEqual(
      Array.from(nativeHexEncode(DATA)),
    );
  });

  test("decode roundtrips byte-for-byte", () => {
    const enc = decoder.decode(rust.hexEncode(DATA));
    expect(Array.from(rust.hexDecode(encoder.encode(enc)))).toEqual(
      Array.from(DATA),
    );
    expect(Array.from(rust.hexDecode(nativeHexEncode(DATA)))).toEqual(
      Array.from(nativeHexDecode(nativeHexEncode(DATA))),
    );
  });

  test("decode throws on odd length and bad digits", () => {
    expect(() => rust.hexDecode(encoder.encode("abc"))).toThrow();
    expect(() => rust.hexDecode(encoder.encode("zz"))).toThrow();
  });
});
