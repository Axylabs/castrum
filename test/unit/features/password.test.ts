/**
 * Tests for the Rust argon2id password hashing FFI.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";

const password = encoder.encode("correct horse battery staple");
const salt = encoder.encode("0123456789abcdef");
const options = { mCost: 4096, tCost: 2, pCost: 1 };

describe("rust.passwordHash", () => {
  test("hash then verify roundtrip", () => {
    const phc = rust.passwordHash(password, salt, options);
    expect(decoder.decode(phc)).toMatch(/^\$argon2id\$v=19\$/);
    expect(rust.passwordVerify(password, phc)).toBe(true);
  });

  test("rejects wrong password", () => {
    const phc = rust.passwordHash(password, salt, options);
    expect(rust.passwordVerify(encoder.encode("wrong"), phc)).toBe(false);
  });

  test("is deterministic given the same salt", () => {
    const a = rust.passwordHash(password, salt, options);
    const b = rust.passwordHash(password, salt, options);
    expect([...a]).toEqual([...b]);
  });

  test("rejects malformed phc", () => {
    expect(rust.passwordVerify(password, encoder.encode("garbage"))).toBe(false);
    expect(rust.passwordVerify(password, encoder.encode(""))).toBe(false);
  });
});

describe("rust.batch.passwordHash", () => {
  test("hashes many passwords in parallel", () => {
    const passwords = Array.from({ length: 8 }, (_, i) =>
      encoder.encode(`password-${i}`),
    );
    const phcs = rust.batch.passwordHash(passwords, salt, options);
    expect(phcs).toHaveLength(passwords.length);
    passwords.forEach((p, i) => {
      expect(rust.passwordVerify(p, phcs[i] as Uint8Array)).toBe(true);
    });
  });
});
