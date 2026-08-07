/**
 * Tests for the Rust JWT (HS256) FFI (`rust.jwtSign` / `rust.jwtVerify`),
 * cross-checked against the node:crypto baseline.
 */

import { describe, test, expect } from "bun:test";
import { nativeJwtSign, nativeJwtVerify } from "../../../src/baseline/tasks/jwt";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";

const secret = encoder.encode("unit-test-jwt-secret");
const now = 1_750_000_000;

describe("rust.jwtSign", () => {
  test("produces a three-segment token", () => {
    const token = rust.jwtSign({ sub: "1" }, secret, 3600, now);
    const parts = decoder.decode(token).split(".");
    expect(parts).toHaveLength(3);
  });

  test("injects iat/exp when ttl is positive", () => {
    const token = rust.jwtSign({ sub: "1" }, secret, 3600, now);
    const claims = rust.jwtVerify(token, secret, now) as Record<string, unknown>;
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + 3600);
  });

  test("keeps existing iat/exp", () => {
    const token = rust.jwtSign({ sub: "1", exp: now + 100_000 }, secret, 3600, now);
    const claims = rust.jwtVerify(token, secret, now) as Record<string, unknown>;
    expect(claims.exp).toBe(now + 100_000);
  });

  test("matches baseline signing behavior", () => {
    const claims = { sub: "1", name: "Alice" };
    const rustToken = rust.jwtSign(claims, secret, 3600, now);
    expect(nativeJwtVerify(rustToken, secret, now)).toBe(true);
    const nativeToken = nativeJwtSign(claims, secret, 3600, now);
    expect(rust.jwtVerify(nativeToken, secret, now) !== null).toBe(true);
  });
});

describe("rust.jwtVerify", () => {
  test("returns null for a tampered token", () => {
    const token = rust.jwtSign({ sub: "1" }, secret, 3600, now).slice();
    token[token.length - 1] ^= 0x01;
    expect(rust.jwtVerify(token, secret, now)).toBeNull();
  });

  test("returns null for wrong secret", () => {
    const token = rust.jwtSign({ sub: "1" }, secret, 3600, now);
    expect(rust.jwtVerify(token, encoder.encode("wrong"), now)).toBeNull();
  });

  test("returns null for malformed tokens", () => {
    expect(rust.jwtVerify(encoder.encode("not-a-jwt"), secret, now)).toBeNull();
    expect(rust.jwtVerify(encoder.encode("a.b"), secret, now)).toBeNull();
    expect(rust.jwtVerify(encoder.encode("a.b.c.d"), secret, now)).toBeNull();
  });

  test("rejects expired tokens", () => {
    const token = rust.jwtSign({ sub: "1" }, secret, 3600, now);
    expect(rust.jwtVerify(token, secret, now + 3601)).toBeNull();
    expect(rust.jwtVerify(token, secret, now + 3600)).toBeNull();
    expect(rust.jwtVerify(token, secret, now + 3599)).not.toBeNull();
  });
});

describe("rust.batch.jwtVerify", () => {
  test("returns a per-token validity bitset", () => {
    const tokens = Array.from({ length: 10 }, (_, i) =>
      nativeJwtSign({ sub: String(i) }, secret, 3600, now),
    );
    // Tamper one token.
    tokens[3][5] = (tokens[3][5] ?? 0) ^ 0x01;
    const bits = rust.batch.jwtVerify(tokens, secret, now);
    expect(bits.length).toBe(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      expect(bits[i]).toBe(i === 3 ? 0 : 1);
    }
  });
});
