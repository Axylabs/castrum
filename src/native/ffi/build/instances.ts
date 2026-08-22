// src/native/ffi/build/instances.ts — opaque-handle (compiled-instance) BunFFI methods.
//
// Every method here evaluates against a PRECOMPILED native instance via its
// opaque `inner_ptr()` handle (JWT signer, template renderer, schema validator,
// rate limiter, media-type matcher, accept negotiator, conditional request, URL
// builder) or drives a compiled route / the full ingress pipeline. Receives the
// raw dlopen'd symbols and the per-bind context from `build()`.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import { EMPTY_VIEW } from '../constants'
import type { BunFFI, Raw2, Raw3, Raw5, Raw6, Raw7, Raw8, Raw12, RawCStr } from '../types'
import type { BuildCtx } from './util'
import { cstr, growExact, unpackRateCheck } from './util'

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
  const acceptNegotiatorNegotiateServerRaw = sym
    .castrum_accept_negotiator_negotiate_server as (...a: unknown[]) => string | null
  const ed25519GenerateKeypairRaw = sym.castrum_ed25519_generate_keypair as Raw2
  const ed25519SignRaw = sym.castrum_ed25519_sign as Raw6
  const ed25519VerifyRaw = sym.castrum_ed25519_verify as Raw6
  const jwtEdDSASignSym = sym.castrum_jwt_eddsa_sign as (...a: unknown[]) => string | null
  const jwtEdDSAVerifySym = sym.castrum_jwt_eddsa_verify as (...a: unknown[]) => string | null
  const jwtSignerSignRaw = sym.castrum_jwt_signer_sign as Raw6
  const jwtSignerVerifyRaw = sym.castrum_jwt_signer_verify as Raw6
  const templateRenderRaw = sym.castrum_template_render as Raw5
  const schemaValidatorValidateRaw = sym.castrum_schema_validator_validate as Raw3
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
      // `null` = identity (napi Option parity).
      return acceptNegotiatorNegotiateServerRaw(inner, decodeUtf8(header))
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
    rateLimiterCheck(inner, key, nowMs) {
      // Packed [u8 allowed][u32 remaining LE][i64 reset_ms LE] (13 bytes).
      // Reused scratch + cached DataView (no per-call allocs). `key` is a
      // `cstring` ARG (the engine transcodes the JS string in-engine).
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

/**
 * Bind-time self-test for the opaque-handle surface (the methods built in
 * `buildInstances`). `false` disables the ffi layer and forces the napi
 * fallback.
 */
export function selfTestInstances(b: BunFFI): boolean {
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  // Ingress layout blob (38 × u32 LE). The pinned values catch a reordered
  // `#[repr(C)] IngressLayout` (drift → self-test fails → napi fallback); the
  // Rust unit test `ingress_layout_c_abi_matches_output_source` pins every
  // field against output.rs. Slot order mirrors the struct field order.
  const layoutBuf = new Uint8Array(38 * 4)
  b.ingressLayout(layoutBuf)
  const layoutView = new DataView(layoutBuf.buffer, layoutBuf.byteOffset, layoutBuf.byteLength)
  if (
    layoutView.getUint32(0, true) !== 0 || // OUT_VERDICT
    layoutView.getUint32(2 * 4, true) !== 2 || // OUT_STATUS
    layoutView.getUint32(12 * 4, true) !== 48 || // OUT_DATA_START
    layoutView.getUint32(13 * 4, true) !== 1 || // FLAG_HAS_COOKIES
    layoutView.getUint32(28 * 4, true) !== 32 || // HV_COUNT
    layoutView.getUint32(37 * 4, true) !== 8 // ERR_INTERNAL
  ) {
    return false
  }

  // Ingress pipeline C-ABI: with a null (0) inner handle the Rust side returns
  // 0 immediately and the wrapper throws. This exercises the symbol's ABI (arg
  // count/types/return) at bind time — a signature drift would surface here
  // instead of crashing under load. Real frame→output parity is covered by
  // ffi.test.ts against a live napi instance.
  try {
    b.ingressHandlePacked(0, enc.encode('/'), null, new Uint8Array(64))
    return false // a null handle must throw, not return
  } catch {
    // expected: null inner handle → 0 → throw
  }

  // Ingress raw-components C-ABI: with a null (0) inner handle the Rust side
  // returns 0 immediately and the wrapper throws — exercises the 12-arg ABI
  // (incl. the two `cstring` slots for url/ip) at bind time. Real frame→output
  // parity is covered by ffi.test.ts against a live napi instance.
  try {
    b.ingressHandleComponents(
      0,
      0, // GET
      '/',
      '',
      enc.encode('rid'),
      new Uint8Array(2), // empty packed headers [u16 0]
      null,
      new Uint8Array(64),
    )
    return false // a null handle must throw, not return
  } catch {
    // expected: null inner handle → 0 → throw
  }

  // Per-route native stack (castrum_route_*): compile a parseQuery-only
  // descriptor, run one frame, assert the packed verdict. Exercises all three
  // symbols' ABI at bind time (handle return, run needed-size, destroy).
  const routeDesc = new Uint8Array(33)
  const rd = new DataView(routeDesc.buffer)
  rd.setUint32(0, 0x524f5554, true) // ROUTE_DESC_MAGIC "ROUT"
  rd.setUint32(4, 3, true) // ROUTE_DESC_VERSION
  rd.setUint32(8, 2 * 1024 * 1024, true) // maxBodyBytes
  rd.setUint32(12, 8192, true) // maxQueryBytes
  rd.setUint32(16, 8192, true) // maxCookieBytes
  rd.setUint32(20, 0, true) // maxPairs
  rd.setUint32(24, 1, true) // stageCount
  routeDesc[28] = 0 // parseQuery
  rd.setUint32(29, 0, true) // schemaCount
  const routeHandle = b.routeCompile(routeDesc)
  if (routeHandle === 0) {
    return false
  }
  const routeFrame = new Uint8Array(15)
  const rf = new DataView(routeFrame.buffer)
  rf.setUint32(0, 0, true) // flags (no body)
  rf.setUint32(4, 3, true) // qLen
  routeFrame.set(enc.encode('a=1'), 8)
  rf.setUint32(11, 0, true) // cLen
  const routeOut = new Uint8Array(64)
  const routeW = b.routeRun(routeHandle, routeFrame, routeOut)
  if (routeW <= 8) {
    return false // header + a query pair section must exceed 8 bytes
  }
  const rv = new DataView(routeOut.buffer)
  const rFlags = rv.getUint32(0, true)
  if ((rFlags & 0b1) === 0 || (rFlags & 0b100) === 0) {
    return false // OK + QUERY_VALID bits must be set
  }
  b.routeDestroy(routeHandle)

  // ConditionalRequest opaque-handle: a null (0) handle must return false (the
  // C side never dereferences freed state) — exercises the symbol's ABI. Real
  // verdict parity is covered by test/unit/features/etag.test.ts.
  if (b.conditionalIsNotModified(0, null, null) !== false) {
    return false
  }

  // Phase 6 opaque-handle instances: null (0) handles must fail SAFELY (false /
  // null / throw — never dereference freed state). Real verdict parity is
  // covered by the per-instance JS tests.
  if (b.mediaTypeMatcherMatches(0, enc.encode('x')) !== false) return false
  if (b.acceptNegotiatorNegotiate(0, enc.encode('gzip')) !== null) return false
  if (b.acceptNegotiatorNegotiateServer(0, enc.encode('gzip')) !== null) return false
  if (b.schemaValidatorValidate(0, enc.encode('{}')) !== false) return false
  if (b.jwtSignerVerify(0, enc.encode('a.b.c'), 0) !== null) return false
  let phase6Threw = false
  try {
    b.jwtSignerSign(0, enc.encode('{}'), 0)
  } catch {
    phase6Threw = true
  }
  if (!phase6Threw) return false
  phase6Threw = false
  try {
    b.templateRender(0, enc.encode('{}'))
  } catch {
    phase6Threw = true
  }
  if (!phase6Threw) return false
  phase6Threw = false
  try {
    b.rateLimiterCheck(0, 'k', 0)
  } catch {
    phase6Threw = true
  }
  if (!phase6Threw) return false

  // JWT sign pooled Into: same token as the cstring path.
  const jwtClaims = enc.encode('{"sub":"user-1"}')
  const jwtSecret2 = enc.encode('my-secret')
  const jwtOut = new Uint8Array(512)
  const jwtW = b.jwtSignBytesInto(jwtClaims, jwtSecret2, 0, 0, jwtOut)
  if (jwtW === 0 || dec.decode(jwtOut.subarray(0, jwtW)).split('.').length !== 3) {
    return false
  }

  // JWT sign with ttl=0 (deterministic — no iat/exp), then verify the
  // signature with the FFI HMAC to prove the binding is real.
  const jwtSecret = enc.encode('my-secret')
  const jwt = b.jwtSignBytes(enc.encode('{"sub":"user-1"}'), jwtSecret, 0, 0)
  const jwtStr = jwt
  const segs = jwtStr.split('.')
  if (segs.length !== 3 || segs[0] === '' || segs[1] === '' || segs[2] === '') {
    return false
  }
  const signingInput = enc.encode(`${segs[0]}.${segs[1]}`)
  const sigHex = b.hmacSha256(jwtSecret, signingInput)
  const sigBytes = b.base64Decode(enc.encode(segs[2] ?? ''), true, false)
  if (sigBytes === null || b.hexEncode(sigBytes) !== sigHex) {
    return false
  }

  // jwtVerify: sign (ttl=0 → no iat/exp) then verify → claims JSON; tampered → null.
  const vjwtSecret = enc.encode('verify-secret')
  const vjwt = b.jwtSignBytes(enc.encode('{"sub":"u-1"}'), vjwtSecret, 0, 0)
  const vjwtClaims = b.jwtVerify(enc.encode(vjwt), vjwtSecret, 0)
  if (vjwtClaims === null || !vjwtClaims.includes('"sub":"u-1"')) {
    return false
  }
  if (b.jwtVerify(enc.encode('tampered.token.value'), vjwtSecret, 0) !== null) {
    return false
  }

  // Ed25519 round-trip: generate → sign → verify (and a tampered signature
  // must be rejected). The generate wrapper also parses the packed blob, so
  // this pins the `[u32 privLen][priv][u32 pubLen][pub]` layout.
  const edKp = b.ed25519GenerateKeypair()
  const edMsg = enc.encode('ed25519 bind-time self-test')
  const edSig = b.ed25519Sign(edMsg, edKp.privateKey)
  if (edSig.byteLength !== 64 || !b.ed25519Verify(edMsg, edSig, edKp.publicKey)) {
    return false
  }
  const edTampered = edSig.slice()
  edTampered[0] = (edTampered[0] ?? 0) ^ 0xff
  if (b.ed25519Verify(edMsg, edTampered, edKp.publicKey)) {
    return false
  }
  // EdDSA JWT round-trip on the SAME keypair (ttl=0 → no iat/exp, so verify
  // succeeds at any `now`).
  const edToken = b.jwtEdDSASign(enc.encode('{"sub":"ffi-self-test"}'), edKp.privateKey, 0, 0)
  if (edToken === null || edToken.split('.').length !== 3) {
    return false
  }
  const edClaims = b.jwtEdDSAVerify(enc.encode(edToken), edKp.publicKey, 0)
  if (edClaims === null || !edClaims.includes('"sub":"ffi-self-test"')) {
    return false
  }
  if (b.jwtEdDSAVerify(enc.encode('tampered.token.value'), edKp.publicKey, 0) !== null) {
    return false
  }

  // UrlBuilder opaque-handle: a null (0) handle must throw (the C side never
  // dereferences freed state) — exercises the symbol's ABI. Real resolve
  // parity is covered by test/unit/features/url-join.test.ts.
  let urlBuilderThrew = false
  try {
    b.urlBuilderResolve(0, enc.encode('g'))
  } catch {
    urlBuilderThrew = true
  }
  if (!urlBuilderThrew) {
    return false
  }
  // rateLimiterCheckKey: null (0) handle → throw (ABI exercise).
  let rlKeyThrew = false
  try {
    b.rateLimiterCheckKey(0, 12345, 0)
  } catch {
    rlKeyThrew = true
  }
  if (!rlKeyThrew) {
    return false
  }

  return true
}
