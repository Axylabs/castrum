// src/native/ffi/build/instances.ts — opaque-handle (compiled-instance) BunFFI methods.
//
// Every method here evaluates against a PRECOMPILED native instance via its
// opaque `inner_ptr()` handle (JWT signer, template renderer, schema validator,
// rate limiter, media-type matcher, accept negotiator, conditional request, URL
// builder) or drives a compiled route / the full ingress pipeline. Receives the
// raw dlopen'd symbols and the per-bind context from `build()`.

import { decodeUtf8 } from '../../../shared/codec'
import { EMPTY_VIEW } from '../constants'
import type { BunFFI, Raw2, Raw3, Raw4, Raw5, Raw6, Raw7, Raw8, Raw12, RawCStr } from '../types'
import type { BuildCtx } from './util'
import { cstr, growExact, hasNul, unpackRateCheck } from './util'

/**
 * Build the opaque-handle methods of the BunFFI surface. `ctx` is destructured
 * so the method bodies read exactly as the original `build()`.
 */
export function buildInstances(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView, rateScratch, rateScratchView } = ctx

  const conditionalIsNotModifiedRaw = sym.castrum_conditional_is_not_modified as Raw6
  const mediaTypeMatcherMatchesRaw = sym.castrum_media_type_matcher_matches as Raw3
  const acceptNegotiatorNegotiateRaw = sym.castrum_accept_negotiator_negotiate as RawCStr
  const acceptNegotiatorNegotiateServerRaw = sym.castrum_accept_negotiator_negotiate_server as (
    ...a: unknown[]
  ) => string | null
  const ed25519GenerateKeypairRaw = sym.castrum_ed25519_generate_keypair as Raw2
  const ed25519SignRaw = sym.castrum_ed25519_sign as Raw6
  const ed25519VerifyRaw = sym.castrum_ed25519_verify as Raw6
  const jwtEdDSASignSym = sym.castrum_jwt_eddsa_sign as (...a: unknown[]) => string | null
  const jwtEdDSAVerifySym = sym.castrum_jwt_eddsa_verify as (...a: unknown[]) => string | null
  const jwtSignerSignRaw = sym.castrum_jwt_signer_sign as Raw6
  const jwtSignerVerifyRaw = sym.castrum_jwt_signer_verify as Raw6
  const templateRenderRaw = sym.castrum_template_render as Raw5
  const schemaValidatorValidateRaw = sym.castrum_schema_validator_validate as Raw3
  const queryValidateSym = sym.castrum_query_validate as (...a: unknown[]) => number | bigint
  const cookieValidateSym = sym.castrum_cookie_validate as (...a: unknown[]) => number | bigint
  const sessionSealSym = sym.castrum_session_seal as (...a: unknown[]) => string | null
  const sessionOpenSym = sym.castrum_session_open as Raw4
  const sessionSealBytesSym = sym.castrum_session_seal_bytes as RawCStr
  const sessionOpenBytesSym = sym.castrum_session_open_bytes as Raw6
  const rateLimiterCheckRaw = sym.castrum_rate_limiter_check as Raw5
  const rateLimiterCheckKeyRaw = sym.castrum_rate_limiter_check_key as Raw5
  const jwtSignBytes = sym.castrum_jwt_sign_bytes as RawCStr
  const jwtSignBytesInto = sym.castrum_jwt_sign_bytes_into as Raw8
  const jwtVerifySym = sym.castrum_jwt_verify as (...a: unknown[]) => string | null
  const urlBuilderResolveRaw = sym.castrum_url_builder_resolve as Raw5
  const ingressHandlePacked = sym.castrum_ingress_handle_packed as Raw7
  const ingressHandleComponentsSym = sym.castrum_ingress_handle_components as Raw12
  const ingressLayoutSym = sym.castrum_ingress_layout as Raw2
  const routeCompileSym = sym.castrum_route_compile as Raw2
  const routeRunSym = sym.castrum_route_run as Raw5
  const routeDestroySym = sym.castrum_route_destroy as (a: unknown) => void

  return {
    conditionalIsNotModified(inner, ifNoneMatch, ifModifiedSince) {
      // Opaque-handle eval of the precompiled `ConditionalRequest` state.
      // flags bit0 = If-None-Match present, bit1 = If-Modified-Since present
      // (present-but-empty is distinct from absent — napi Option parity). A
      // null handle (0) → 0 (never dereferences freed state).
      const flags = (ifNoneMatch === null ? 0 : 1) | (ifModifiedSince === null ? 0 : 2)
      const inm = ifNoneMatch ?? EMPTY_VIEW
      const ims = ifModifiedSince ?? EMPTY_VIEW
      return (
        Number(
          conditionalIsNotModifiedRaw(inner, inm, lenOrView(inm), ims, lenOrView(ims), flags),
        ) === 1
      )
    },
    mediaTypeMatcherMatches(inner, actual) {
      // Precompiled expected-type match → u8.
      return Number(mediaTypeMatcherMatchesRaw(inner, actual, lenOrView(actual))) === 1
    },
    acceptNegotiatorNegotiate(inner, header) {
      // cstring best-supported encoding; `null` = identity (napi Option parity).
      return acceptNegotiatorNegotiateRaw(inner, header, lenOrView(header))
    },
    acceptNegotiatorNegotiateServer(inner, header) {
      // Server-preference tie-breaking (RFC 7231 server semantics). The C ABI
      // takes `header` as a `cstring` ARG, so decode the bytes to a JS string
      // (the engine transcodes it to the call-scoped NUL-terminated buffer).
      // A raw NUL is not a valid header byte and would TRUNCATE the arg, so the
      // negotiator would evaluate a prefix — fail safe to identity instead.
      // `null` = identity (napi Option parity).
      const text = decodeUtf8(header)
      if (hasNul(text)) return null
      return acceptNegotiatorNegotiateServerRaw(inner, text)
    },
    jwtSignerSign(inner, claimsJson, nowSeconds) {
      // Precompiled key + ttl → compact token. 0 = invalid claims JSON (real
      // error → growExact throws); w > output.length = exact needed size.
      return growExact(
        (out) =>
          Number(
            jwtSignerSignRaw(
              inner,
              claimsJson,
              lenOrView(claimsJson),
              BigInt(nowSeconds),
              out,
              lenOrView(out),
            ),
          ),
        Math.min(claimsJson.length + 128, 64 * 1024),
        1024 * 1024,
        'jwt signer: invalid claims JSON or output buffer too small',
      )
    },
    jwtSignerVerify(inner, token, nowSeconds) {
      // Precompiled key → claims JSON bytes; 0 = invalid / expired → null.
      const out = new Uint8Array(Math.min(token.length + 256, 64 * 1024))
      const w = Number(
        jwtSignerVerifyRaw(inner, token, lenOrView(token), BigInt(nowSeconds), out, lenOrView(out)),
      )
      if (w === 0) return null
      if (w > out.length) {
        const out2 = new Uint8Array(w)
        const w2 = Number(
          jwtSignerVerifyRaw(
            inner,
            token,
            lenOrView(token),
            BigInt(nowSeconds),
            out2,
            lenOrView(out2),
          ),
        )
        return w2 === 0 ? null : out2.subarray(0, w2)
      }
      return out.subarray(0, w)
    },
    templateRender(inner, contextJson) {
      // Compiled template + pre-serialized JSON context → UTF-8 bytes. 0 =
      // invalid context / render error (real error → growExact throws).
      return growExact(
        (out) =>
          Number(
            templateRenderRaw(inner, contextJson, lenOrView(contextJson), out, lenOrView(out)),
          ),
        Math.min(contextJson.length + 128, 64 * 1024),
        1024 * 1024,
        'template render: invalid context JSON or render failed',
      )
    },
    schemaValidatorValidate(inner, doc) {
      return Number(schemaValidatorValidateRaw(inner, doc, lenOrView(doc))) === 1
    },
    queryValidate(inner, qs) {
      // `qs` is a cstring ARG — engine-transcoded (zero JS encode). A raw NUL is
      // not a valid query byte, and it would TRUNCATE the arg so only a prefix
      // got validated: a gate that says "this query passed" must not be foolable.
      if (hasNul(qs)) return false
      return Number(queryValidateSym(inner, qs)) === 1
    },
    cookieValidate(inner, header) {
      // Same contract as `queryValidate`: a NUL would validate only a prefix.
      if (hasNul(header)) return false
      return Number(cookieValidateSym(inner, header)) === 1
    },
    sessionSeal(id, dataJson, expSecs, secret) {
      // exp is an i64 C arg → BigInt.
      return sessionSealSym(id, dataJson, BigInt(expSecs), secret)
    },
    sessionOpen(token, secret, output) {
      // Needed-size convention; 0 = bad signature / malformed.
      const w = Number(sessionOpenSym(token, secret, output, lenOrView(output)))
      return w
    },
    sessionSealBytes(id, dataJson, expSecs, secret) {
      // Byte-arg form: exact lengths, no engine transcode, no NUL truncation.
      // The parity with `sessionSeal` is asserted in the bind-time self-test
      // below (same core ⇒ byte-identical token for identical inputs).
      return sessionSealBytesSym(
        id,
        lenOrView(id),
        dataJson,
        lenOrView(dataJson),
        BigInt(expSecs),
        secret,
        lenOrView(secret),
      )
    },
    sessionOpenBytes(token, secret, output) {
      // Needed-size convention; 0 = bad signature / malformed.
      return Number(
        sessionOpenBytesSym(
          token,
          lenOrView(token),
          secret,
          lenOrView(secret),
          output,
          lenOrView(output),
        ),
      )
    },
    rateLimiterCheck(inner, key, nowMs) {
      // Packed [u8 allowed][u32 remaining LE][i64 reset_ms LE] (13 bytes).
      // Reused scratch + cached DataView (no per-call allocs). `key` is a
      // `cstring` ARG (the engine transcodes the JS string in-engine). A NUL
      // would TRUNCATE the key so distinct keys collapse into ONE budget — deny
      // fail-closed instead of silently aliasing them.
      if (hasNul(key)) return { allowed: false, remaining: 0, resetMs: 0 }
      const out = rateScratch
      const w = Number(
        rateLimiterCheckRaw(inner, key, BigInt(Math.trunc(nowMs)), out, lenOrView(out)),
      )
      if (w === 0) throw new Error('rate limiter check: null handle')
      return unpackRateCheck(out, rateScratchView)
    },
    rateLimiterCheckKey(inner, key, nowMs) {
      // Packed [u8 allowed][u32 remaining LE][i64 reset_ms LE] (13 bytes).
      // Reused scratch + cached DataView (no per-call allocs).
      const out = rateScratch
      const w = Number(
        rateLimiterCheckKeyRaw(inner, BigInt(key), BigInt(Math.trunc(nowMs)), out, lenOrView(out)),
      )
      if (w === 0) throw new Error('rate limiter check: null handle')
      return unpackRateCheck(out, rateScratchView)
    },
    jwtSignBytes(claimsJson, secret, ttl, now) {
      // Compact HS256 token returned as a cstring (engine-cloned) — the Rust
      // side builds the whole token and the JS pays zero decode. ttl<=0 = no
      // iat/exp (napi Option<i64> sentinel). i64 args must be BigInt.
      return cstr(
        jwtSignBytes(
          claimsJson,
          lenOrView(claimsJson),
          secret,
          lenOrView(secret),
          BigInt(ttl),
          BigInt(now),
        ),
        'jwt sign: invalid claims JSON',
      )
    },
    jwtSignBytesInto(claimsJson, secret, ttl, now, output) {
      // Native pooled `_into`: writes the compact token directly into the
      // caller buffer (no cstring round-trip). Needed-size convention: a write
      // larger than `output.length` reports the exact required size → throw;
      // 0 = invalid claims JSON.
      const w = Number(
        jwtSignBytesInto(
          claimsJson,
          lenOrView(claimsJson),
          secret,
          lenOrView(secret),
          BigInt(ttl),
          BigInt(now),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('jwt sign: invalid claims JSON')
      }
      if (w > output.length) {
        throw new Error('jwt sign: output buffer too small')
      }
      return w
    },
    jwtVerify(token, secret, nowSeconds) {
      // Verify an HS256 JWT → claims as a JSON cstring; `null` = invalid
      // signature / expired / malformed (napi Option parity). `now` is an i64
      // C arg → must be passed as BigInt.
      return jwtVerifySym(token, lenOrView(token), secret, lenOrView(secret), BigInt(nowSeconds))
    },
    ed25519GenerateKeypair() {
      // Packed `[u32 privLen][priv PKCS#8 v1 DER][u32 pubLen][pub SPKI DER]`
      // (100 bytes). Needed-size convention: `0` = CSPRNG failure (throw), a
      // write larger than the buffer = the exact required size (one exact
      // retry). Decode the packed blob into the two DER byte slices.
      const blob = growExact(
        (out) => Number(ed25519GenerateKeypairRaw(out, lenOrView(out))),
        100,
        1024,
        'ed25519 keypair generation failed',
      )
      const privLen =
        (blob[0] ?? 0) | ((blob[1] ?? 0) << 8) | ((blob[2] ?? 0) << 16) | ((blob[3] ?? 0) << 24)
      const privateKey = blob.subarray(4, 4 + privLen)
      const pubStart = 4 + privLen
      const pubLen =
        (blob[pubStart] ?? 0) |
        ((blob[pubStart + 1] ?? 0) << 8) |
        ((blob[pubStart + 2] ?? 0) << 16) |
        ((blob[pubStart + 3] ?? 0) << 24)
      return { privateKey, publicKey: blob.subarray(pubStart + 4, pubStart + 4 + pubLen) }
    },
    ed25519Sign(msg, privateKey) {
      // 64-byte signature (needed-size convention: `0` = invalid private key →
      // growExact throws).
      return growExact(
        (out) =>
          Number(
            ed25519SignRaw(
              privateKey,
              lenOrView(privateKey),
              msg,
              lenOrView(msg),
              out,
              lenOrView(out),
            ),
          ),
        64,
        64,
        'ed25519 sign failed (invalid private key)',
      )
    },
    ed25519Verify(msg, signature, publicKey) {
      // u8 → boolean. C ABI arg order is (key, msg, sig).
      return (
        Number(
          ed25519VerifyRaw(
            publicKey,
            lenOrView(publicKey),
            msg,
            lenOrView(msg),
            signature,
            lenOrView(signature),
          ),
        ) === 1
      )
    },
    jwtEdDSASign(claimsJson, privateKey, ttl, nowSeconds) {
      // Compact EdDSA token as a cstring (engine clone); `null` = invalid
      // claims JSON / invalid private key (the napi `jwt_sign_eddsa` throws,
      // so a future public consumer maps null → throw). `ttl <= 0` = no
      // `iat`/`exp` injection; `now`/`ttl` are i64 C args → BigInt.
      return jwtEdDSASignSym(
        claimsJson,
        lenOrView(claimsJson),
        privateKey,
        lenOrView(privateKey),
        BigInt(ttl),
        BigInt(nowSeconds),
      )
    },
    jwtEdDSAVerify(token, publicKey, nowSeconds) {
      // Claims JSON as a cstring; `null` = invalid signature / expired /
      // malformed (napi Option parity).
      return jwtEdDSAVerifySym(
        token,
        lenOrView(token),
        publicKey,
        lenOrView(publicKey),
        BigInt(nowSeconds),
      )
    },
    urlBuilderResolve(inner, reference) {
      // Opaque-handle resolve against a `UrlBuilder`'s PRECOMPILED base. 0 =
      // null handle / non-UTF-8 reference (real error → growExact throws);
      // w > output.length = exact needed size (one exact retry).
      return growExact(
        (out) =>
          Number(urlBuilderResolveRaw(inner, reference, lenOrView(reference), out, lenOrView(out))),
        Math.min(reference.length * 2 + 128, 64 * 1024),
        1024 * 1024,
        'url builder resolve: invalid reference or output buffer too small',
      )
    },
    ingressHandlePacked(inner, input, body, output) {
      const w = Number(
        ingressHandlePacked(
          inner,
          input,
          lenOrView(input),
          body ?? EMPTY_VIEW,
          // Under `buffer_length` the length slot must be a view (the engine
          // reads byteLength off it) — `EMPTY_VIEW` has byteLength 0, matching
          // a null body; under `(ptr,usize)` it's the explicit length 0.
          body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ingress handle: output buffer too small or pipeline error')
      }
      return w
    },
    ingressHandleComponents(inner, methodKind, url, ip, rid, headers, body, output) {
      // `url`/`ip` are passed as JS strings to `cstring` args — the engine
      // transcodes them to call-scoped NUL-terminated UTF-8 buffers in-engine
      // (no JS-side `Buffer.write` encode, no frame assembly for URL/IP).
      const w = Number(
        ingressHandleComponentsSym(
          inner,
          methodKind,
          url,
          ip,
          rid,
          lenOrView(rid),
          headers,
          lenOrView(headers),
          body ?? EMPTY_VIEW,
          body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ingress components: output buffer too small or pipeline error')
      }
      return w
    },
    ingressLayout(out) {
      const w = Number(ingressLayoutSym(out, lenOrView(out)))
      if (w !== out.length) {
        throw new Error('ingress layout: output buffer too small')
      }
      return w
    },
    routeCompile(descriptor) {
      const handle = Number(routeCompileSym(descriptor, lenOrView(descriptor)))
      if (handle === 0) {
        throw new Error('route compile: invalid route descriptor')
      }
      return handle
    },
    routeRun(handle, frame, output) {
      // Needed-size convention: `0` = real error (malformed frame / panic); a
      // write larger than `output.length` is the EXACT required size (caller
      // allocates once and retries) — only a `0` write throws here.
      const w = Number(routeRunSym(handle, frame, lenOrView(frame), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('route run: malformed frame or pipeline error')
      }
      return w
    },
    routeDestroy(handle) {
      routeDestroySym(handle)
    },
  }
}
