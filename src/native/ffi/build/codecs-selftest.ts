// src/native/ffi/build/codecs-selftest.ts — bind-time self-test for the
// codec/crypto/auth BunFFI surface.
//
// Extracted from codecs.ts so the method builders and the known-answer probes
// stay separate modules; `selftest.ts` ANDs this with the other per-domain
// probes.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import { SELFTEST_HEX, SELFTEST_JSON } from '../constants'
import type { BunFFI } from '../types'

/**
 * Bind-time self-test for the codec/crypto/auth surface (the methods built in
 * `buildCodecs`). Exercises every bound function against known-good vectors;
 * `false` disables the ffi layer and forces the napi fallback.
 */
export function selfTestCodecs(b: BunFFI): boolean {
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  // Checksums + validity probes.
  if (b.crc32(enc.encode('123456789')) !== 0xcbf4_3926) return false
  if (b.fnv1a64(enc.encode('foobar')) !== 0x8594_4171_f739_67e8n) return false
  // XXH3-64 of empty input = 0x2d06800538d394c2 (standard reference vector).
  if (b.xxh3(new Uint8Array(0)) !== 0x2d06800538d394c2n) return false
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
  // Byte-input validator siblings: `(ptr,len)` parity with the string forms.
  if (
    !b.validateEmailBytes(enc.encode('a@b.com')) ||
    !b.validateUuidBytes(enc.encode('550e8400-e29b-41d4-a716-446655440000')) ||
    !b.validateIpv4Bytes(enc.encode('192.168.0.1')) ||
    !b.validateIpv6Bytes(enc.encode('2001:db8::1')) ||
    b.validateEmailBytes(enc.encode('not-an-email')) ||
    b.validateIpv6Bytes(enc.encode('999'))
  ) {
    return false
  }
  // Packed `[u8 ok][i64 sum LE]` ABI: legit zero-sum is ok, invalid input throws.
  if (b.jsonSumIds(enc.encode(`[{"id":1},{"id":2}]`)) !== 3n) return false
  if (b.jsonSumIds(enc.encode(`[{"id":0},{"id":0}]`)) !== 0n) return false
  let sumInvalidThrew = false
  try {
    b.jsonSumIds(enc.encode('nope'))
  } catch {
    sumInvalidThrew = true
  }
  if (!sumInvalidThrew) return false

  // Batch fixed-width hex validation (needed-size convention + verdicts).
  {
    const ids = enc.encode('507f1f77bcf86cd799439011\nzz\n507F1F77BCF86CD799439012')
    const tiny = new Uint8Array(2)
    const needed = b.hexValidateBatchInto(ids, 24, tiny)
    if (needed !== 3) return false // exact required size on a too-small buffer
    const out = new Uint8Array(needed)
    if (b.hexValidateBatchInto(ids, 24, out) !== 3) return false
    if (out[0] !== 1 || out[1] !== 0 || out[2] !== 1) return false
    let widthThrew = false
    try {
      b.hexValidateBatchInto(ids, 0, new Uint8Array(3))
    } catch {
      widthThrew = true
    }
    if (!widthThrew) return false
  }

  // RegExp escaping: metachars get backslashes; plain text is untouched.
  {
    const out = new Uint8Array(64)
    const w = b.regexEscapeInto(enc.encode('a.c(x)'), out)
    if (w !== 9 || dec.decode(out.subarray(0, w)) !== 'a\\.c\\(x\\)') return false
    const plain = new Uint8Array(16)
    const wp = b.regexEscapeInto(enc.encode('hello'), plain)
    if (wp !== 5 || dec.decode(plain.subarray(0, wp)) !== 'hello') return false
    // too-small buffer reports the exact required size
    if (b.regexEscapeInto(enc.encode('a.b'), new Uint8Array(2)) !== 4) return false
    // zero-copy str sibling must produce the identical escaped string
    if (b.regexEscapeStr('a.c(x)') !== 'a\\.c\\(x\\)') return false
    if (b.regexEscapeStr('plain text') !== 'plain text') return false
  }

  // String-input batch hex validation (cstring ARG sibling).
  {
    const out = new Uint8Array(8)
    const w = b.hexValidateBatchStr('507f1f77bcf86cd799439011\nzz', 24, out)
    if (w !== 2 || out[0] !== 1 || out[1] !== 0) return false
  }

  // HMAC RFC 4231 test case 1 (0x0b × 20 key, "Hi There" data).
  const hmacKey = new Uint8Array(20).fill(0x0b)
  const hmacData = enc.encode('Hi There')
  const hmacSig = enc.encode('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  if (
    b.hmacSha256(hmacKey, hmacData) !==
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  ) {
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

  return true
}
