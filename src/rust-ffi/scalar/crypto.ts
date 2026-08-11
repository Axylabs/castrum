// src/rust-ffi/scalar/crypto.ts — Auth / crypto scalar methods.
//
// Mirrors rust/crypto/*: base64/hex codecs, signed cookies, CSRF, random
// tokens, JWT, password hashing and AEAD.

import type { RustClientContext } from "../context";
import type { PasswordHashOptions } from "../../native";

/** Auth / crypto scalar methods (`Pick<RustScalar, ...>`). */
export function buildCrypto(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    randomToken(byteLen: number): Uint8Array {
      return addon.randomToken(byteLen);
    },
    base64Encode(
      input: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): Uint8Array {
      return addon.base64Encode(input, urlSafe ?? undefined, padding ?? undefined);
    },
    base64EncodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      return addon.base64EncodeInto(
        input,
        output,
        urlSafe ?? undefined,
        padding ?? undefined,
      );
    },
    base64Decode(
      input: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): Uint8Array {
      return addon.base64Decode(input, urlSafe ?? undefined, padding ?? undefined);
    },
    base64DecodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      return addon.base64DecodeInto(
        input,
        output,
        urlSafe ?? undefined,
        padding ?? undefined,
      );
    },
    base64UrlEncode(input: Uint8Array): Uint8Array {
      return addon.base64UrlEncode(input);
    },
    base64UrlDecode(input: Uint8Array): Uint8Array {
      return addon.base64UrlDecode(input);
    },
    hexEncode(input: Uint8Array): Uint8Array {
      return addon.hexEncode(input);
    },
    hexEncodeInto(input: Uint8Array, output: Uint8Array): number {
      return addon.hexEncodeInto(input, output);
    },
    hexDecode(input: Uint8Array): Uint8Array {
      return addon.hexDecode(input);
    },
    hexDecodeInto(input: Uint8Array, output: Uint8Array): number {
      return addon.hexDecodeInto(input, output);
    },
    signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array {
      return addon.signCookie(value, secret);
    },
    verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null {
      return addon.verifyCookie(signed, secret);
    },
    csrfToken(secret: Uint8Array): Uint8Array {
      return addon.csrfToken(secret);
    },
    csrfVerify(token: Uint8Array, secret: Uint8Array): boolean {
      return addon.csrfVerify(token, secret);
    },
    jwtSign(
      claims: Record<string, unknown>,
      secret: Uint8Array,
      ttlSeconds?: number | null,
      nowSeconds?: number,
    ): Uint8Array {
      return addon.jwtSign(
        claims,
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      );
    },
    jwtVerify(
      token: Uint8Array,
      secret: Uint8Array,
      nowSeconds?: number,
    ): unknown {
      return addon.jwtVerify(
        token,
        secret,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      );
    },
    passwordHash(
      password: Uint8Array,
      salt: Uint8Array,
      options?: PasswordHashOptions | null,
    ): Uint8Array {
      return addon.passwordHash(password, salt, options ?? null);
    },
    passwordVerify(password: Uint8Array, phc: Uint8Array): boolean {
      return addon.passwordVerify(password, phc);
    },
    aeadEncrypt(
      key: Uint8Array,
      nonce: Uint8Array,
      plaintext: Uint8Array,
      algorithm?: string | null,
    ): Uint8Array {
      return addon.aeadEncrypt(key, nonce, plaintext, algorithm ?? null);
    },
    aeadDecrypt(
      key: Uint8Array,
      nonce: Uint8Array,
      ciphertext: Uint8Array,
      algorithm?: string | null,
    ): Uint8Array | null {
      return addon.aeadDecrypt(key, nonce, ciphertext, algorithm ?? null);
    },
  };
}
