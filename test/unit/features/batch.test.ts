/**
 * Tests for the expanded `rust.batch.*` namespace — the new byte-array batch
 * methods (fnv1a64, etag, url, base64url, wsAcceptKey, mime) and the
 * backend-framework batch methods (passwordVerify, urlResolve, jwtSign,
 * sseEncode, wsFrameEncode/Decode, multipartParse). Each batch result is
 * checked against its scalar `rust.<op>` counterpart.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";

const bytes = (s: string): Uint8Array => encoder.encode(s);

const SECRET = bytes("s3cr3t");
const RAW_FBFF = new Uint8Array([0xfb, 0xff]);

describe("rust.batch: hashing / url / mime / ws / base64url", () => {
  test("fnv1a64 batch is unsigned and matches the scalar", () => {
    const h = rust.batch.fnv1a64([bytes("foobar"), bytes(""), bytes("a")]);
    expect(h).toBeInstanceOf(BigUint64Array);
    expect(h[0]).toBe(0x8594_4171_f739_67e8n);
    expect(h[1]).toBe(0xcbf2_9ce4_8422_2325n);
    expect(h[2]).toBe(rust.fnv1a64(bytes("a")));
  });

  test("etag batch (strong + weak) matches the scalar", () => {
    const strong = rust.batch.etag([bytes("123456789"), bytes("x")]);
    expect(strong[0]).toEqual(bytes('"cbf43926"'));
    expect(strong[1]).toEqual(rust.etag(bytes("x")));
    const weak = rust.batch.etag([bytes("123456789")], true);
    expect(weak[0]).toEqual(bytes('W/"cbf43926"'));
  });

  test("url encode/decode batches match the scalar", () => {
    expect(rust.batch.urlEncode([bytes("a b&c")])[0]).toEqual(bytes("a%20b%26c"));
    expect(rust.batch.urlDecode([bytes("a%20b")])[0]).toEqual(bytes("a b"));
    const utf8 = new Uint8Array([0xc3, 0xa9]);
    expect(rust.batch.urlDecodeBytes([bytes("%C3%A9")])[0]).toEqual(utf8);
    // skip-on-error: malformed %XX → empty
    expect(rust.batch.urlDecode([bytes("bad%")])[0].byteLength).toBe(0);
  });

  test("base64url batches match the scalar (URL-safe, no padding)", () => {
    expect(rust.batch.base64UrlEncode([RAW_FBFF, bytes("")])[0]).toEqual(bytes("-_8"));
    expect(rust.batch.base64UrlDecode([bytes("-_8")])[0]).toEqual(RAW_FBFF);
    expect(rust.batch.base64UrlEncode([RAW_FBFF])[0]).toEqual(
      rust.base64UrlEncode(RAW_FBFF),
    );
  });

  test("wsAcceptKey + mime batches match the scalar", () => {
    expect(rust.batch.wsAcceptKey([bytes("dGhlIHNhbXBsZSBub25jZQ==")])[0]).toEqual(
      bytes("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
    );
    const mimes = rust.batch.mimeFromExtension([bytes(".js"), bytes("PNG"), bytes("nope")]);
    expect(mimes[0]).toEqual(bytes("text/javascript"));
    expect(mimes[1]).toEqual(bytes("image/png"));
    expect(mimes[2]).toEqual(bytes("application/octet-stream"));
  });
});

describe("rust.batch: backend-framework batches", () => {
  test("passwordVerify batch (zipped) matches the scalar", () => {
    const salt = bytes("0123456789abcdef");
    const phc = rust.passwordHash(bytes("hunter2"), salt, {
      mCost: 8,
      tCost: 1,
      pCost: 1,
      outLen: 16,
    });
    const bits = rust.batch.passwordVerify(
      [bytes("hunter2"), bytes("nope")],
      [phc, phc],
    );
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
    expect(rust.passwordVerify(bytes("hunter2"), phc)).toBe(true);
  });

  test("urlResolve batch (zipped) matches the scalar (RFC 3986)", () => {
    const base = bytes("http://a/b/c/d;p?q");
    const out = rust.batch.urlResolve([base, base], [bytes("g"), bytes("../g")]);
    expect(out[0]).toEqual(bytes("http://a/b/c/g"));
    expect(out[1]).toEqual(bytes("http://a/b/g"));
  });

  test("jwtSign batch signs JSON claim docs; jwtVerify validates them", () => {
    const tokens = rust.batch.jwtSign([bytes('{"sub":"1"}'), bytes('{"sub":"2"}')], SECRET, null, 1700000000);
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toEqual(
      rust.jwtSign({ sub: "1" } as Record<string, unknown>, SECRET, null, 1700000000),
    );
    const bits = rust.batch.jwtVerify(tokens, SECRET, 1700000000);
    expect([...bits]).toEqual([1, 1]);
  });

  test("sseEncode batch matches the scalar", () => {
    const out = rust.batch.sseEncode([bytes("hi"), bytes("yo")], "evt", "id1", 3000);
    expect(out[0]).toEqual(rust.sseEncodeEvent("evt", bytes("hi"), "id1", 3000));
    expect(out[1]).toEqual(rust.sseEncodeEvent("evt", bytes("yo"), "id1", 3000));
  });

  test("wsFrameEncode/Decode batches round-trip payloads", () => {
    const frames = rust.batch.wsFrameEncode([bytes("hello"), bytes("x")], 1, false, true);
    expect(frames.length).toBe(2);
    const payloads = rust.batch.wsFrameDecode(frames);
    expect(payloads[0]).toEqual(bytes("hello"));
    expect(payloads[1]).toEqual(bytes("x"));
  });

  test("multipartParse batch returns parts per item", () => {
    const boundary = bytes("----WebKitFormBoundary7MA4YWxkTrZu0gW");
    const delim = decoder.decode(boundary);
    const body = bytes(
      `--${delim}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${delim}--\r\n`,
    );
    const parts = rust.batch.multipartParse([body, body], boundary);
    expect(parts.length).toBe(2);
    for (const item of parts) {
      expect(item.length).toBe(1);
      expect(item[0].name).toBe("field");
      expect(item[0].filename).toBeNull();
      expect(item[0].data).toEqual(bytes("value"));
    }
    // Scalar agrees on the packed layout.
    const scalar = rust.multipartParse(body, boundary);
    expect(scalar[0].name).toBe("field");
  });
});
