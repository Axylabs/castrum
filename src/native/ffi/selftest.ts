// src/native/ffi/selftest.ts — bind-time self-test for the bun:ffi transport.
//
// Every bound function is checked against known-good vectors at bind time. If
// ANY check fails (ABI mismatch, platform quirk, a future Bun regression), the
// whole ffi layer is disabled and the caller falls back to the napi addon —
// the public API never sees a wrong result. `bun:ffi` is experimental; this is
// the safety net. New C-ABI symbols MUST be added to `selfTest` too.

import { decodeJsonPacked } from '../../rust-ffi/scalar/json-packed'
import { decodeUtf8, encodeUtf8 } from '../../shared/codec'
import { SELFTEST_HEX, SELFTEST_JSON } from './constants'
import type { BunFFI } from './types'

/** Verify every bound function against known-good results; false disables ffi. */
export function selfTest(b: BunFFI): boolean {
  // Codec-backed codecs — on Bun these use native transfer (Bun.ArrayBufferSink
  // / bun:ffi CString) so no TextEncoder/TextDecoder runs on the Bun path.
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  if (b.crc32(enc.encode('123456789')) !== 0xcbf4_3926) {
    return false
  }
  if (b.fnv1a64(enc.encode('foobar')) !== 0x8594_4171_f739_67e8n) {
    return false
  }
  // XXH3-64 of empty input = 0x2d06800538d394c2 (standard reference vector).
  if (b.xxh3(new Uint8Array(0)) !== 0x2d06800538d394c2n) {
    return false
  }
  if (b.jsonValid(SELFTEST_JSON) !== true || b.jsonValid(enc.encode('{not json')) !== false) {
    return false
  }
  // UTF-8 validity probe (native replacement for a fatal TextDecoder on the
  // Bun path — used by the urlDecode wrapper).
  if (!b.utf8Valid(enc.encode('héllo')) || b.utf8Valid(new Uint8Array([0xff, 0xfe]))) {
    return false
  }
  const hexOut = new Uint8Array(SELFTEST_HEX.length * 2)
  if (b.hexEncodeInto(SELFTEST_HEX, hexOut) !== 10 || dec.decode(hexOut) !== '68656c6c6f') {
    return false
  }
  const urlInput = enc.encode('a b/c')
  const urlOut = new Uint8Array(9)
  if (b.urlEncodeInto(urlInput, urlOut) !== 9 || dec.decode(urlOut) !== 'a%20b%2Fc') {
    return false
  }

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

  // ── New bindings ───────────────────────────────────────────────────
  // Validators take `cstring` ARGs (the engine transcodes the JS string).
  if (
    !b.validateEmail('a@b.com') ||
    !b.validateUuid('550e8400-e29b-41d4-a716-446655440000') ||
    !b.validateIpv4('192.168.0.1') ||
    !b.validateIpv6('2001:db8::1') ||
    b.validateEmail('not-an-email') ||
    b.validateUuid('not-a-uuid')
  ) {
    return false
  }
  if (b.jsonSumIds(enc.encode(`[{"id":1},{"id":2}]`)) !== 3n) {
    return false
  }
  // The packed [u8 ok][i64 sum LE] ABI: a legit zero-sum is ok, invalid input throws.
  if (b.jsonSumIds(enc.encode(`[{"id":0},{"id":0}]`)) !== 0n) {
    return false
  }
  let sumInvalidThrew = false
  try {
    b.jsonSumIds(enc.encode('nope'))
  } catch {
    sumInvalidThrew = true
  }
  if (!sumInvalidThrew) {
    return false
  }

  // HMAC RFC 4231 test case 1 (0x0b × 20 key, "Hi There" data).
  const hmacKey = new Uint8Array(20).fill(0x0b)
  const hmacData = enc.encode('Hi There')
  const hmacSig = enc.encode('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  const hmacHex = b.hmacSha256(hmacKey, hmacData)
  if (hmacHex !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7') {
    return false
  }
  if (!b.hmacSha256Verify(hmacKey, hmacData, hmacSig)) {
    return false
  }

  // Decoders round-trip.
  const decoded = b.hexDecode(enc.encode('68656c6c6f'))
  if (
    dec.decode(decoded) !== 'hello' ||
    dec.decode(b.urlDecode(enc.encode('a%20b%2Fc'))) !== 'a b/c'
  ) {
    return false
  }

  // WebSocket accept key (RFC 6455 sample) — `key` is a `cstring` ARG.
  if (b.wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==') !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') {
    return false
  }

  // ETag: strong = 10 bytes, weak = 12 bytes.
  if (b.etag(SELFTEST_HEX).length !== 10 || b.etag(SELFTEST_HEX, true).length !== 12) {
    return false
  }
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

  // base64.
  if (b.base64Encode(SELFTEST_HEX) !== 'aGVsbG8=') {
    return false
  }
  if (dec.decode(b.base64Decode(enc.encode('aGVsbG8='))) !== 'hello') {
    return false
  }

  // Signed cookie round-trip.
  const secret = enc.encode('s3cr3t-secret')
  const signed = b.signCookie(SELFTEST_HEX, secret)
  const verified = b.verifyCookie(enc.encode(signed), secret)
  if (verified === null || verified !== 'hello') {
    return false
  }
  if (b.verifyCookie(enc.encode('tampered.0000'), secret) !== null) {
    return false
  }

  // CSRF token round-trip (issued token verifies against the same secret).
  const csrfTokenStr = b.csrfToken(secret)
  if (csrfTokenStr.length !== 129 || !b.csrfVerify(enc.encode(csrfTokenStr), secret)) {
    return false
  }

  // Argon2id round-trip at minimum cost (fast) — full defaults would take ~50ms.
  const pw = enc.encode('correct horse battery staple')
  const salt = enc.encode('salty-salt-16b')
  const phc = b.passwordHash(pw, salt, 8, 1, 1, 16)
  if (phc.length === 0 || !b.passwordVerify(pw, enc.encode(phc))) {
    return false
  }

  // bcrypt round-trip at minimum cost (fast) — `phc` is a `cstring` ARG.
  const bcryptPhc = b.passwordHashBcrypt(pw, 4)
  if (bcryptPhc.length === 0 || !b.passwordVerifyBcrypt(pw, bcryptPhc)) {
    return false
  }

  // PBKDF2-HMAC-SHA256: password="password", salt="salt", c=1, dkLen=32.
  // The C ABI writes the RAW derived key; hex-encode before comparing.
  const dk = b.pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 1, 32)
  if (b.hexEncode(dk) !== '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b') {
    return false
  }

  // AEAD AES-256-GCM round-trip (key 32B, nonce 12B).
  const aeadKey = new Uint8Array(32).fill(0x42)
  const nonce = new Uint8Array(12).fill(0x07)
  const ct = b.aeadEncrypt(aeadKey, nonce, SELFTEST_HEX, 0)
  const pt = b.aeadDecrypt(aeadKey, nonce, ct, 0)
  if (pt === null || dec.decode(pt) !== 'hello') {
    return false
  }

  // WebSocket frame: text frame, FIN, no mask → first byte 0x81.
  const frame = b.wsFrameEncode(1, SELFTEST_HEX, false, true)
  if (frame.length === 0 || frame[0] !== 0x81) {
    return false
  }

  // JSON patch: add a key.
  const patched = b.jsonPatch(
    enc.encode(`{"a":"b"}`),
    enc.encode(`[{"op":"add","path":"/c","value":"d"}]`),
  )
  if (!patched.includes(`"c":"d"`)) {
    return false
  }

  // gzip / brotli round-trips.
  const gz = b.gzipCompress(SELFTEST_HEX)
  if (dec.decode(b.gzipDecompress(gz)) !== 'hello') {
    return false
  }
  const br = b.brotliCompress(SELFTEST_HEX)
  if (dec.decode(b.brotliDecompress(br)) !== 'hello') {
    return false
  }

  // Needed-size convention: invalid compressed input throws IMMEDIATELY (the C
  // ABI returns 0 = real error, so the JS wrapper does NOT grow-retry re-runs
  // or allocate up to the 64 MiB decompression cap per bad input).
  let decompressThrew = false
  try {
    b.gzipDecompress(enc.encode('not-a-gzip-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }
  decompressThrew = false
  try {
    b.brotliDecompress(enc.encode('not-brotli-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }

  // Packed parsers (non-empty output). Packed output is LARGER than input (each
  // component gets a u32 length prefix), so size with the Rust allocator's
  // conservative upper bound (`input.len() * 9 + 16` in query_parser.rs).
  const req = enc.encode('GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n')
  const reqOut = new Uint8Array(req.length * 9 + 16)
  if (b.httpParseRequestPackedInto(req, reqOut) === 0) {
    return false
  }
  const qIn = enc.encode('a=1&b=2')
  const qOut = new Uint8Array(qIn.length * 9 + 16)
  if (b.queryParsePackedInto(qIn, qOut) === 0) {
    return false
  }
  const cIn = enc.encode('a=1; b=2')
  const cOut = new Uint8Array(cIn.length * 9 + 16)
  if (b.cookieParsePackedInto(cIn, cOut) === 0) {
    return false
  }

  // ── Excluded-surface additions ────────────────────────────────────
  // form parse shares the query core → 2 pairs.
  const fIn = enc.encode('a=1&b=2')
  const fOut = new Uint8Array(fIn.length * 9 + 16)
  if (b.formParsePackedInto(fIn, fOut) === 0 || fOut[0] !== 2) {
    return false
  }

  // multipart parse → 1 part named "field".
  const boundary = enc.encode('----boundary')
  // Wire format is `--{boundary}` — boundary is `----boundary`, so the body
  // must open with `------boundary`.
  const mBody = enc.encode(
    '------boundary\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n------boundary--',
  )
  const mOut = b.multipartParsePacked(mBody, boundary)
  if (mOut[0] !== 1) {
    return false
  }
  // Packed layout: [u32 count][u32 name_len][name]... → name_len at offset 4.
  const mNameLen =
    (mOut[4] ?? 0) | ((mOut[5] ?? 0) << 8) | ((mOut[6] ?? 0) << 16) | ((mOut[7] ?? 0) << 24)
  if (dec.decode(mOut.subarray(8, 8 + mNameLen)) !== 'field') {
    return false
  }

  // WS frame decode: encode("hello") → decode → fin=1, opcode=1, payload="hello".
  const wf = b.wsFrameEncode(1, SELFTEST_HEX, true, true)
  const wd = b.wsFrameDecodePacked(wf)
  if (wd === null || wd[0] !== 1 || wd[1] !== 1 || dec.decode(wd.subarray(6)) !== 'hello') {
    return false
  }
  if (b.wsFrameDecodePacked(enc.encode('\x80')) !== null) {
    return false
  }
  // Pooled sibling: same decode into a caller buffer; malformed → null.
  const wdInto = new Uint8Array(wf.length + 6)
  const wdW = b.wsFrameDecodePackedInto(wf, wdInto)
  if (
    wdW === null ||
    wdInto[0] !== 1 ||
    wdInto[1] !== 1 ||
    dec.decode(wdInto.subarray(6, wdW)) !== 'hello'
  ) {
    return false
  }
  if (b.wsFrameDecodePackedInto(enc.encode('\x80'), wdInto) !== null) {
    return false
  }

  // Random token pooled Into: writes byteLen*2 hex chars into the buffer.
  const rtOut = new Uint8Array(32)
  const rtW = b.randomTokenInto(16, rtOut)
  if (rtW !== 32 || !/^[0-9a-f]{32}$/.test(dec.decode(rtOut))) {
    return false
  }
  // Too-small buffer → throw (needed-size convention).
  try {
    b.randomTokenInto(16, new Uint8Array(8))
    return false
  } catch {
    // expected
  }

  // Fixed-size writers pooled Into: ws_accept_key + etag + csrf_token match the
  // cstring path byte-for-byte.
  const waOut = new Uint8Array(28)
  const waW = b.wsAcceptKeyInto(enc.encode('dGhlIHNhbXBsZSBub25jZQ=='), waOut)
  const waExpected = b.wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')
  if (waW !== 28 || dec.decode(waOut) !== waExpected) {
    return false
  }
  const etagData = enc.encode('hello')
  const etagOut = new Uint8Array(16)
  const etagW = b.etagInto(etagData, etagOut)
  if (etagW !== 10 || dec.decode(etagOut.subarray(0, etagW)) !== b.etag(etagData)) {
    return false
  }
  const csrfOut = new Uint8Array(129)
  const csrfW = b.csrfTokenInto(enc.encode('csrf-secret'), csrfOut)
  if (csrfW !== 129 || csrfOut[64] !== 46 /* '.' */) {
    return false
  }
  // sign/verify cookie pooled Into: round-trip value bytes.
  const ckVal = enc.encode('session-value')
  const ckSec = enc.encode('s3cr3t-secret')
  const ckOut = new Uint8Array(256)
  const ckW = b.signCookieInto(ckVal, ckSec, ckOut)
  if (ckW !== ckVal.length + 65) {
    return false
  }
  const ckVerifyOut = new Uint8Array(256)
  const ckV = b.verifyCookieInto(ckOut.subarray(0, ckW), ckSec, ckVerifyOut)
  if (ckV !== ckVal.length || dec.decode(ckVerifyOut.subarray(0, ckV)) !== 'session-value') {
    return false
  }
  // JWT sign pooled Into: same token as the cstring path.
  const jwtClaims = enc.encode('{"sub":"user-1"}')
  const jwtSecret2 = enc.encode('my-secret')
  const jwtOut = new Uint8Array(512)
  const jwtW = b.jwtSignBytesInto(jwtClaims, jwtSecret2, 0, 0, jwtOut)
  if (jwtW === 0 || dec.decode(jwtOut.subarray(0, jwtW)).split('.').length !== 3) {
    return false
  }

  // Multipart parse Into (pooled): 1 part named "field".
  const mOutInto = new Uint8Array(mBody.length + boundary.length + 64)
  const mW = b.multipartParsePackedInto(mBody, boundary, mOutInto)
  if (mW === 0 || mOutInto[0] !== 1) {
    return false
  }
  const mNameLenInto =
    (mOutInto[4] ?? 0) |
    ((mOutInto[5] ?? 0) << 8) |
    ((mOutInto[6] ?? 0) << 16) |
    ((mOutInto[7] ?? 0) << 24)
  if (dec.decode(mOutInto.subarray(8, 8 + mNameLenInto)) !== 'field') {
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

  // HTTP-date Into: Sun, 06 Nov 1994 08:49:37 GMT (fixed 29 bytes).
  const dateOut = new Uint8Array(32)
  const dateW = b.httpDateInto(784111777, dateOut)
  if (dateW !== 29 || dec.decode(dateOut.subarray(0, dateW)) !== 'Sun, 06 Nov 1994 08:49:37 GMT') {
    return false
  }

  // SSE encode Into: event/id/retry present + null-omission parity.
  const sseData = enc.encode('hello')
  const sse1 = dec.decode(b.sseEncodeEvent('update', sseData, '42', 3000))
  if (sse1 !== 'id: 42\nevent: update\nretry: 3000\ndata: hello\n\n') {
    return false
  }
  const sse2 = dec.decode(b.sseEncodeEvent(null, sseData, null, null))
  if (sse2 !== 'data: hello\n\n') {
    return false
  }
  // Present-but-empty event string emits the line (Option parity vs napi).
  const sse3 = dec.decode(b.sseEncodeEvent('', sseData, null, null))
  if (sse3 !== 'event: \ndata: hello\n\n') {
    return false
  }
  // Pooled sibling: same bytes into a caller buffer; too-small throws.
  const ssePool = new Uint8Array(128)
  const sseW = b.sseEncodeEventInto('update', sseData, '42', 3000, ssePool)
  if (sseW !== sse1.length || dec.decode(ssePool.subarray(0, sseW)) !== sse1) {
    return false
  }
  try {
    b.sseEncodeEventInto('update', sseData, '42', 3000, new Uint8Array(4))
    return false
  } catch {
    // expected
  }

  // ── Wired WIP surface: JWT verify ──
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

  // ── Phase 3 — stateless napi-only scalars ─────────────────────────
  // jsonParsePacked: packed token stream decodes (via the REAL public decoder)
  // to the same value as JSON.parse, with NO second text parse; invalid JSON
  // throws (napi parity). Also verifies the needed-size retry path.
  {
    const packed = b.jsonParsePacked(enc.encode('{"a":1,"b":[true,null,"x"],"n":{"v":2.5}}'))
    const v = decodeJsonPacked(packed) as { a: number; b: unknown[]; n: { v: number } }
    if (v.a !== 1 || v.b[0] !== true || v.b[1] !== null || v.b[2] !== 'x' || v.n.v !== 2.5) {
      return false
    }
    try {
      b.jsonParsePacked(enc.encode('nope'))
      return false
    } catch {
      // expected: invalid JSON → growExact throws
    }
  }

  // parseMediaType: packed verdict, mediaType at [4..4+len].
  const mt = b.parseMediaType(enc.encode('application/json; charset=utf-8'))
  const mtLen = new DataView(mt.buffer, mt.byteOffset, mt.byteLength).getUint32(0, true)
  if (mtLen === 0 || dec.decode(mt.subarray(4, 4 + mtLen)) !== 'application/json') {
    return false
  }

  // parseHttpDate: RFC 7231 vector → epoch; malformed → null.
  if (b.parseHttpDate(enc.encode('Sun, 06 Nov 1994 08:49:37 GMT')) !== 784111777n) {
    return false
  }
  if (b.parseHttpDate(enc.encode('not a date')) !== null) {
    return false
  }

  // parseAcceptEncoding: count, first encoding + q (f32 LE at offset 8+encLen).
  const ae = b.parseAcceptEncoding(enc.encode('gzip, deflate;q=0.5'))
  const aeView = new DataView(ae.buffer, ae.byteOffset, ae.byteLength)
  if (aeView.getUint32(0, true) !== 2) {
    return false
  }
  const aeLen = aeView.getUint32(4, true)
  if (dec.decode(ae.subarray(8, 8 + aeLen)) !== 'gzip') {
    return false
  }
  if (aeView.getFloat32(8 + aeLen, true) !== 1.0) {
    return false
  }

  // urlEncodeQuery (packed pairs → sorted query text). Build the packed pairs
  // inline — no shared/packed import on the bind-time critical path.
  const qpPacked = new Uint8Array(4 + 2 * (4 + 1 + 4 + 1))
  const qpView = new DataView(qpPacked.buffer)
  qpView.setUint32(0, 2, true)
  let qpOff = 4
  for (const [k, v] of [
    ['a', '1'],
    ['b', '2'],
  ] as const) {
    qpView.setUint32(qpOff, k.length, true)
    qpOff += 4
    qpPacked.set(enc.encode(k), qpOff)
    qpOff += k.length
    qpView.setUint32(qpOff, v.length, true)
    qpOff += 4
    qpPacked.set(enc.encode(v), qpOff)
    qpOff += v.length
  }
  if (b.urlEncodeQuery(qpPacked) !== 'a=1&b=2') {
    return false
  }
  // urlResolve: RFC 3986 §5.4.1.
  if (b.urlResolve(enc.encode('http://a/b/c/d;p?q'), enc.encode('g')) !== 'http://a/b/c/g') {
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
  // mimeFromExtension: known + unknown fallback.
  if (b.mimeFromExtension('.js') !== 'text/javascript') {
    return false
  }
  if (b.mimeFromExtension('nope') !== 'application/octet-stream') {
    return false
  }

  // ── Bind-time coverage for the remaining pooled/string wrappers ──
  // (closes the guard gap — every bound BunFFI method is now exercised here,
  // matching the "every bound function is checked at bind time" header claim).

  // urlEncode string form.
  if (b.urlEncode(enc.encode('a b/c')) !== 'a%20b%2Fc') {
    return false
  }
  // hexDecodeInto.
  const hdInto = new Uint8Array(8)
  if (
    b.hexDecodeInto(enc.encode('68656c6c6f'), hdInto) !== 5 ||
    dec.decode(hdInto.subarray(0, 5)) !== 'hello'
  ) {
    return false
  }
  // urlDecodeInto.
  const udInto = new Uint8Array(16)
  if (
    b.urlDecodeInto(enc.encode('a%20b%2Fc'), udInto) !== 5 ||
    dec.decode(udInto.subarray(0, 5)) !== 'a b/c'
  ) {
    return false
  }
  // base64EncodeInto.
  const b64Into = new Uint8Array(16)
  if (
    b.base64EncodeInto(SELFTEST_HEX, b64Into) !== 8 ||
    dec.decode(b64Into.subarray(0, 8)) !== 'aGVsbG8='
  ) {
    return false
  }
  // base64DecodeInto.
  const bdInto = new Uint8Array(8)
  if (
    b.base64DecodeInto(enc.encode('aGVsbG8='), bdInto) !== 5 ||
    dec.decode(bdInto.subarray(0, 5)) !== 'hello'
  ) {
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
  // randomToken string form.
  if (!/^[0-9a-f]{32}$/.test(b.randomToken(16))) {
    return false
  }
  // hmacSha256Into (RFC 4231 test case 1 hex vector).
  const hmacInto = new Uint8Array(64)
  if (
    b.hmacSha256Into(hmacKey, hmacData, hmacInto) !== 64 ||
    dec.decode(hmacInto) !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  ) {
    return false
  }
  // aeadEncryptInto → decrypt round-trip.
  const ctInto = new Uint8Array(64)
  const ctW = b.aeadEncryptInto(aeadKey, nonce, SELFTEST_HEX, ctInto, 0)
  if (ctW === 0 || b.aeadDecrypt(aeadKey, nonce, ctInto.subarray(0, ctW), 0) === null) {
    return false
  }
  // wsFrameEncodeInto.
  const frameInto = new Uint8Array(64)
  if (b.wsFrameEncodeInto(1, SELFTEST_HEX, false, true, frameInto) === 0 || frameInto[0] !== 0x81) {
    return false
  }
  // gzipCompressInto → decompress round-trip.
  const gzInto = new Uint8Array(64)
  const gzW = b.gzipCompressInto(SELFTEST_HEX, gzInto)
  if (gzW === 0 || dec.decode(b.gzipDecompress(gzInto.subarray(0, gzW))) !== 'hello') {
    return false
  }
  // brotliCompressInto → decompress round-trip.
  const brInto = new Uint8Array(64)
  const brW = b.brotliCompressInto(SELFTEST_HEX, brInto)
  if (brW === 0 || dec.decode(b.brotliDecompress(brInto.subarray(0, brW))) !== 'hello') {
    return false
  }
  // gzipDecompressInto → decompress into a CALLER buffer round-trip.
  const gzDst = new Uint8Array(16)
  const gzDW = b.gzipDecompressInto(gzInto.subarray(0, gzW), gzDst)
  if (gzDW === 0 || dec.decode(gzDst.subarray(0, gzDW)) !== 'hello') {
    return false
  }
  // brotliDecompressInto → decompress into a CALLER buffer round-trip.
  const brDst = new Uint8Array(16)
  const brDW = b.brotliDecompressInto(brInto.subarray(0, brW), brDst)
  if (brDW === 0 || dec.decode(brDst.subarray(0, brDW)) !== 'hello') {
    return false
  }
  // httpDate string form (RFC 7231 vector).
  if (b.httpDate(784111777) !== 'Sun, 06 Nov 1994 08:49:37 GMT') {
    return false
  }

  return true
}
