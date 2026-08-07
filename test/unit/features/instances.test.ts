/**
 * Tests for the precompiled-key/params higher-order instances added in the
 * instance-time-precompute hardening pass: JwtSigner, AeadCipher,
 * Argon2Hasher, MediaTypeMatcher, and TemplateRenderer.renderBatchPacked.
 *
 * Each instance precompiles its key/params/expected ONCE at construction so the
 * per-call path skips derivation — behavior must match the scalar FFI exactly.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";

const SECRET = encoder.encode("super-secret-jwt-key");
const AEAD_KEY = encoder.encode("0123456789abcdef0123456789abcdef");
const AEAD_NONCE = encoder.encode("abcdefghijkl");
const SALT = encoder.encode("0123456789abcdef");

describe("JwtSigner (precompiled HS256 key)", () => {
  test("sign/verify roundtrip with ttl injection, parity with scalar", () => {
    const signer = rust.createJwtSigner(SECRET, 3600);
    const now = 1_000_000;
    const claims = { sub: "123", role: "admin" };

    const token = signer.sign(claims, now);
    const verified = signer.verify(token, now) as {
      sub: string;
      iat: number;
      exp: number;
    };
    expect(verified.sub).toBe("123");
    expect(verified.iat).toBe(now);
    expect(verified.exp).toBe(now + 3600);

    // Scalar parity (same key + ttl + now → same claims verification).
    const scalar = rust.jwtVerify(token, SECRET, now) as { sub: string };
    expect(scalar.sub).toBe("123");
  });

  test("wrong-key instance rejects", () => {
    const signer = rust.createJwtSigner(SECRET, 3600);
    const token = signer.sign({ sub: "1" }, 1_000_000);
    const other = rust.createJwtSigner(encoder.encode("other-secret"), 3600);
    expect(other.verify(token, 1_000_000)).toBeNull();
  });

  test("expired token rejected at verify time", () => {
    const signer = rust.createJwtSigner(SECRET, 10); // 10s ttl
    const token = signer.sign({ sub: "1" }, 1_000_000);
    expect(signer.verify(token, 1_000_005)).not.toBeNull();
    expect(signer.verify(token, 1_000_011)).toBeNull(); // past exp
  });
});

describe("AeadCipher (precompiled LessSafeKey)", () => {
  test("encrypt/decrypt roundtrip, parity with scalar", () => {
    const cipher = rust.createAeadCipher(AEAD_KEY);
    const pt = encoder.encode("session cookie payload");

    const ct = cipher.encrypt(AEAD_NONCE, pt);
    expect(ct.byteLength).toBe(pt.byteLength + 16);

    const dec = cipher.decrypt(AEAD_NONCE, ct);
    expect(dec).not.toBeNull();
    expect(Array.from(dec ?? new Uint8Array(0))).toEqual(Array.from(pt));

    // Scalar parity: same inputs → same ciphertext.
    const scalar = rust.aeadEncrypt(AEAD_KEY, AEAD_NONCE, pt);
    expect(Array.from(ct)).toEqual(Array.from(scalar));
  });

  test("wrong key fails to authenticate", () => {
    const cipher = rust.createAeadCipher(AEAD_KEY);
    const other = rust.createAeadCipher(encoder.encode("x".repeat(32)));
    const ct = cipher.encrypt(AEAD_NONCE, encoder.encode("secret"));
    expect(other.decrypt(AEAD_NONCE, ct)).toBeNull();
  });

  test("rejects bad nonce length and unsupported algorithm", () => {
    const cipher = rust.createAeadCipher(AEAD_KEY);
    expect(() =>
      cipher.encrypt(encoder.encode("short"), encoder.encode("x")),
    ).toThrow();
    expect(() => rust.createAeadCipher(AEAD_KEY, "aes-128-gcm")).toThrow();
  });
});

describe("Argon2Hasher (precompiled params)", () => {
  const hasher = rust.createArgon2Hasher({ mCost: 4096, tCost: 2, pCost: 1 });

  test("hash/verify roundtrip, parity with scalar", () => {
    const password = encoder.encode("correct horse battery staple");
    const phc = hasher.hash(password, SALT);

    // Scalar parity (same salt + params → identical PHC string).
    const scalar = rust.passwordHash(password, SALT, {
      mCost: 4096,
      tCost: 2,
      pCost: 1,
    });
    expect(Array.from(phc)).toEqual(Array.from(scalar));

    expect(hasher.verify(password, phc)).toBeTrue();
    expect(hasher.verify(encoder.encode("wrong"), phc)).toBeFalse();
  });
});

describe("MediaTypeMatcher (precompiled expected)", () => {
  test("matches against the precompiled expected type", () => {
    const json = rust.createMediaTypeMatcher(encoder.encode("Application/JSON"));
    expect(json.matches(encoder.encode("application/json; charset=utf-8"))).toBeTrue();
    expect(json.matches(encoder.encode("text/html"))).toBeFalse();

    const any = rust.createMediaTypeMatcher(encoder.encode("*/*"));
    expect(any.matches(encoder.encode("text/html"))).toBeTrue();

    const subtype = rust.createMediaTypeMatcher(encoder.encode("application/*"));
    expect(subtype.matches(encoder.encode("application/xml"))).toBeTrue();
    expect(subtype.matches(encoder.encode("text/xml"))).toBeFalse();

    // Malformed actual → false; malformed expected → construction throws.
    expect(json.matches(encoder.encode("no-slash"))).toBeFalse();
    expect(() => rust.createMediaTypeMatcher(encoder.encode("no-slash"))).toThrow();
  });
});

describe("TemplateRenderer.renderBatchPacked (compiled once)", () => {
  function packContexts(contexts: unknown[]): Uint8Array {
    const parts: Uint8Array[] = [];
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, contexts.length, true);
    parts.push(count);
    for (const c of contexts) {
      const bytes = encoder.encode(JSON.stringify(c));
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, bytes.byteLength, true);
      parts.push(len, bytes);
    }
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  function unpackRendered(packed: Uint8Array): string[] {
    const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    const count = dv.getUint32(0, true);
    const out: string[] = [];
    let pos = 4;
    for (let i = 0; i < count; i++) {
      const len = dv.getUint32(pos, true);
      pos += 4;
      out.push(decoder.decode(packed.subarray(pos, pos + len)));
      pos += len;
    }
    return out;
  }

  test("batch reuses the compiled template and matches scalar render", () => {
    const renderer = rust.createTemplateRenderer("Hello {{ name }}!");
    expect(
      decoder.decode(renderer.render({ name: "World" })),
    ).toBe("Hello World!");

    const packed = packContexts([{ name: "Alice" }, { name: "Bob" }]);
    const out = renderer.renderBatchPacked(packed);
    expect(unpackRendered(out)).toEqual(["Hello Alice!", "Hello Bob!"]);
  });
});
