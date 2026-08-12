/**
 * Bun `bun:ffi` fast-path tests.
 *
 * Under Bun the scalar hot functions (crc32 / fnv1a64 / xxh3 / jsonValid /
 * hexEncode[Into] / urlEncode[Into]) route through the C-ABI `bun:ffi`
 * bindings (`src/native/ffi.ts`) to cut the N-API crossing cost. This suite
 * verifies the fast path is LIVE and byte-for-byte identical to the napi
 * addon (the bind-time self-test guarantees this, but we pin it here too).
 * Under Node the path is absent and the napi fallback is used.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { IngressInputPacker } from '../../../src/ingress/packing/input-packer'
import * as constants from '../../../src/ingress/constants'
import { getAddon } from '../../../src/native'
import { getBunFFI } from '../../../src/native/ffi'
import { rust } from '../../../src/rust-ffi'
import { isBun } from '../../../src/shared/runtime'

const encoder = new TextEncoder()

describe('bun:ffi fast path', () => {
  test('is active under Bun with the self-test passing', () => {
    // The self-test already ran (and passed) inside getBunFFI — if it had
    // failed, getBunFFI would have returned null and this would be skipped.
    const ffi = getBunFFI()
    if (!isBun()) {
      expect(ffi).toBeNull()
      return
    }
    expect(ffi).not.toBeNull()
  })

  test('scalar results match the napi addon byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) {
      return // ffi unavailable — napi path covered by the rest of the suite
    }
    const addon = getAddon()
    const input = encoder.encode(
      'the quick brown fox jumps over the lazy dog 1234567890 \u00e9\u{1D11E}',
    )

    expect(rust.crc32(input)).toBe(addon.crc32(input))
    expect(rust.fnv1a64(input)).toBe(addon.fnv1a64(input))
    expect(rust.xxh3(input)).toBe(addon.xxh3(input))
    expect(rust.jsonValid(input)).toBe(addon.jsonValid(input))

    expect(Array.from(rust.hexEncode(input))).toEqual(Array.from(addon.hexEncode(input)))
    const out = new Uint8Array(input.length * 2)
    expect(rust.hexEncodeInto(input, out)).toBe(input.length * 2)
    expect(Array.from(out)).toEqual(Array.from(addon.hexEncode(input)))

    expect(Array.from(rust.urlEncode(input))).toEqual(Array.from(addon.urlEncode(input)))
    const uout = new Uint8Array(input.length * 3)
    const uw = rust.urlEncodeInto(input, uout)
    expect(Array.from(uout.subarray(0, uw))).toEqual(Array.from(addon.urlEncode(input)))
  })

  test('hexEncodeInto still throws on a too-small buffer (napi parity)', () => {
    if (!isBun() || getBunFFI() === null) {
      return
    }
    expect(() => rust.hexEncodeInto(encoder.encode('hello'), new Uint8Array(2))).toThrow()
  })

  test('empty and non-ASCII inputs round-trip through the ffi path', () => {
    if (!isBun() || getBunFFI() === null) {
      return
    }
    const addon = getAddon()
    const cases = [
      new Uint8Array(0),
      encoder.encode(''),
      encoder.encode('a%20b'),
      encoder.encode('\u00e9\u4e2d\u{1F600}'),
    ]
    for (const c of cases) {
      expect(rust.crc32(c)).toBe(addon.crc32(c))
      expect(Array.from(rust.hexEncode(c))).toEqual(Array.from(addon.hexEncode(c)))
      expect(Array.from(rust.urlEncode(c))).toEqual(Array.from(addon.urlEncode(c)))
    }
  })

  // ── Full-surface FFI coverage (validators, codecs, crypto, payload, http) ──

  test('validators match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const inputs = [
      encoder.encode('a@b.com'),
      encoder.encode('not-an-email'),
      encoder.encode('550e8400-e29b-41d4-a716-446655440000'),
      encoder.encode('not-a-uuid'),
      encoder.encode('192.168.0.1'),
      encoder.encode('999.1.1.1'),
      encoder.encode('2001:db8::1'),
      encoder.encode('not-ipv6'),
    ]
    for (const input of inputs) {
      expect(rust.validateEmail(input)).toBe(addon.validateEmail(input))
      expect(rust.validateUuid(input)).toBe(addon.validateUuid(input))
      expect(rust.validateIpv4(input)).toBe(addon.validateIpv4(input))
      expect(rust.validateIpv6(input)).toBe(addon.validateIpv6(input))
    }
  })

  test('json sum / patch match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const doc = encoder.encode('[{"id":1},{"id":2},{"id":3}]')
    // Public API returns bigint; the napi addon surfaces i64 as a JS number.
    expect(rust.jsonSumIds(doc)).toBe(BigInt(addon.jsonSumIds(doc)))
    expect(
      Array.from(
        rust.jsonPatch(
          encoder.encode('{"a":"b"}'),
          encoder.encode('[{"op":"add","path":"/c","value":"d"}]'),
        ),
      ),
    ).toEqual(
      Array.from(
        addon.jsonPatch(
          encoder.encode('{"a":"b"}'),
          encoder.encode('[{"op":"add","path":"/c","value":"d"}]'),
        ),
      ),
    )
  })

  test('decoders match the napi addon byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const input = encoder.encode('a%20b%2Fc%00%C3%A9')
    expect(Array.from(rust.urlDecode(input))).toEqual(Array.from(addon.urlDecode(input)))
    expect(Array.from(rust.urlDecodeBytes(input))).toEqual(Array.from(addon.urlDecodeBytes(input)))
    expect(Array.from(rust.hexDecode(encoder.encode('68656c6c6f')))).toEqual(
      Array.from(addon.hexDecode(encoder.encode('68656c6c6f'))),
    )
    const b64 = encoder.encode('aGVsbG8=')
    expect(Array.from(rust.base64Decode(b64))).toEqual(Array.from(addon.base64Decode(b64)))
    expect(Array.from(rust.base64Decode(b64, true, true))).toEqual(
      Array.from(addon.base64Decode(b64, true, true)),
    )
    expect(Array.from(rust.base64UrlDecode(encoder.encode('aGVsbG8')))).toEqual(
      Array.from(addon.base64UrlDecode(encoder.encode('aGVsbG8'))),
    )
  })

  test('urlDecode throws on invalid UTF-8 output (napi parity)', () => {
    if (!isBun() || getBunFFI() === null) return
    // %FF decodes to a lone 0xFF byte — invalid UTF-8, so napi url_decode throws.
    expect(() => rust.urlDecode(encoder.encode('%FF'))).toThrow()
    expect(() => rust.urlDecodeBytes(encoder.encode('%FF'))).not.toThrow()
  })

  test('malformed decoders throw via ffi (napi parity)', () => {
    if (!isBun() || getBunFFI() === null) return
    expect(() => rust.hexDecode(encoder.encode('zz'))).toThrow()
    expect(() => rust.base64Decode(encoder.encode('!!!!'))).toThrow()
  })

  test('HMAC, signed cookies and CSRF match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const key = new Uint8Array(20).fill(0x0b)
    const data = encoder.encode('Hi There')
    expect(Array.from(rust.hmacSha256(key, data))).toEqual(Array.from(addon.hmacSha256(key, data)))

    const secret = encoder.encode('s3cr3t-secret')
    const value = encoder.encode('session-id-123')
    const signed = rust.signCookie(value, secret)
    expect(Array.from(signed)).toEqual(Array.from(addon.signCookie(value, secret)))
    const verified = rust.verifyCookie(signed, secret)
    const verifiedAddon = addon.verifyCookie(signed, secret)
    expect(verified).not.toBeNull()
    expect(Array.from(verified!)).toEqual(Array.from(verifiedAddon!))
    expect(rust.verifyCookie(encoder.encode('bad.signature'), secret)).toBeNull()

    // CSRF: a token issued via ffi verifies through BOTH paths.
    const token = rust.csrfToken(secret)
    expect(token.length).toBe(129)
    expect(rust.csrfVerify(token, secret)).toBe(true)
    expect(addon.csrfVerify(token, secret)).toBe(true)
  })

  test('random token produces the expected shape', () => {
    if (!isBun() || getBunFFI() === null) return
    const t = rust.randomToken(16)
    expect(t.length).toBe(32)
    expect(/^[0-9a-f]{32}$/.test(new TextDecoder().decode(t))).toBe(true)
  })

  test('password hashing round-trips through both paths', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const pw = encoder.encode('correct horse battery staple')
    const salt = encoder.encode('salty-salt-16b')
    const opts = { mCost: 8, tCost: 1, pCost: 1, outLen: 16 }
    // Argon2 is deterministic given (password, salt, params) → byte-identical.
    expect(Array.from(rust.passwordHash(pw, salt, opts))).toEqual(
      Array.from(addon.passwordHash(pw, salt, opts)),
    )
    const phc = rust.passwordHash(pw, salt, opts)
    expect(rust.passwordVerify(pw, phc)).toBe(true)
    expect(addon.passwordVerify(pw, phc)).toBe(true)

    // bcrypt embeds a random salt → verify-only cross-check both directions.
    const bc = rust.passwordHashBcrypt(pw, 4)
    expect(rust.passwordVerifyBcrypt(pw, bc)).toBe(true)
    expect(addon.passwordVerifyBcrypt(pw, bc)).toBe(true)
    const bc2 = addon.passwordHashBcrypt(pw, 4)
    expect(rust.passwordVerifyBcrypt(pw, bc2)).toBe(true)
  })

  test('PBKDF2 and AEAD match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    expect(
      Array.from(rust.pbkdf2Sha256(encoder.encode('password'), encoder.encode('salt'), 1, 32)),
    ).toEqual(
      Array.from(addon.pbkdf2Sha256(encoder.encode('password'), encoder.encode('salt'), 1, 32)),
    )

    const key = new Uint8Array(32).fill(0x42)
    const nonce = new Uint8Array(12).fill(0x07)
    const pt = encoder.encode('hello')
    // AES-256-GCM is deterministic given key+nonce+pt.
    expect(Array.from(rust.aeadEncrypt(key, nonce, pt))).toEqual(
      Array.from(addon.aeadEncrypt(key, nonce, pt)),
    )
    const ct = rust.aeadEncrypt(key, nonce, pt)
    const dec = rust.aeadDecrypt(key, nonce, ct)
    const decAddon = addon.aeadDecrypt(key, nonce, ct)
    expect(dec).not.toBeNull()
    expect(Array.from(dec!)).toEqual(Array.from(decAddon!))
    // ChaCha20-Poly1305.
    expect(Array.from(rust.aeadEncrypt(key, nonce, pt, 'chacha20-poly1305'))).toEqual(
      Array.from(addon.aeadEncrypt(key, nonce, pt, 'chacha20-poly1305')),
    )
  })

  test('compression and websocket frames match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const data = encoder.encode('hello hello hello '.repeat(20))
    expect(Array.from(rust.gzipCompress(data))).toEqual(Array.from(addon.gzipCompress(data)))
    const gz = rust.gzipCompress(data)
    expect(Array.from(rust.gzipDecompress(gz))).toEqual(Array.from(addon.gzipDecompress(gz)))
    expect(Array.from(rust.brotliCompress(data, 5))).toEqual(
      Array.from(addon.brotliCompress(data, 5)),
    )
    const br = rust.brotliCompress(data, 5)
    expect(Array.from(rust.brotliDecompress(br))).toEqual(Array.from(addon.brotliDecompress(br)))

    expect(Array.from(rust.wsFrameEncode(1, encoder.encode('hello'), true, true))).toEqual(
      Array.from(addon.wsFrameEncode(1, encoder.encode('hello'), true, true)),
    )
  })

  test('ws accept key + etag + packed parsers match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const wsKey = encoder.encode('dGhlIHNhbXBsZSBub25jZQ==')
    expect(Array.from(rust.wsAcceptKey(wsKey))).toEqual(Array.from(addon.wsAcceptKey(wsKey)))

    const data = encoder.encode('hello world')
    expect(Array.from(rust.etag(data))).toEqual(Array.from(addon.etag(data)))
    expect(Array.from(rust.etag(data, true))).toEqual(Array.from(addon.etag(data, true)))

    const req = encoder.encode('GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n')
    expect(Array.from(rust.httpParseRequestPacked(req))).toEqual(
      Array.from(addon.httpParseRequestPacked(req)),
    )
    expect(Array.from(rust.queryParsePacked(encoder.encode('a=1&b=2')))).toEqual(
      Array.from(addon.queryParsePacked(encoder.encode('a=1&b=2'))),
    )
    expect(Array.from(rust.cookieParsePacked(encoder.encode('a=1; b=2')))).toEqual(
      Array.from(addon.cookieParsePacked(encoder.encode('a=1; b=2'))),
    )
  })

  // ── Excluded-surface additions (jwt / ws decode / multipart / form / ingress) ──

  test('jwtSignBytes matches the napi addon byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const claims = encoder.encode(JSON.stringify({ sub: 'user-1', role: 'admin' }))
    const secret = encoder.encode('my-secret')
    const now = 1_700_000_000
    expect(Array.from(rust.jwtSignBytes(claims, secret, 60, now))).toEqual(
      Array.from(addon.jwtSignBytes(claims, secret, 60, now)),
    )
    // ttl null (no iat/exp injection) → deterministic.
    expect(Array.from(rust.jwtSignBytes(claims, secret, null, now))).toEqual(
      Array.from(addon.jwtSignBytes(claims, secret, null, now)),
    )
  })

  test('wsFrameDecode matches the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const cases: Array<[number, string, boolean, boolean]> = [
      [2, 'bin-payload', false, true],
      [9, 'ping', true, true],
      [8, '', false, true],
    ]
    for (const [opcode, payload, mask, fin] of cases) {
      const frame = rust.wsFrameEncode(opcode, encoder.encode(payload), mask, fin)
      const a = rust.wsFrameDecode(frame)
      const b = addon.wsFrameDecode(frame)
      expect(a).not.toBeNull()
      expect(a!.fin).toBe(b!.fin)
      expect(a!.opcode).toBe(b!.opcode)
      expect(Array.from(a!.payload)).toEqual(Array.from(b!.payload))
    }
    // Malformed → both null.
    expect(rust.wsFrameDecode(encoder.encode('\x80'))).toBeNull()
    expect(addon.wsFrameDecode(encoder.encode('\x80'))).toBeNull()
  })

  test('multipartParsePacked matches the napi addon byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const boundary = encoder.encode('----castrum')
    const body = encoder.encode(
      '------castrum\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n' +
        '------castrum\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
        '------castrum--',
    )
    expect(Array.from(rust.multipartParsePacked(body, boundary))).toEqual(
      Array.from(addon.multipartParsePacked(body, boundary)),
    )
  })

  test('formParsePacked matches the napi addon byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const body = encoder.encode('a=1&b=hello%20world&c=%C3%A9')
    expect(Array.from(rust.formParsePacked(body))).toEqual(Array.from(addon.formParsePacked(body)))
  })

  test('ingress handleRequestPacked matches the napi addon byte-for-byte (ffi handle)', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    const ffi = getBunFFI()!
    const handler = new addon.Ingress({ parseQuery: true, parseCookies: true })
    if (typeof handler.ingressInnerPtr !== 'function') {
      return // addon predates the ffi ingress handle — covered by the napi suite
    }
    const ptr = handler.ingressInnerPtr()
    expect(ptr).not.toBe(0n)

    const packer = new IngressInputPacker()
    const input = packer.pack(
      0,
      encoder.encode('/api/users?x=1&y=2'),
      encoder.encode('127.0.0.1'),
      encoder.encode('rid-12345'),
      new Uint8Array(0),
    )
    const body = encoder.encode('{"a":1}')

    const outN = new Uint8Array(4096)
    const wN = handler.handleRequestPacked(input, body, outN)
    const outF = new Uint8Array(4096)
    const wF = ffi.ingressHandlePacked(ptr, input, body, outF)
    expect(wF).toBe(wN)
    expect(Array.from(outF.subarray(0, wF))).toEqual(Array.from(outN.subarray(0, wN)))

    // Null body.
    const outN2 = new Uint8Array(4096)
    const wN2 = handler.handleRequestPacked(input, null, outN2)
    const outF2 = new Uint8Array(4096)
    const wF2 = ffi.ingressHandlePacked(ptr, input, null, outF2)
    expect(wF2).toBe(wN2)
    expect(Array.from(outF2.subarray(0, wF2))).toEqual(Array.from(outN2.subarray(0, wN2)))
  })

  // ── Reusable-output *Into variants (pooled buffers, no per-call alloc) ──

  test('*Into variants match their allocating siblings and throw on too-small', () => {
    if (!isBun() || getBunFFI() === null) {
      return // napi fallback path covered by the rest of the suite
    }
    const key = new Uint8Array(20).fill(0x0b)
    const data = encoder.encode('Hi There')

    const hm = new Uint8Array(64)
    expect(rust.hmacSha256Into(key, data, hm)).toBe(64)
    expect(Array.from(hm)).toEqual(Array.from(rust.hmacSha256(key, data)))

    const value = encoder.encode('session=abc')
    const secret = encoder.encode('secret-key')
    const sc = new Uint8Array(value.length + 65)
    expect(rust.signCookieInto(value, secret, sc)).toBe(value.length + 65)
    expect(Array.from(sc)).toEqual(Array.from(rust.signCookie(value, secret)))

    const aeadKey = new Uint8Array(32).fill(0x42)
    const nonce = new Uint8Array(12).fill(0x07)
    const ae = new Uint8Array(5 + 16)
    expect(rust.aeadEncryptInto(aeadKey, nonce, encoder.encode('hello'), ae)).toBe(21)
    expect(Array.from(ae)).toEqual(
      Array.from(rust.aeadEncrypt(aeadKey, nonce, encoder.encode('hello'))),
    )

    const wf = new Uint8Array(5 + 14)
    const wfw = rust.wsFrameEncodeInto(1, encoder.encode('hello'), true, true, wf)
    expect(wfw).toBeGreaterThan(0)
    const wfRef = rust.wsFrameEncode(1, encoder.encode('hello'), true, true)
    expect(Array.from(wf.subarray(0, wfw))).toEqual(Array.from(wfRef))

    const gz = new Uint8Array(1024)
    const gzw = rust.gzipCompressInto(encoder.encode('hello'), gz)
    expect(gzw).toBeGreaterThan(0)
    expect(Array.from(gz.subarray(0, gzw))).toEqual(
      Array.from(rust.gzipCompress(encoder.encode('hello'))),
    )

    const br = new Uint8Array(1024)
    const brw = rust.brotliCompressInto(encoder.encode('hello'), br)
    expect(brw).toBeGreaterThan(0)
    expect(Array.from(br.subarray(0, brw))).toEqual(
      Array.from(rust.brotliCompress(encoder.encode('hello'))),
    )

    // Too-small buffers throw (parity with the existing *Into contract).
    expect(() => rust.hmacSha256Into(key, data, new Uint8Array(8))).toThrow()
    expect(() => rust.signCookieInto(value, secret, new Uint8Array(8))).toThrow()
    expect(() => rust.aeadEncryptInto(aeadKey, nonce, encoder.encode('hello'), new Uint8Array(8))).toThrow()
    expect(() => rust.wsFrameEncodeInto(1, encoder.encode('hello'), true, true, new Uint8Array(4))).toThrow()
    expect(() => rust.gzipCompressInto(encoder.encode('hello'), new Uint8Array(2))).toThrow()
    expect(() => rust.brotliCompressInto(encoder.encode('hello'), new Uint8Array(2))).toThrow()
  })

  // ── FFI-backed create* instances (stateless C-ABI ops under Bun) ──

  test('FFI-backed create* instances match the napi instances byte-for-byte', () => {
    if (!isBun() || getBunFFI() === null) {
      return // napi path covered by the rest of the suite
    }
    const addon = getAddon()
    const key = new Uint8Array(20).fill(0x0b)
    const data = encoder.encode('Hi There')

    const ffiSigner = rust.createHmacSigner(key)
    const napiSigner = new addon.HmacSigner(key)
    expect(Array.from(ffiSigner.sign(data))).toEqual(Array.from(napiSigner.sign(data)))
    const hsig = ffiSigner.sign(data)
    expect(ffiSigner.verify(data, hsig)).toBe(true)
    expect(napiSigner.verify(data, hsig)).toBe(true)
    expect(ffiSigner.verify(data, new Uint8Array(64))).toBe(false)

    const ffiCodec = rust.createBase64Codec()
    const napiCodec = new addon.Base64Codec()
    expect(Array.from(ffiCodec.encode(data))).toEqual(Array.from(napiCodec.encode(data)))
    const b64 = ffiCodec.encode(data)
    expect(Array.from(ffiCodec.decode(b64))).toEqual(Array.from(napiCodec.decode(b64)))

    const secret = encoder.encode('secret-key')
    const value = encoder.encode('session=abc')
    const ffiCookie = rust.createCookieSigner(secret)
    const napiCookie = new addon.CookieSigner(secret)
    const signed = ffiCookie.sign(value)
    expect(Array.from(signed)).toEqual(Array.from(napiCookie.sign(value)))
    expect(Array.from(ffiCookie.verify(signed)!)).toEqual(Array.from(napiCookie.verify(signed)!))
    expect(ffiCookie.verify(encoder.encode('bad.sig'))).toBeNull()

    const ffiCsrf = rust.createCsrfProtector(secret)
    const napiCsrf = new addon.CsrfProtector(secret)
    const token = ffiCsrf.create()
    expect(ffiCsrf.verify(token)).toBe(true)
    expect(napiCsrf.verify(token)).toBe(true)
    expect(ffiCsrf.verify(encoder.encode('bad-token'))).toBe(false)

    const pw = encoder.encode('password123')
    const salt = encoder.encode('salt-salt-salt')
    const opts = { mCost: 8, tCost: 1, pCost: 1, outLen: 16 }
    const ffiHash = rust.createArgon2Hasher(opts)
    const napiHash = new addon.Argon2Hasher(opts)
    const phc = ffiHash.hash(pw, salt)
    expect(Array.from(phc)).toEqual(Array.from(napiHash.hash(pw, salt)))
    expect(ffiHash.verify(pw, phc)).toBe(true)

    const form = rust.createFormParser()
    const fInput = encoder.encode('a=1&b=2')
    const fPacked = form.parse(fInput)
    expect(fPacked[0]).toBe(2) // [u32 count] low byte == 2 pairs
    const fInto = new Uint8Array(64)
    const fw = form.parseInto(fInput, fInto)
    expect(fw).toBeGreaterThan(0)

    const aeadKey = new Uint8Array(32).fill(0x42)
    const nonce = new Uint8Array(12).fill(0x07)
    const ffiAead = rust.createAeadCipher(aeadKey)
    const napiAead = new addon.AeadCipher(aeadKey)
    const ct = ffiAead.encrypt(nonce, data)
    expect(Array.from(ct)).toEqual(Array.from(napiAead.encrypt(nonce, data)))
    expect(Array.from(ffiAead.decrypt(nonce, ct)!)).toEqual(Array.from(data))
  })

  // ── Transport introspection (FFI is PRIMARY on Bun; napi is the fallback) ──

  test('transport()/ffiActive() reflect the resolved transport', () => {
    const active = getBunFFI() !== null
    expect(rust.ffiActive()).toBe(active)
    expect(rust.transport()).toBe(active ? 'ffi' : 'napi')
  })

  test('ingress layout constants read via FFI match the napi addon', () => {
    if (!isBun() || getBunFFI() === null) return
    const addon = getAddon()
    // The constants module reads the layout via the C-ABI blob on Bun; it must
    // agree with the napi projection (both read the single source output.rs).
    expect(constants.OUT_VERDICT).toBe(addon.INGRESS_OUT_VERDICT)
    expect(constants.OUT_STATUS).toBe(addon.INGRESS_OUT_STATUS)
    expect(constants.OUT_DATA_START).toBe(addon.INGRESS_OUT_DATA_START)
    expect(constants.FLAG_HAS_COOKIES).toBe(addon.INGRESS_FLAG_HAS_COOKIES)
    expect(constants.HV_COUNT).toBe(addon.INGRESS_HV_COUNT)
    expect(constants.ERR_CODE_INTERNAL).toBe(addon.INGRESS_ERR_INTERNAL)
  })

  test('CASTRUM_FFI_MODE=napi forces the napi fallback on Bun', () => {
    if (!isBun()) return
    // The mode is read once at bind time and cached, so verify in a fresh
    // process (repo root so the addon resolves like a normal run).
    const code =
      "import { getBunFFI } from './src/native/ffi'; import { rust } from './index'; " +
      'console.log(getBunFFI() === null, rust.transport(), rust.ffiActive())'
    const res = spawnSync('bun', ['-e', code], {
      cwd: new URL('../../..', import.meta.url).pathname,
      env: { ...process.env, CASTRUM_FFI_MODE: 'napi' },
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    const [isNull, transport, active] = res.stdout!.trim().split(/\s+/)
    expect(isNull).toBe('true')
    expect(transport).toBe('napi')
    expect(active).toBe('false')
  })
})
