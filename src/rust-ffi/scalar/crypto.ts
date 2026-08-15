// src/rust-ffi/scalar/crypto.ts — Auth / crypto scalar methods.
//
// Mirrors rust/crypto/*: base64/hex codecs, signed cookies, CSRF, random
// tokens, JWT, password hashing and AEAD.

import type { PasswordHashOptions } from '../../native'
import { getBunFFI } from '../../native/ffi'
import { encoder } from '../../shared/bytes'
import { isBun } from '../../shared/runtime'
import type { RustClientContext } from '../context'

/** Auth / crypto scalar methods (`Pick<RustScalar, ...>`). */
export function buildCrypto(ctx: RustClientContext) {
  const { addon } = ctx

  return {
    randomToken(byteLen: number): Uint8Array | string {
      // Optimal by default under Bun: `crypto.getRandomValues` + native hex
      // beats the rust+FFI crossing for token-sized draws (decision matrix).
      // Preserves the native 16 MiB allocation guard and the hex format
      // (2n chars). Node keeps the addon. Bun returns the hex STRING (native
      // transfer — no TextEncoder round-trip).
      if (isBun()) {
        if (byteLen > 16 * 1024 * 1024) {
          throw new RangeError('randomToken: byteLen exceeds 16 MiB limit')
        }
        return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLen))).toString('hex')
      }
      const ffi = getBunFFI()
      if (ffi) return ffi.randomToken(byteLen)
      return addon.randomToken(byteLen)
    },
    randomTokenInto(byteLen: number, output: Uint8Array): number {
      // Pooled sibling — writes `byteLen*2` hex chars into `output` and returns
      // bytes written. FFI path uses the native `_into` (no cstring round-trip);
      // under Bun without ffi we write the built-in's hex directly into the
      // caller buffer; the addon path copies.
      const ffi = getBunFFI()
      if (ffi) return ffi.randomTokenInto(byteLen, output)
      if (isBun()) {
        if (byteLen > 16 * 1024 * 1024) {
          throw new RangeError('randomTokenInto: byteLen exceeds 16 MiB limit')
        }
        const need = byteLen * 2
        if (output.length < need) throw new Error('random token: output buffer too small')
        const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(byteLen))).toString('hex')
        output.set(encoder.encode(hex))
        return need
      }
      const bytes = addon.randomToken(byteLen)
      if (output.length < bytes.length) throw new Error('random token: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array | string {
      // Bun's Buffer base64 (SIMD) beats the rust+FFI crossing (~2x, measured)
      // for the standard (url-safe=false, padded) case; parity pinned by
      // test/unit/features/encoding.test.ts. url-safe/unpadded falls through to
      // the native path. Bun returns the base64 STRING (native transfer).
      if (isBun() && !urlSafe && padding !== false) {
        return Buffer.from(input).toString('base64')
      }
      const ffi = getBunFFI()
      if (ffi) return ffi.base64Encode(input, urlSafe, padding)
      return addon.base64Encode(input, urlSafe ?? undefined, padding ?? undefined)
    },
    base64EncodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.base64EncodeInto(input, output, urlSafe, padding)
      return addon.base64EncodeInto(input, output, urlSafe ?? undefined, padding ?? undefined)
    },
    base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.base64Decode(input, urlSafe, padding)
      return addon.base64Decode(input, urlSafe ?? undefined, padding ?? undefined)
    },
    base64DecodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.base64DecodeInto(input, output, urlSafe, padding)
      return addon.base64DecodeInto(input, output, urlSafe ?? undefined, padding ?? undefined)
    },
    base64UrlEncode(input: Uint8Array): Uint8Array | string {
      // Bun's native `Buffer.toString('base64url')` (SIMD) beats the rust+FFI
      // crossing — same delegation rationale as `base64Encode` (which uses
      // `toString('base64')`); verified byte-parity with the Rust
      // `URL_SAFE_NO_PAD` engine (test/unit/features/encoding.test.ts). Bun
      // returns the base64url STRING (native transfer). Node keeps the addon.
      if (isBun()) return Buffer.from(input).toString('base64url')
      const ffi = getBunFFI()
      if (ffi) return ffi.base64Encode(input, true, false)
      return addon.base64UrlEncode(input)
    },
    base64UrlDecode(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.base64Decode(input, true, false)
      return addon.base64UrlDecode(input)
    },
    hexEncode(input: Uint8Array): Uint8Array | string {
      // Bun's native `Buffer.toString('hex')` (SIMD) beats the rust+FFI
      // crossing, especially for large inputs (the ffi path builds a 2×-size JS
      // string via cstring clone; the native codec avoids that). Verified
      // byte-parity with the Rust hex encoder. Bun returns the hex STRING
      // (native transfer). Node keeps the addon bytes.
      if (isBun()) return Buffer.from(input).toString('hex')
      const ffi = getBunFFI()
      if (ffi) return ffi.hexEncode(input)
      return addon.hexEncode(input)
    },
    hexEncodeInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.hexEncodeInto(input, output)
      return addon.hexEncodeInto(input, output)
    },
    hexDecode(input: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.hexDecode(input)
      return addon.hexDecode(input)
    },
    hexDecodeInto(input: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.hexDecodeInto(input, output)
      return addon.hexDecodeInto(input, output)
    },
    signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) return ffi.signCookie(value, secret)
      return addon.signCookie(value, secret)
    },
    signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.signCookieInto(value, secret, output)
      const bytes = addon.signCookie(value, secret)
      if (output.length < bytes.length) throw new Error('sign cookie: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | string | null {
      const ffi = getBunFFI()
      if (ffi) return ffi.verifyCookie(signed, secret)
      return addon.verifyCookie(signed, secret)
    },
    verifyCookieInto(signed: Uint8Array, secret: Uint8Array, output: Uint8Array): number | null {
      const ffi = getBunFFI()
      if (ffi) return ffi.verifyCookieInto(signed, secret, output)
      const value = addon.verifyCookie(signed, secret)
      if (value === null) return null
      if (output.length < value.length) throw new Error('verify cookie: output buffer too small')
      output.set(value)
      return value.length
    },
    csrfToken(secret: Uint8Array): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) return ffi.csrfToken(secret)
      return addon.csrfToken(secret)
    },
    csrfTokenInto(secret: Uint8Array, output: Uint8Array): number {
      const ffi = getBunFFI()
      if (ffi) return ffi.csrfTokenInto(secret, output)
      const bytes = addon.csrfToken(secret)
      if (output.length < bytes.length) throw new Error('csrf token: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    csrfVerify(token: Uint8Array, secret: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.csrfVerify(token, secret)
      return addon.csrfVerify(token, secret)
    },
    jwtSign(
      claims: Record<string, unknown>,
      secret: Uint8Array,
      ttlSeconds?: number | null,
      nowSeconds?: number,
    ): Uint8Array {
      // FFI-first: route the object claims through the C-ABI `jwtSignBytes`
      // (pre-serialized JSON). The engine returns the token as a string
      // (native transfer); re-encode to bytes to keep the public BYTE contract
      // (batch/benchmark consumers compare bytes). NOTE: JSON.stringify
      // preserves JS insertion order while napi's serde_json sorts keys — for
      // multi-key claims the two transports emit different-but-equally-valid
      // tokens (both verify; parity tests cross-verify semantically).
      const ffi = getBunFFI()
      if (ffi) {
        const token = ffi.jwtSignBytes(
          encoder.encode(JSON.stringify(claims)),
          secret,
          ttlSeconds ?? 0,
          nowSeconds ?? Math.floor(Date.now() / 1000),
        )
        return encoder.encode(token)
      }
      return addon.jwtSign(
        claims,
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      )
    },
    jwtSignBytes(
      claimsJson: Uint8Array,
      secret: Uint8Array,
      ttlSeconds?: number | null,
      nowSeconds?: number,
    ): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) {
        // The C-ABI `ttl <= 0` sentinel matches napi's Option<i64> (inject only
        // when positive), and nowSeconds defaults identically.
        return ffi.jwtSignBytes(
          claimsJson,
          secret,
          ttlSeconds ?? 0,
          nowSeconds ?? Math.floor(Date.now() / 1000),
        )
      }
      return addon.jwtSignBytes(
        claimsJson,
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      )
    },
    jwtSignBytesInto(
      claimsJson: Uint8Array,
      secret: Uint8Array,
      output: Uint8Array,
      ttlSeconds?: number | null,
      nowSeconds?: number,
    ): number {
      const ffi = getBunFFI()
      if (ffi) {
        return ffi.jwtSignBytesInto(
          claimsJson,
          secret,
          ttlSeconds ?? 0,
          nowSeconds ?? Math.floor(Date.now() / 1000),
          output,
        )
      }
      const bytes = addon.jwtSignBytes(
        claimsJson,
        secret,
        ttlSeconds ?? null,
        nowSeconds ?? Math.floor(Date.now() / 1000),
      )
      if (output.length < bytes.length) throw new Error('jwt sign: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds?: number): unknown {
      const ffi = getBunFFI()
      if (ffi) {
        // Verify via the FFI cstring path (castrum_jwt_verify): the engine
        // clones the claims JSON string at return (zero decode), and `null` =
        // invalid signature / expired / malformed → null (napi Option parity).
        const claims = ffi.jwtVerify(token, secret, nowSeconds ?? Math.floor(Date.now() / 1000))
        return claims === null ? null : (JSON.parse(claims) as unknown)
      }
      return addon.jwtVerify(token, secret, nowSeconds ?? Math.floor(Date.now() / 1000))
    },
    passwordHash(
      password: Uint8Array,
      salt: Uint8Array,
      options?: PasswordHashOptions | null,
    ): Uint8Array | string {
      const ffi = getBunFFI()
      if (ffi) {
        // Resolve the napi defaults (rust/crypto/argon2.rs resolve_opts).
        const o = options ?? {}
        return ffi.passwordHash(
          password,
          salt,
          o.mCost ?? 19456,
          o.tCost ?? 2,
          o.pCost ?? 1,
          o.outLen ?? 32,
        )
      }
      return addon.passwordHash(password, salt, options ?? null)
    },
    passwordVerify(password: Uint8Array, phc: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.passwordVerify(password, phc)
      return addon.passwordVerify(password, phc)
    },
    passwordHashBcrypt(password: Uint8Array, cost: number): string {
      const ffi = getBunFFI()
      if (ffi) return ffi.passwordHashBcrypt(password, cost)
      return addon.passwordHashBcrypt(password, cost)
    },
    passwordVerifyBcrypt(password: Uint8Array, hash: string): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.passwordVerifyBcrypt(password, encoder.encode(hash))
      return addon.passwordVerifyBcrypt(password, hash)
    },
    pbkdf2Sha256(
      password: Uint8Array,
      salt: Uint8Array,
      rounds: number,
      dkLen: number,
    ): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) return ffi.pbkdf2Sha256(password, salt, rounds, dkLen)
      return addon.pbkdf2Sha256(password, salt, rounds, dkLen)
    },
    aeadEncrypt(
      key: Uint8Array,
      nonce: Uint8Array,
      plaintext: Uint8Array,
      algorithm?: string | null,
    ): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        return ffi.aeadEncrypt(key, nonce, plaintext, algorithm === 'chacha20-poly1305' ? 1 : 0)
      }
      return addon.aeadEncrypt(key, nonce, plaintext, algorithm ?? null)
    },
    aeadEncryptInto(
      key: Uint8Array,
      nonce: Uint8Array,
      plaintext: Uint8Array,
      output: Uint8Array,
      algorithm?: string | null,
    ): number {
      const ffi = getBunFFI()
      if (ffi) {
        return ffi.aeadEncryptInto(
          key,
          nonce,
          plaintext,
          output,
          algorithm === 'chacha20-poly1305' ? 1 : 0,
        )
      }
      const bytes = addon.aeadEncrypt(key, nonce, plaintext, algorithm ?? null)
      if (output.length < bytes.length) throw new Error('aead encrypt: output buffer too small')
      output.set(bytes)
      return bytes.length
    },
    aeadDecrypt(
      key: Uint8Array,
      nonce: Uint8Array,
      ciphertext: Uint8Array,
      algorithm?: string | null,
    ): Uint8Array | null {
      const ffi = getBunFFI()
      if (ffi) {
        return ffi.aeadDecrypt(key, nonce, ciphertext, algorithm === 'chacha20-poly1305' ? 1 : 0)
      }
      return addon.aeadDecrypt(key, nonce, ciphertext, algorithm ?? null)
    },
  }
}
