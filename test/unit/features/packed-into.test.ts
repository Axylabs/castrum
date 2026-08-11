/**
 * Tests for the reusable-output packed-parser FFI: `rust.httpParseRequestPackedInto`,
 * `rust.queryParsePackedInto`, `rust.cookieParsePackedInto`. Each writes the same
 * packed output as its allocating sibling into a caller-provided buffer and returns
 * the number of bytes written (so hot loops can pool the buffer).
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";

const HTTP_RAW = encoder.encode(
  "GET /api/users?page=1&limit=20 HTTP/1.1\r\n" +
    "Host: example.com\r\n" +
    "Accept: application/json\r\n" +
    "Authorization: Bearer token\r\n" +
    "Cookie: sid=abc; theme=dark\r\n" +
    "\r\n",
);
const QUERY = encoder.encode("name=John+Doe&age=30&tags[]=a&tags[]=b&empty=&enc=%20hi%20");
const COOKIE = encoder.encode("session=abc123; theme=dark; lang=en-US");

describe("rust.httpParseRequestPackedInto", () => {
  test("matches httpParseRequestPacked byte-for-byte", () => {
    const expected = rust.httpParseRequestPacked(HTTP_RAW);
    const out = new Uint8Array(expected.length);
    const written = rust.httpParseRequestPackedInto(HTTP_RAW, out);
    expect(written).toBe(expected.length);
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected));
  });

  test("too-small output throws", () => {
    expect(() => rust.httpParseRequestPackedInto(HTTP_RAW, new Uint8Array(4))).toThrow();
  });
});

describe("rust.queryParsePackedInto", () => {
  test("matches queryParsePacked byte-for-byte", () => {
    const expected = rust.queryParsePacked(QUERY);
    const out = new Uint8Array(expected.length);
    const written = rust.queryParsePackedInto(QUERY, out);
    expect(written).toBe(expected.length);
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected));
  });

  test("too-small output throws", () => {
    expect(() => rust.queryParsePackedInto(QUERY, new Uint8Array(4))).toThrow();
  });
});

describe("rust.cookieParsePackedInto", () => {
  test("matches cookieParsePacked byte-for-byte", () => {
    const expected = rust.cookieParsePacked(COOKIE);
    const out = new Uint8Array(expected.length);
    const written = rust.cookieParsePackedInto(COOKIE, out);
    expect(written).toBe(expected.length);
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected));
  });

  test("too-small output throws", () => {
    expect(() => rust.cookieParsePackedInto(COOKIE, new Uint8Array(4))).toThrow();
  });
});
