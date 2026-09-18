// src/native/ffi/build/instances-selftest.ts — bind-time self-test for the
// opaque-handle (compiled-instance) BunFFI surface.
//
// Extracted from instances.ts so the method builders and the value probes stay
// separate modules; `selftest.ts` ANDs this with the other per-domain probes.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import type { BunFFI } from '../types'

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
  // Wire-validate: null inner (0) → false (ABI exercise); real parity lives
  // in ffi.test.ts with a live compiled instance.
  if (b.queryValidate(0, 'route=/a') !== false) return false
  if (b.cookieValidate(0, 'route=/a') !== false) return false

  // Session seal/open round trip through the C ABI.
  {
    const tok = b.sessionSeal('sess-9', '{"n":1}', 1234567, 'sekrit')
    if (tok === null || !tok.includes('.') || !tok.startsWith('{"id":"sess-9"')) return false
    const out = new Uint8Array(256)
    const w = b.sessionOpen(tok, 'sekrit', out)
    if (w <= 13 || out[0] !== 1) return false
    // bad signature → 0
    if (b.sessionOpen(tok, 'wrong', out) !== 0) return false

    // Byte-arg siblings. Both forms share ONE core, so the sealed token must be
    // byte-identical — the strongest available parity check between the two.
    const enc = new TextEncoder()
    const tokB = b.sessionSealBytes(
      enc.encode('sess-9'),
      enc.encode('{"n":1}'),
      1234567,
      enc.encode('sekrit'),
    )
    if (tokB === null || tokB !== tok) return false
    const outB = new Uint8Array(256)
    const wB = b.sessionOpenBytes(enc.encode(tokB), enc.encode('sekrit'), outB)
    if (wB !== w || outB[0] !== 1) return false
    // Bad signature → 0; a too-small buffer reports the EXACT size, not 0.
    if (b.sessionOpenBytes(enc.encode(tokB), enc.encode('wrong'), outB) !== 0) return false
    if (b.sessionOpenBytes(enc.encode(tokB), enc.encode('sekrit'), outB.subarray(0, 4)) !== wB)
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
