// src/rust-ffi/scalar/factories.ts — Compiled-once instance factories + rayon runtime.
//
// Every `create*` here constructs a compiled-once native instance (key / schema
// / template precompiled at construction) plus the rayon thread-pool controls.

import { asNumber } from '../options'
import { getBunFFI, type BunFFI } from '../../native/ffi'
import type { RustClientContext } from '../context'
import type {
  HmacSignerInstance,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  FormParserInstance,
  MediaTypeParserInstance,
  MediaTypeMatcherInstance,
  ConditionalRequestInstance,
  AcceptNegotiatorInstance,
  Base64CodecInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  UrlBuilderInstance,
  JwtSignerInstance,
  AeadCipherInstance,
  Argon2HasherInstance,
  RateLimiterInstance,
  PasswordHashOptions,
} from '../../native'

// ── FFI-backed instance wrappers ───────────────────────────────────────────
// On Bun, instances whose methods have a STATELESS C-ABI sibling are backed by
// the `bun:ffi` fast path instead of a NAPI instance — cutting the per-call
// NAPI crossing (~300ns) to ~20ns. The precompiled-state benefit is mostly
// lost (e.g. the HMAC key is rebuilt per call, ~100ns), but that is still far
// cheaper than a NAPI crossing, so these win under Bun. Byte-for-byte output is
// guaranteed by the ffi cross-check suite. NAPI instances remain the fallback
// (Node / CASTRUM_FFI_MODE=napi / failed self-test). Instances with genuinely
// stateful precompiled cores (SchemaValidator, TemplateRenderer,
// AcceptNegotiator, ConditionalRequest, MediaTypeMatcher/Parser, UrlBuilder,
// RateLimiter) stay NAPI — they need opaque handles (deferred).

function ffiHmacSigner(key: Uint8Array, ffi: BunFFI): HmacSignerInstance {
  return {
    sign(data) {
      return ffi.hmacSha256(key, data)
    },
    verify(data, sig) {
      return ffi.hmacSha256Verify(key, data, sig)
    },
  }
}

function ffiBase64Codec(
  urlSafe: boolean | undefined,
  padding: boolean | undefined,
  ffi: BunFFI,
): Base64CodecInstance {
  return {
    encode(input) {
      return ffi.base64Encode(input, urlSafe, padding)
    },
    decode(input) {
      return ffi.base64Decode(input, urlSafe, padding)
    },
  }
}

function ffiCookieSigner(secret: Uint8Array, ffi: BunFFI): CookieSignerInstance {
  return {
    sign(value) {
      return ffi.signCookie(value, secret)
    },
    verify(signed) {
      return ffi.verifyCookie(signed, secret)
    },
  }
}

function ffiCsrfProtector(secret: Uint8Array, ffi: BunFFI): CsrfProtectorInstance {
  return {
    create() {
      return ffi.csrfToken(secret)
    },
    verify(token) {
      return ffi.csrfVerify(token, secret)
    },
  }
}

function ffiArgon2Hasher(
  options: PasswordHashOptions | null | undefined,
  ffi: BunFFI,
): Argon2HasherInstance {
  // Resolve the napi defaults (rust/crypto/argon2.rs resolve_opts) — mirrors
  // the scalar passwordHash FFI wrapper (crypto.ts).
  const o = options ?? {}
  const mCost = o.mCost ?? 19456
  const tCost = o.tCost ?? 2
  const pCost = o.pCost ?? 1
  const outLen = o.outLen ?? 32
  return {
    hash(password, salt) {
      return ffi.passwordHash(password, salt, mCost, tCost, pCost, outLen)
    },
    verify(password, phc) {
      return ffi.passwordVerify(password, phc)
    },
  }
}

function ffiAeadCipher(
  key: Uint8Array,
  algorithm: string | undefined,
  ffi: BunFFI,
): AeadCipherInstance {
  // Mirror the napi constructor's validation (rust/crypto/aead.rs
  // `resolve_algorithm`): only aes-256-gcm (default) and chacha20-poly1305 are
  // accepted; anything else throws at construction, NOT at first use.
  if (algorithm !== undefined && algorithm !== 'aes-256-gcm' && algorithm !== 'chacha20-poly1305') {
    throw new Error(
      `unsupported aead algorithm: ${algorithm} (expected aes-256-gcm | chacha20-poly1305)`,
    )
  }
  const alg = algorithm === 'chacha20-poly1305' ? 1 : 0
  return {
    encrypt(nonce, plaintext) {
      return ffi.aeadEncrypt(key, nonce, plaintext, alg)
    },
    decrypt(nonce, ciphertext) {
      return ffi.aeadDecrypt(key, nonce, ciphertext, alg)
    },
  }
}

function ffiFormParser(ffi: BunFFI): FormParserInstance {
  return {
    parse(input) {
      // Sizing matches the scalar formParsePacked path (Rust allocator bound
      // `input.len() * 9 + 16`).
      const out = new Uint8Array(input.length * 9 + 16)
      const w = ffi.formParsePackedInto(input, out)
      return out.subarray(0, w)
    },
    parseInto(input, output) {
      return ffi.formParsePackedInto(input, output)
    },
  }
}

/** Compiled-once factory + runtime-control methods (`Pick<RustScalar, ...>`). */
export function buildFactories(ctx: RustClientContext) {
  const { addon } = ctx

  return {
    createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance {
      return new addon.SchemaValidator(schema)
    },
    createHmacSigner(key: Uint8Array): HmacSignerInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiHmacSigner(key, ffi)
      return new addon.HmacSigner(key)
    },
    createTemplateRenderer(source: string): TemplateRendererInstance {
      return new addon.TemplateRenderer(source)
    },
    createFormParser(capacity?: number): FormParserInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiFormParser(ffi)
      return new addon.FormParser(capacity)
    },
    createMediaTypeParser(): MediaTypeParserInstance {
      return new addon.MediaTypeParser()
    },
    createConditionalRequest(
      etagValue: Uint8Array,
      lastModifiedSecs?: number,
    ): ConditionalRequestInstance {
      return new addon.ConditionalRequest(etagValue, lastModifiedSecs ?? undefined)
    },
    createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance {
      return new addon.AcceptNegotiator(supported)
    },
    createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiBase64Codec(urlSafe, padding, ffi)
      return new addon.Base64Codec(urlSafe ?? undefined, padding ?? undefined)
    },
    createCookieSigner(secret: Uint8Array): CookieSignerInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiCookieSigner(secret, ffi)
      return new addon.CookieSigner(secret)
    },
    createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiCsrfProtector(secret, ffi)
      return new addon.CsrfProtector(secret)
    },
    createUrlBuilder(base: Uint8Array): UrlBuilderInstance {
      return new addon.UrlBuilder(base)
    },
    createJwtSigner(secret: Uint8Array, ttlSeconds?: number): JwtSignerInstance {
      return new addon.JwtSigner(secret, ttlSeconds ?? undefined)
    },
    createAeadCipher(key: Uint8Array, algorithm?: string): AeadCipherInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiAeadCipher(key, algorithm, ffi)
      return new addon.AeadCipher(key, algorithm ?? undefined)
    },
    createArgon2Hasher(options?: PasswordHashOptions | null): Argon2HasherInstance {
      const ffi = getBunFFI()
      if (ffi) return ffiArgon2Hasher(options, ffi)
      return new addon.Argon2Hasher(options ?? undefined)
    },
    createMediaTypeMatcher(expected: Uint8Array): MediaTypeMatcherInstance {
      return new addon.MediaTypeMatcher(expected)
    },
    createRateLimiter(
      limit: number,
      windowMs: number,
      maxEntries?: number | null,
    ): RateLimiterInstance {
      return new addon.RateLimiter(limit, windowMs, maxEntries ?? undefined)
    },
    initThreadPool(threads?: number): void {
      // Explicit user call also establishes the pool state locally.
      ctx.markPoolInitialized()
      if (threads !== undefined) ctx.setPendingThreads(threads)
      addon.initThreadPool(threads)
    },
    rayonNumThreads(): number {
      return asNumber(addon.rayonNumThreads() as unknown)
    },
  }
}
