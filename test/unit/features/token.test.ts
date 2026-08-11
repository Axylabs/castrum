/**
 * Tests for `rust.randomToken` — random hex token generator
 * (rust/crypto/random_token.rs).
 *
 * NOTE: the token is returned HEX-ENCODED (each random byte becomes two hex
 * characters), so the returned buffer is `byteLen * 2` bytes.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";

describe("randomToken", () => {
  test("returns byteLen random bytes as hex (2x length)", () => {
    for (const len of [1, 8, 16, 32, 64, 256]) {
      const tok = rust.randomToken(len);
      expect(tok).toBeInstanceOf(Uint8Array);
      expect(tok.byteLength).toBe(len * 2);
    }
  });

  test("token bytes are lowercase hex characters", () => {
    const tok = rust.randomToken(8);
    const isHex = (b: number) =>
      (b >= 48 && b <= 57) || (b >= 97 && b <= 102); // 0-9, a-f
    for (const b of tok) {
      expect(isHex(b)).toBe(true);
    }
  });

  test("tokens are distinct across calls", () => {
    const a = rust.randomToken(32);
    const b = rust.randomToken(32);
    // Extremely unlikely to collide (256 bits), and a collision would mean
    // the generator is not random.
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  test("zero length yields an empty token", () => {
    expect(rust.randomToken(0).byteLength).toBe(0);
  });

  test("huge lengths are rejected (allocation guard)", () => {
    // The native layer rejects byte_len > 16 MiB so a caller cannot trigger
    // a ~4 GiB single allocation.
    expect(() => rust.randomToken(16 * 1024 * 1024 + 1)).toThrow();
  });
});
