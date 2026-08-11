/**
 * Tests for the Rust HTTP-cache FFI: `rust.etag`, `rust.httpDate`,
 * `rust.parseHttpDate`, and `rust.createConditionalRequest` (higher-order
 * instance) — cross-checked against the JS baselines.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";
import {
  nativeEtag,
  nativeHttpDate,
  nativeIsNotModified,
} from "../../../src/bench/etag-baseline";

const DATA = encoder.encode("hello world, this is etag data");
const SECS = 784111777; // Sun, 06 Nov 1994 08:49:37 GMT

describe("rust.etag", () => {
  test("matches the crc32-based JS baseline byte-for-byte", () => {
    expect(decoder.decode(rust.etag(DATA))).toBe(decoder.decode(nativeEtag(DATA)));
    expect(decoder.decode(rust.etag(DATA, true))).toBe(
      decoder.decode(nativeEtag(DATA, true)),
    );
  });

  test("formats weak/strong correctly", () => {
    expect(decoder.decode(rust.etag(DATA))).toMatch(/^"[0-9a-f]{8}"$/);
    expect(decoder.decode(rust.etag(DATA, true))).toMatch(/^W\/"[0-9a-f]{8}"$/);
  });
});

describe("rust.httpDate / parseHttpDate", () => {
  test("matches Date.toUTCString()", () => {
    expect(decoder.decode(rust.httpDate(SECS))).toBe(
      decoder.decode(nativeHttpDate(SECS)),
    );
  });

  test("roundtrips through parseHttpDate", () => {
    const formatted = decoder.decode(rust.httpDate(SECS));
    expect(rust.parseHttpDate(encoder.encode(formatted))).toBe(BigInt(SECS));
  });

  test("parseHttpDate returns null on malformed input", () => {
    expect(rust.parseHttpDate(encoder.encode("not a date"))).toBeNull();
  });
});

describe("ConditionalRequest (higher-order instance)", () => {
  const etagBytes = rust.etag(DATA);
  const etagStr = decoder.decode(etagBytes);

  test("If-None-Match match → 304", () => {
    const c = rust.createConditionalRequest(etagBytes, SECS);
    expect(c.isNotModified(encoder.encode(`"x", ${etagStr}`), null)).toBe(true);
    expect(c.isNotModified(encoder.encode('"x", W/"y"'), null)).toBe(false);
    expect(c.isNotModified(encoder.encode("*"), null)).toBe(true);
  });

  test("If-Modified-Since parity with JS baseline", () => {
    const c = rust.createConditionalRequest(etagBytes, SECS);
    for (const date of [
      "Sun, 06 Nov 1994 08:49:37 GMT",
      "Sun, 06 Nov 1994 08:49:36 GMT",
      "Mon, 01 Jan 2001 00:00:00 GMT",
    ]) {
      expect(c.isNotModified(null, encoder.encode(date))).toBe(
        nativeIsNotModified(etagStr, SECS, null, date),
      );
    }
  });
});

describe("rust.etagInto (reusable output)", () => {
  test("matches rust.etag byte-for-byte", () => {
    const out = new Uint8Array(16);
    const written = rust.etagInto(DATA, out);
    const expected = rust.etag(DATA);
    expect(written).toBe(expected.length);
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected));
  });

  test("weak variant matches rust.etag(data, true)", () => {
    const out = new Uint8Array(16);
    const written = rust.etagInto(DATA, out, true);
    const expected = rust.etag(DATA, true);
    expect(written).toBe(expected.length);
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected));
  });

  test("too-small output throws", () => {
    expect(() => rust.etagInto(DATA, new Uint8Array(4))).toThrow();
  });
});
