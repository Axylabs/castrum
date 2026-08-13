/**
 * Empty-input matrix: every scalar op on the public `rust.*` surface that can
 * accept an empty `Uint8Array` must behave consistently — no throw, empty
 * round-trips, validators/hashers return their documented "nothing" result.
 *
 * This closes the audit gap where empty-input behavior was only covered
 * inline in individual tests (or not at all for some ops).
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { getBunFFI } from '../../../src/native/ffi'

const empty = new Uint8Array(0)
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('empty-input matrix', () => {
  test('encoders accept empty and round-trip to empty', () => {
    expect(rust.hexDecode(rust.hexEncode(empty)).length).toBe(0)
    expect(rust.base64Decode(rust.base64Encode(empty)).length).toBe(0)
    expect(rust.base64UrlDecode(rust.base64UrlEncode(empty)).length).toBe(0)
    expect(rust.urlDecodeBytes(rust.urlEncode(empty)).length).toBe(0)
  })

  test('decoders accept empty without throwing', () => {
    expect(() => rust.hexDecode(empty)).not.toThrow()
    expect(() => rust.base64Decode(empty)).not.toThrow()
    expect(() => rust.urlDecode(empty)).not.toThrow()
    expect(() => rust.urlDecodeBytes(empty)).not.toThrow()
  })

  test('validators reject empty input', () => {
    expect(rust.validateEmail(empty)).toBe(false)
    expect(rust.validateUuid(empty)).toBe(false)
    expect(rust.validateIpv4(empty)).toBe(false)
    expect(rust.validateIpv6(empty)).toBe(false)
    expect(rust.jsonValid(empty)).toBe(false)
  })

  test('hashers/codecs accept empty without throwing', () => {
    expect(() => rust.crc32(empty)).not.toThrow()
    expect(() => rust.fnv1a64(empty)).not.toThrow()
    expect(() => rust.xxh3(empty)).not.toThrow()
    expect(() => rust.hmacSha256(empty, enc('key'))).not.toThrow()
    expect(() => rust.wsAcceptKey(empty)).not.toThrow()
    expect(() => rust.etag(empty)).not.toThrow()
  })

  test('compress of empty never throws; decompress round-trips (or ffi 0-byte divergence)', () => {
    const ffi = getBunFFI()
    const gz = rust.gzipCompress(empty) // compress side must never throw
    expect(gz.length).toBeGreaterThan(0)
    const br = rust.brotliCompress(empty)
    expect(br.length).toBeGreaterThan(0)

    if (ffi !== null) {
      // DOCUMENTED ffi divergence (see src/native/ffi.ts header): a stream
      // that decompresses to exactly 0 bytes is indistinguishable from "too
      // small" in the C ABI, so the wrapper throws — contained, never a wrong
      // result. napi returns an empty buffer. Both are pinned here.
      expect(() => rust.gzipDecompress(gz)).toThrow()
      expect(() => rust.brotliDecompress(br)).toThrow()
    } else {
      expect(rust.gzipDecompress(gz).length).toBe(0)
      expect(rust.brotliDecompress(br).length).toBe(0)
    }
  })

  test('security verify ops reject empty', () => {
    expect(rust.verifyCookie(empty, enc('secret'))).toBeNull()
    expect(rust.csrfVerify(empty, enc('secret'))).toBe(false)
    expect(
      rust.passwordVerify(
        empty,
        enc('$argon2id$v=19$m=8,t=1,p=1$c2FsdHktc2FsdC0xNmI$AAAAAAAAAAAAAAAAAAAAAA'),
      ),
    ).toBe(false)
    expect(
      rust.passwordVerifyBcrypt(
        empty,
        '$2b$04$0123456789012345678901u2aY8dYU7v1mKqKbFh0LqY8n1vWq7yO',
      ),
    ).toBe(false)
  })

  test('packed parsers accept empty without throwing', () => {
    expect(() => rust.queryParsePacked(empty)).not.toThrow()
    expect(() => rust.cookieParsePacked(empty)).not.toThrow()
    expect(() => rust.httpParseRequestPacked(empty)).not.toThrow()
    expect(() => rust.multipartParsePacked(empty, enc('boundary'))).not.toThrow()
  })
})
