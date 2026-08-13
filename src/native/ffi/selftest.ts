// src/native/ffi/selftest.ts — bind-time self-test for the bun:ffi transport.
//
// Every bound function is checked against known-good vectors at bind time. If
// ANY check fails (ABI mismatch, platform quirk, a future Bun regression), the
// whole ffi layer is disabled and the caller falls back to the napi addon —
// the public API never sees a wrong result. `bun:ffi` is experimental; this is
// the safety net. New C-ABI symbols MUST be added to `selfTest` too.

import { encoder, SELFTEST_HEX, SELFTEST_JSON } from './constants'
import type { BunFFI } from './types'

/** Verify every bound function against known-good results; false disables ffi. */
export function selfTest(b: BunFFI): boolean {
  const dec = new TextDecoder()
  const enc = encoder

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

  // ── New bindings ───────────────────────────────────────────────────
  const a = enc.encode('a@b.com')
  const uuid = enc.encode('550e8400-e29b-41d4-a716-446655440000')
  if (
    !b.validateEmail(a) ||
    !b.validateUuid(uuid) ||
    !b.validateIpv4(enc.encode('192.168.0.1')) ||
    !b.validateIpv6(enc.encode('2001:db8::1')) ||
    b.validateEmail(enc.encode('not-an-email')) ||
    b.validateUuid(enc.encode('not-a-uuid'))
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
  if (dec.decode(hmacHex) !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7') {
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

  // WebSocket accept key (RFC 6455 sample).
  if (
    dec.decode(b.wsAcceptKey(enc.encode('dGhlIHNhbXBsZSBub25jZQ=='))) !==
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  ) {
    return false
  }

  // ETag: strong = 10 bytes, weak = 12 bytes.
  if (b.etag(SELFTEST_HEX).length !== 10 || b.etag(SELFTEST_HEX, true).length !== 12) {
    return false
  }

  // base64.
  if (dec.decode(b.base64Encode(SELFTEST_HEX)) !== 'aGVsbG8=') {
    return false
  }
  if (dec.decode(b.base64Decode(enc.encode('aGVsbG8='))) !== 'hello') {
    return false
  }

  // Signed cookie round-trip.
  const secret = enc.encode('s3cr3t-secret')
  const signed = b.signCookie(SELFTEST_HEX, secret)
  const verified = b.verifyCookie(signed, secret)
  if (verified === null || dec.decode(verified) !== 'hello') {
    return false
  }
  if (b.verifyCookie(enc.encode('tampered.0000'), secret) !== null) {
    return false
  }

  // CSRF token round-trip (issued token verifies against the same secret).
  const csrfTokenBytes = b.csrfToken(secret)
  if (csrfTokenBytes.length !== 129 || !b.csrfVerify(csrfTokenBytes, secret)) {
    return false
  }

  // Argon2id round-trip at minimum cost (fast) — full defaults would take ~50ms.
  const pw = enc.encode('correct horse battery staple')
  const salt = enc.encode('salty-salt-16b')
  const phc = b.passwordHash(pw, salt, 8, 1, 1, 16)
  if (phc.length === 0 || !b.passwordVerify(pw, phc)) {
    return false
  }

  // bcrypt round-trip at minimum cost (fast).
  const bcryptPhc = b.passwordHashBcrypt(pw, 4)
  if (bcryptPhc.length === 0 || !b.passwordVerifyBcrypt(pw, bcryptPhc)) {
    return false
  }

  // PBKDF2-HMAC-SHA256: password="password", salt="salt", c=1, dkLen=32.
  // The C ABI writes the RAW derived key; hex-encode before comparing.
  const dk = b.pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 1, 32)
  if (
    dec.decode(b.hexEncode(dk)) !==
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
  ) {
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
  if (!dec.decode(patched).includes(`"c":"d"`)) {
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
  const mNameLen = (mOut[4] ?? 0) | ((mOut[5] ?? 0) << 8) | ((mOut[6] ?? 0) << 16) | ((mOut[7] ?? 0) << 24)
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

  // JWT sign with ttl=0 (deterministic — no iat/exp), then verify the
  // signature with the FFI HMAC to prove the binding is real.
  const jwtSecret = enc.encode('my-secret')
  const jwt = b.jwtSignBytes(enc.encode('{"sub":"user-1"}'), jwtSecret, 0, 0)
  const jwtStr = dec.decode(jwt)
  const segs = jwtStr.split('.')
  if (segs.length !== 3 || segs[0] === '' || segs[1] === '' || segs[2] === '') {
    return false
  }
  const signingInput = enc.encode(`${segs[0]}.${segs[1]}`)
  const sigHex = dec.decode(b.hmacSha256(jwtSecret, signingInput))
  const sigBytes = b.base64Decode(enc.encode(segs[2]), true, false)
  if (sigBytes === null || dec.decode(b.hexEncode(sigBytes)) !== sigHex) {
    return false
  }

  return true
}

