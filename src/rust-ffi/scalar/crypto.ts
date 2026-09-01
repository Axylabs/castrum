// src/rust-ffi/scalar/crypto.ts — Auth / crypto scalar methods.
//
// Mirrors rust/crypto/*: base64/hex codecs, signed cookies, CSRF, random
// tokens, JWT, password hashing and AEAD.
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): Bun built-in
// delegations (randomToken/base64*/hexEncode) come from `builtins.has(op)` and
// the native call from `transport.resolve(op)` / `transport.ffi` (bun:ffi
// first, napi fallback) — no inline `isBun()` / `getBunFFI()`.

import type { PasswordHashOptions } from '../../native'
import { encoder } from '../../shared/bytes'
import { memoizeFfi, type RustClientContext, resolveNative } from '../context'
import { writeInto } from '../into'

/** Auth / crypto scalar methods (`Pick<RustScalar, ...>`). */
export function buildCrypto(ctx: RustClientContext) {
  const { addon } = ctx
  const { builtins, transport } = ctx.runtime
  // Hoist the immutable per-runtime builtin-delegation decisions into a
  // bind-time map (BUILTIN_OPS is a module constant — never mutated after
  // load) so the hot path reads object properties instead of `Set.has`.
  const HAS = {
    randomToken: builtins.has('randomToken'),
    base64Encode: builtins.has('base64Encode'),
    base64UrlEncode: builtins.has('base64UrlEncode'),
    hexEncode: builtins.has('hexEncode'),
  }
  // Lazy-memoized ffi surface: binds on first call, single local read after.
  const ffi = memoizeFfi(transport)

  return {
    randomToken(byteLen: number): Uint8Array | string {
      // Optimal by default under Bun: `crypto.getRandomValues` + native hex
      // beats the rust+FFI crossing for token-sized draws (decision matrix);
      // the builtin carries the 16 MiB guard and returns the hex STRING. Node
      // keeps the addon.
      if (HAS.randomToken) return builtins.randomToken(byteLen)
      return resolveNative(ctx, 'randomToken')(byteLen) as Uint8Array | string
    },
    randomTokenInto(byteLen: number, output: Uint8Array): number {
      // Pooled sibling — writes `byteLen*2` hex chars into `output`. FFI path
      // uses the native `_into` (no cstring round-trip); without ffi the Bun
      // builtin (or addon) hex is written into the caller buffer.
      const f = ffi()
      if (f) return f.randomTokenInto(byteLen, output)
      if (HAS.randomToken) {
        const need = byteLen * 2
        if (output.length < need) throw new Error('random token: output buffer too small')
        output.set(encoder.encode(builtins.randomToken(byteLen) as string))
        return need
      }
      const bytes = addon.randomToken(byteLen)
      return writeInto('random token', output, bytes)
    },
    base64Encode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array | string {
      // Bun's Buffer base64 (SIMD) beats the rust+FFI crossing (~2x, measured)
      // for the standard (url-safe=false, padded) case; the builtin returns
      // `undefined` for url-safe/unpadded so those fall through to native.
      // Parity pinned by test/unit/features/encoding.test.ts.
      if (HAS.base64Encode) {
        const encoded = builtins.base64Encode(input, urlSafe, padding)
        if (encoded !== undefined) return encoded
      }
      return resolveNative(ctx, 'base64Encode')(
        input,
        urlSafe ?? undefined,
        padding ?? undefined,
      ) as Uint8Array | string
    },
    base64EncodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      return resolveNative(ctx, 'base64EncodeInto')(
        input,
        output,
        urlSafe ?? undefined,
        padding ?? undefined,
      ) as number
    },
    base64Decode(input: Uint8Array, urlSafe?: boolean, padding?: boolean): Uint8Array {
      return resolveNative(ctx, 'base64Decode')(
        input,
        urlSafe ?? undefined,
        padding ?? undefined,
      ) as Uint8Array
    },
    base64DecodeInto(
      input: Uint8Array,
      output: Uint8Array,
      urlSafe?: boolean,
      padding?: boolean,
    ): number {
      return resolveNative(ctx, 'base64DecodeInto')(
        input,
        output,
        urlSafe ?? undefined,
        padding ?? undefined,
      ) as number
    },
    base64UrlEncode(input: Uint8Array): Uint8Array | string {
      // Bun's native `Buffer.toString('base64url')` (SIMD) beats the rust+FFI
      // crossing — same delegation rationale as `base64Encode`; verified
      // byte-parity with the Rust `URL_SAFE_NO_PAD` engine
      // (test/unit/features/encoding.test.ts). The ffi path reuses
      // `base64Encode(input, true, false)` (no dedicated base64UrlEncode symbol).
      if (HAS.base64UrlEncode) return builtins.base64UrlEncode(input)
      const f = ffi()
      if (f) return f.base64Encode(input, true, false)
      return addon.base64UrlEncode(input)
    },
    base64UrlDecode(input: Uint8Array): Uint8Array {
      const f = ffi()
      if (f) return f.base64Decode(input, true, false)
      return addon.base64UrlDecode(input)
    },
    hexEncode(input: Uint8Array): Uint8Array | string {
      // Bun's native `Buffer.toString('hex')` (SIMD) beats the rust+FFI
      // crossing, especially for large inputs. Verified byte-parity with the
      // Rust hex encoder. Bun returns the hex STRING; Node keeps the addon bytes.
      if (HAS.hexEncode) return builtins.hexEncode(input)
      return resolveNative(ctx, 'hexEncode')(input) as Uint8Array | string
    },
    hexEncodeInto(input: Uint8Array, output: Uint8Array): number {
      return resolveNative(ctx, 'hexEncodeInto')(input, output) as number
    },
    hexDecode(input: Uint8Array): Uint8Array {
      return resolveNative(ctx, 'hexDecode')(input) as Uint8Array
    },
    hexDecodeInto(input: Uint8Array, output: Uint8Array): number {
      return resolveNative(ctx, 'hexDecodeInto')(input, output) as number
    },
    signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array | string {
      return resolveNative(ctx, 'signCookie')(value, secret) as Uint8Array | string
    },
    signCookieInto(value: Uint8Array, secret: Uint8Array, output: Uint8Array): number {
      const f = ffi()
      if (f) return f.signCookieInto(value, secret, output)
      return writeInto('sign cookie', output, addon.signCookie(value, secret))
    },
    verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | string | null {
      return resolveNative(ctx, 'verifyCookie')(signed, secret) as Uint8Array | string | null
    },
    verifyCookieInto(signed: Uint8Array, secret: Uint8Array, output: Uint8Array): number | null {
      const f = ffi()
      if (f) return f.verifyCookieInto(signed, secret, output)
      const value = addon.verifyCookie(signed, secret)
      if (value === null) return null
      return writeInto('verify cookie', output, value)
    },
    csrfToken(secret: Uint8Array): Uint8Array | string {
      return resolveNative(ctx, 'csrfToken')(secret) as Uint8Array | string
    },
    csrfTokenInto(secret: Uint8Array, output: Uint8Array): number {
      const f = ffi()
      if (f) return f.csrfTokenInto(secret, output)
      return writeInto('csrf token', output, addon.csrfToken(secret))
    },
    csrfVerify(token: Uint8Array, secret: Uint8Array): boolean {
      return resolveNative(ctx, 'csrfVerify')(token, secret) as boolean
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
      const f = ffi()
      if (f) {
        const token = f.jwtSignBytes(
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
      const f = ffi()
      if (f) {
        // The C-ABI `ttl <= 0` sentinel matches napi's Option<i64> (inject only
        // when positive), and nowSeconds defaults identically.
        return f.jwtSignBytes(
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
      const f = ffi()
      if (f) {
        return f.jwtSignBytesInto(
          claimsJson,
          secret,
          ttlSeconds ?? 0,
          nowSeconds ?? Math.floor(Date.now() / 1000),
          output,
        )
      }
      return writeInto(
        'jwt sign',
        output,
        addon.jwtSignBytes(
          claimsJson,
          secret,
          ttlSeconds ?? null,
          nowSeconds ?? Math.floor(Date.now() / 1000),
        ),
      )
    },
    jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds?: number): unknown {
      const f = ffi()
      if (f) {
        // Verify via the FFI cstring path (castrum_jwt_verify): the engine
        // clones the claims JSON string at return (zero decode), and `null` =
        // invalid signature / expired / malformed → null (napi Option parity).
        const claims = f.jwtVerify(token, secret, nowSeconds ?? Math.floor(Date.now() / 1000))
        return claims === null ? null : (JSON.parse(claims) as unknown)
      }
      return addon.jwtVerify(token, secret, nowSeconds ?? Math.floor(Date.now() / 1000))
    },
    passwordHash(
      password: Uint8Array,
      salt: Uint8Array,
      options?: PasswordHashOptions | null,
    ): Uint8Array | string {
      const f = ffi()
      if (f) {
        // Resolve the napi defaults (rust/crypto/argon2.rs resolve_opts).
        const o = options ?? {}
        return f.passwordHash(
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
      return resolveNative(ctx, 'passwordVerify')(password, phc) as boolean
    },
    passwordHashBcrypt(password: Uint8Array, cost: number): string {
      return resolveNative(ctx, 'passwordHashBcrypt')(password, cost) as string
    },
    passwordVerifyBcrypt(password: Uint8Array, hash: string): boolean {
      // FFI-first: `hash` is a `cstring` ARG (the engine transcodes the PHC
      // string in-engine — no JS encode); `password` stays `(ptr,len)` bytes.
      const f = ffi()
      if (f) return f.passwordVerifyBcrypt(password, hash)
      return addon.passwordVerifyBcrypt(password, hash)
    },
    pbkdf2Sha256(
      password: Uint8Array,
      salt: Uint8Array,
      rounds: number,
      dkLen: number,
    ): Uint8Array {
      return resolveNative(ctx, 'pbkdf2Sha256')(password, salt, rounds, dkLen) as Uint8Array
    },
    aeadEncrypt(
      key: Uint8Array,
      nonce: Uint8Array,
      plaintext: Uint8Array,
      algorithm?: string | null,
    ): Uint8Array {
      const f = ffi()
      if (f) {
        return f.aeadEncrypt(key, nonce, plaintext, algorithm === 'chacha20-poly1305' ? 1 : 0)
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
      const f = ffi()
      if (f) {
        return f.aeadEncryptInto(
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
      const f = ffi()
      if (f) {
        return f.aeadDecrypt(key, nonce, ciphertext, algorithm === 'chacha20-poly1305' ? 1 : 0)
      }
      return addon.aeadDecrypt(key, nonce, ciphertext, algorithm ?? null)
    },
  }
}
