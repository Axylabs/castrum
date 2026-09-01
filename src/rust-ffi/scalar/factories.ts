// src/rust-ffi/scalar/factories.ts — Compiled-once instance factories + rayon runtime.
//
// Every `create*` here constructs a compiled-once native instance (key / schema
// / template precompiled at construction) plus the rayon thread-pool controls.

import type {
  AcceptNegotiatorInstance,
  AeadCipherInstance,
  Argon2HasherInstance,
  Base64CodecInstance,
  ConditionalRequestInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  FormParserInstance,
  HmacSignerInstance,
  JwtSignerInstance,
  MediaTypeMatcherInstance,
  MediaTypeParserInstance,
  MetricsRegistryInstance,
  PasswordHashOptions,
  RateLimiterInstance,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  UrlBuilderInstance,
} from '../../native'
import type { BunFFI } from '../../native/ffi'
import { encoder } from '../../shared/bytes'
import { decodeUtf8, encodeUtf8 } from '../../shared/codec'
import type { RustClientContext } from '../context'
import { asNumber } from '../options'

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
      // Pooled `hmacSha256Into`: writes the 64 hex chars directly into a fresh
      // buffer — no cstring return → no string clone → no encodeUtf8 round-trip
      // (the old path cloned the hex string then re-encoded it to bytes).
      const out = new Uint8Array(64)
      const w = ffi.hmacSha256Into(key, data, out)
      return out.subarray(0, w)
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
      // Pooled `base64EncodeInto`: writes the base64 bytes directly into a
      // fresh buffer sized for the input — no cstring return / re-encode.
      const out = new Uint8Array(Math.ceil(input.length / 3) * 4 + 3)
      const w = ffi.base64EncodeInto(input, out, urlSafe, padding)
      return out.subarray(0, w)
    },
    decode(input) {
      return ffi.base64Decode(input, urlSafe, padding)
    },
  }
}

function ffiCookieSigner(secret: Uint8Array, ffi: BunFFI): CookieSignerInstance {
  return {
    sign(value) {
      // Pooled `signCookieInto`: writes `value.<64-hex>` directly into a fresh
      // buffer — no cstring return / re-encode round-trip.
      const out = new Uint8Array(value.length + 65)
      const w = ffi.signCookieInto(value, secret, out)
      return out.subarray(0, w)
    },
    verify(signed) {
      // Pooled `verifyCookieInto`: writes the verified value directly (the
      // value is a substring of `signed`, so `signed.length + 1` always fits).
      const out = new Uint8Array(signed.length + 1)
      const w = ffi.verifyCookieInto(signed, secret, out)
      return w === null ? null : out.subarray(0, w)
    },
  }
}

/**
 * Opaque-handle `ConditionalRequest`: the napi instance compiles the resource
 * state once (construction); per-call `isNotModified` evaluates it through the
 * C-ABI (`castrum_conditional_is_not_modified`) via the inner handle — no napi
 * crossing. The napi instance MUST stay alive for the handle's lifetime (same
 * contract as the ingress handler / `Ingress::inner_ptr`) — `keepAlive` is
 * referenced by the returned method so the native state is never GC'd while
 * the handle is in use.
 */
function ffiConditionalRequest(
  napi: ConditionalRequestInstance,
  inner: number,
  ffi: BunFFI,
): ConditionalRequestInstance {
  // Referenced by the method below → captured → prevents GC of the native
  // state the opaque handle points into.
  const keepAlive = napi
  return {
    isNotModified(ifNoneMatch, ifModifiedSince) {
      void keepAlive
      return ffi.conditionalIsNotModified(inner, ifNoneMatch ?? null, ifModifiedSince ?? null)
    },
  }
}

/**
 * Opaque-handle `UrlBuilder`: the napi instance parses the base ONCE; per-call
 * `resolve` evaluates it through the C-ABI (`castrum_url_builder_resolve`) via
 * the inner handle — no napi crossing. `keepAlive` references the napi instance
 * so the precompiled base is never GC'd while the handle is in use.
 */
function ffiUrlBuilder(napi: UrlBuilderInstance, inner: number, ffi: BunFFI): UrlBuilderInstance {
  const keepAlive = napi
  return {
    resolve(reference) {
      void keepAlive
      return ffi.urlBuilderResolve(inner, reference)
    },
  }
}

/** Opaque-handle `MediaTypeMatcher` (expected precompiled once). */
function ffiMediaTypeMatcher(
  napi: MediaTypeMatcherInstance,
  inner: number,
  ffi: BunFFI,
): MediaTypeMatcherInstance {
  const keepAlive = napi
  return {
    matches(actual) {
      void keepAlive
      return ffi.mediaTypeMatcherMatches(inner, actual)
    },
  }
}

/** Opaque-handle `AcceptNegotiator` (supported list precompiled once). */
function ffiAcceptNegotiator(
  napi: AcceptNegotiatorInstance,
  inner: number,
  ffi: BunFFI,
): AcceptNegotiatorInstance {
  const keepAlive = napi
  return {
    negotiate(header) {
      void keepAlive
      return ffi.acceptNegotiatorNegotiate(inner, header)
    },
    negotiateServerPreference(header) {
      void keepAlive
      return ffi.acceptNegotiatorNegotiateServer(inner, header)
    },
  }
}

/** Opaque-handle `JwtSigner` (HS256 key + ttl precompiled once). */
function ffiJwtSigner(napi: JwtSignerInstance, inner: number, ffi: BunFFI): JwtSignerInstance {
  const keepAlive = napi
  return {
    sign(claims, nowSeconds) {
      void keepAlive
      return ffi.jwtSignerSign(inner, encoder.encode(JSON.stringify(claims)), nowSeconds)
    },
    signBytes(claimsJson, nowSeconds) {
      void keepAlive
      return ffi.jwtSignerSign(inner, claimsJson, nowSeconds)
    },
    verify(token, nowSeconds) {
      void keepAlive
      const claims = ffi.jwtSignerVerify(inner, token, nowSeconds)
      return claims === null ? null : (JSON.parse(decodeUtf8(claims)) as unknown)
    },
  }
}

/** Opaque-handle `TemplateRenderer` (template compiled once). */
function ffiTemplateRenderer(
  napi: TemplateRendererInstance,
  inner: number,
  ffi: BunFFI,
): TemplateRendererInstance {
  const keepAlive = napi
  return {
    render(context) {
      void keepAlive
      return ffi.templateRender(inner, encoder.encode(JSON.stringify(context)))
    },
    renderBytes(contextJson) {
      void keepAlive
      return ffi.templateRender(inner, contextJson)
    },
    renderBatchPacked(data) {
      void keepAlive
      return napi.renderBatchPacked(data)
    },
  }
}

/** Opaque-handle `SchemaValidator` (schema compiled once); the hot `validate`
 * is a C-ABI eval; the detailed/batch/derive ops stay on the napi instance. */
function ffiSchemaValidator(
  napi: SchemaValidatorInstance,
  inner: number,
  ffi: BunFFI,
): SchemaValidatorInstance {
  const keepAlive = napi
  return {
    validate(input) {
      void keepAlive
      return ffi.schemaValidatorValidate(inner, input)
    },
    validateDetailed: napi.validateDetailed.bind(napi),
    validateFirstError: napi.validateFirstError.bind(napi),
    validateBatchPackedCount: napi.validateBatchPackedCount.bind(napi),
    validateBatchPackedBitset: napi.validateBatchPackedBitset.bind(napi),
    derive: napi.derive.bind(napi),
  }
}

/** Opaque-handle `RateLimiter` (sharded state compiled once). */
function ffiRateLimiter(
  napi: RateLimiterInstance,
  inner: number,
  ffi: BunFFI,
): RateLimiterInstance {
  const keepAlive = napi
  return {
    check(key, nowMs) {
      void keepAlive
      // `key` is a `cstring` ARG — the engine transcodes the rate-limit key
      // in-engine (no JS-side encode).
      return ffi.rateLimiterCheck(inner, key, nowMs)
    },
    checkKey(key, nowMs) {
      void keepAlive
      return ffi.rateLimiterCheckKey(inner, key, nowMs)
    },
  }
}

function ffiCsrfProtector(secret: Uint8Array, ffi: BunFFI): CsrfProtectorInstance {
  return {
    create() {
      // Pooled `csrfTokenInto`: writes the 129-char `hex.hex` directly into a
      // fresh buffer — no cstring return / re-encode round-trip.
      const out = new Uint8Array(129)
      const w = ffi.csrfTokenInto(secret, out)
      return out.subarray(0, w)
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
      return encodeUtf8(ffi.passwordHash(password, salt, mCost, tCost, pCost, outLen))
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

/**
 * Caller-owned-handle `MetricsRegistry`: on Bun the whole surface runs through
 * the C-ABI (`castrum_metrics_*`) with a native handle — no napi instance is
 * involved at all (the route-stack ownership model). Label values cross as a
 * JOINED `\u001f` string via the cstring-ARG `_str` symbols: the engine
 * transcodes them in-engine, so the per-event JS cost is just
 * `values.join('\u001f')` — ZERO TextEncoder work (Bun 1.4 zero-copy text).
 */
function ffiMetricsRegistry(ffi: BunFFI): MetricsRegistryInstance {
  const handle = ffi.metricsCreate()
  return {
    counter(name, labelKeys) {
      return ffi.metricsCounter(handle, name, (labelKeys ?? []).join('\u001f'))
    },
    gauge(name, labelKeys) {
      return ffi.metricsGauge(handle, name, (labelKeys ?? []).join('\u001f'))
    },
    histogram(name, labelKeys, buckets) {
      return ffi.metricsHistogram(
        handle,
        name,
        (labelKeys ?? []).join('\u001f'),
        (buckets ?? []).join(','),
      )
    },
    record(series, values, amount) {
      const joined = (values ?? []).join('\u001f')
      if (!ffi.metricsRecordStr(handle, series, joined, amount ?? 1)) {
        throw new Error('metrics record: unknown series / arity mismatch / invalid amount')
      }
    },
    gaugeSet(series, values, value) {
      const joined = (values ?? []).join('\u001f')
      if (!ffi.metricsGaugeSetStr(handle, series, joined, value)) {
        throw new Error('metrics gauge set: unknown series / arity mismatch')
      }
    },
    render() {
      // Probe large enough for typical registries (one native pass), then
      // grow exactly once if ever exceeded (needed-size convention).
      let out = new Uint8Array(8192)
      let w = ffi.metricsRender(handle, out)
      if (w > out.length) {
        out = new Uint8Array(w)
        w = ffi.metricsRender(handle, out)
      }
      return decodeUtf8(out.subarray(0, w))
    },
    destroy() {
      ffi.metricsDestroy(handle)
    },
    snapshot() {
      // Packed v1 dump — decoded by consumers (the @ignex/native metrics
      // wrapper); probe large, grow exactly once.
      let out = new Uint8Array(4096)
      let w = ffi.metricsSnapshot(handle, out)
      if (w > out.length) {
        out = new Uint8Array(w)
        w = ffi.metricsSnapshot(handle, out)
      }
      return out.subarray(0, w)
    },
  }
}

/** Compiled-once factory + runtime-control methods (`Pick<RustScalar, ...>`). */
export function buildFactories(ctx: RustClientContext) {
  const { transport } = ctx.runtime
  const { addon } = ctx

  return {
    createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.SchemaValidator(schema)
        return ffiSchemaValidator(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.SchemaValidator(schema)
    },
    createHmacSigner(key: Uint8Array): HmacSignerInstance {
      const ffi = transport.ffi
      if (ffi) return ffiHmacSigner(key, ffi)
      return new addon.HmacSigner(key)
    },
    createTemplateRenderer(source: string): TemplateRendererInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.TemplateRenderer(source)
        return ffiTemplateRenderer(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.TemplateRenderer(source)
    },
    createFormParser(capacity?: number): FormParserInstance {
      const ffi = transport.ffi
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
      // FFI-first via the opaque inner handle (the napi instance compiles the
      // state once; per-call `isNotModified` is a C-ABI eval). The wrapper
      // holds the napi instance for the handle's lifetime.
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.ConditionalRequest(etagValue, lastModifiedSecs ?? undefined)
        return ffiConditionalRequest(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.ConditionalRequest(etagValue, lastModifiedSecs ?? undefined)
    },
    createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.AcceptNegotiator(supported)
        return ffiAcceptNegotiator(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.AcceptNegotiator(supported)
    },
    createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance {
      const ffi = transport.ffi
      if (ffi) return ffiBase64Codec(urlSafe, padding, ffi)
      return new addon.Base64Codec(urlSafe ?? undefined, padding ?? undefined)
    },
    createCookieSigner(secret: Uint8Array): CookieSignerInstance {
      const ffi = transport.ffi
      if (ffi) return ffiCookieSigner(secret, ffi)
      return new addon.CookieSigner(secret)
    },
    createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance {
      const ffi = transport.ffi
      if (ffi) return ffiCsrfProtector(secret, ffi)
      return new addon.CsrfProtector(secret)
    },
    createUrlBuilder(base: Uint8Array): UrlBuilderInstance {
      // FFI-first via the opaque inner handle (the napi instance parses the
      // base ONCE; per-call `resolve` is a C-ABI eval). The wrapper holds the
      // napi instance for the handle's lifetime.
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.UrlBuilder(base)
        return ffiUrlBuilder(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.UrlBuilder(base)
    },
    createJwtSigner(secret: Uint8Array, ttlSeconds?: number): JwtSignerInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.JwtSigner(secret, ttlSeconds ?? undefined)
        return ffiJwtSigner(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.JwtSigner(secret, ttlSeconds ?? undefined)
    },
    createAeadCipher(key: Uint8Array, algorithm?: string): AeadCipherInstance {
      const ffi = transport.ffi
      if (ffi) return ffiAeadCipher(key, algorithm, ffi)
      return new addon.AeadCipher(key, algorithm ?? undefined)
    },
    createArgon2Hasher(options?: PasswordHashOptions | null): Argon2HasherInstance {
      const ffi = transport.ffi
      if (ffi) return ffiArgon2Hasher(options, ffi)
      return new addon.Argon2Hasher(options ?? undefined)
    },
    createMediaTypeMatcher(expected: Uint8Array): MediaTypeMatcherInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.MediaTypeMatcher(expected)
        return ffiMediaTypeMatcher(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.MediaTypeMatcher(expected)
    },
    createRateLimiter(
      limit: number,
      windowMs: number,
      maxEntries?: number | null,
    ): RateLimiterInstance {
      const ffi = transport.ffi
      if (ffi) {
        const napi = new addon.RateLimiter(limit, windowMs, maxEntries ?? undefined)
        return ffiRateLimiter(napi, Number(napi.innerPtr?.() ?? 0n), ffi)
      }
      return new addon.RateLimiter(limit, windowMs, maxEntries ?? undefined)
    },
    createMetricsRegistry(): MetricsRegistryInstance {
      // Fully C-ABI-backed on Bun (native handle owned by the wrapper — no
      // napi instance involved); napi class on Node / fallback.
      const ffi = transport.ffi
      if (ffi) return ffiMetricsRegistry(ffi)
      return new addon.MetricsRegistry()
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
