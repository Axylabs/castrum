/**
 * Property test: codec round-trips over seeded pseudo-random inputs.
 *
 * Data-integrity guard for the encoders/decoders on the public `rust.*`
 * surface: `encode∘decode == id` for hex, base64 (all configs) and the URL
 * codec, plus an EXHAUSTIVE all-256-bytes matrix. All PRNG draws are seeded
 * (./seeded.ts) so a failing case can be replayed deterministically.
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../src/rust-ffi'
import { seededRandom } from './seeded'

const rand = seededRandom()

function randBytes(max: number): Uint8Array {
  const b = new Uint8Array(Math.floor(rand() * max))
  for (let i = 0; i < b.length; i++) {
    b[i] = Math.floor(rand() * 256)
  }
  return b
}

function randAscii(max: number): string {
  // Unreserved + reserved URL characters, so urlEncode has something to do.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~!*'();:@&=+$,/?#[]%"
  let s = ''
  const len = Math.floor(rand() * max)
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(rand() * chars.length)] ?? ''
  }
  return s
}

function randUtf8Bytes(max: number): Uint8Array {
  // Random VALID UTF-8 text (ASCII + accented + CJK + emoji) so 2-4 byte
  // sequences are exercised. `urlEncode` has UTF-8 STRING semantics — a lone
  // 0x80-0xFF byte is an invalid sequence and is replaced with U+FFFD (matching
  // the Bun encodeURIComponent delegation), so byte-identity only holds for
  // valid UTF-8 byte strings.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~!*'();:@&=+$,/?#[]% éüñ 你好世界 🚀🎉"
  let s = ''
  const len = Math.floor(rand() * max)
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(rand() * chars.length)] ?? ''
  }
  return encoder.encode(s)
}

const encoder = new TextEncoder()

import { toBytes } from '../../src/shared/bytes'

describe('codec round-trips (property, seeded)', () => {
  test('hex: encode∘decode == id over random bytes', () => {
    for (let i = 0; i < 300; i++) {
      const input = randBytes(64)
      const enc = toBytes(rust.hexEncode(input))
      const dec = rust.hexDecode(enc)
      expect([...dec]).toEqual([...input])
    }
  })

  test('hex: decode∘encode == id over random even-length hex strings', () => {
    for (let i = 0; i < 200; i++) {
      const input = randBytes(32)
      const hex = rust.hexEncode(input)
      const dec = rust.hexDecode(toBytes(hex))
      expect(rust.hexEncode(dec)).toBe(hex)
    }
  })

  test('base64: encode∘decode == id for every config', () => {
    for (const urlSafe of [false, true]) {
      for (const padding of [false, true]) {
        for (let i = 0; i < 200; i++) {
          const input = randBytes(64)
          const enc = toBytes(rust.base64Encode(input, urlSafe, padding))
          const dec = rust.base64Decode(enc, urlSafe, padding)
          expect([...dec]).toEqual([...input])
        }
      }
    }
  })

  test('base64url: encode∘decode == id over random bytes', () => {
    for (let i = 0; i < 200; i++) {
      const input = randBytes(64)
      const enc = toBytes(rust.base64UrlEncode(input))
      const dec = rust.base64UrlDecode(enc)
      expect([...dec]).toEqual([...input])
    }
  })

  test('url: urlDecodeBytes(urlEncode(x)) == x over valid UTF-8 byte strings', () => {
    for (let i = 0; i < 300; i++) {
      const input = randUtf8Bytes(64)
      const enc = toBytes(rust.urlEncode(input))
      // Raw-bytes decode: urlEncode percent-encodes every non-unreserved byte of
      // the UTF-8 sequence, so decoding must reproduce the exact input bytes.
      const dec = rust.urlDecodeBytes(enc)
      expect([...dec]).toEqual([...input])
    }
  })

  test('url: urlDecode(urlEncode(x)) == x for UTF-8-valid ASCII inputs', () => {
    for (let i = 0; i < 200; i++) {
      const input = encoder.encode(randAscii(48))
      const enc = toBytes(rust.urlEncode(input))
      const dec = rust.urlDecode(enc)
      expect([...dec]).toEqual([...input])
    }
  })

  test('EXHAUSTIVE: every byte 0x00..0xFF round-trips through hex/base64; 0x00..0x7F through url', () => {
    for (let b = 0; b < 256; b++) {
      const one = new Uint8Array([b])
      expect([...rust.hexDecode(toBytes(rust.hexEncode(one)))]).toEqual([b])
      expect([...rust.base64Decode(toBytes(rust.base64Encode(one)))]).toEqual([b])
      expect([...rust.base64UrlDecode(toBytes(rust.base64UrlEncode(one)))]).toEqual([b])
    }
    // urlEncode has UTF-8 STRING semantics (a lone 0x80-0xFF byte is replaced
    // with U+FFFD), so byte-identity via urlEncode only holds for ASCII.
    for (let b = 0; b < 0x80; b++) {
      const one = new Uint8Array([b])
      expect([...rust.urlDecodeBytes(toBytes(rust.urlEncode(one)))]).toEqual([b])
    }
  })

  test('empty inputs round-trip to empty (no spurious output)', () => {
    const empty = new Uint8Array(0)
    expect(rust.hexDecode(toBytes(rust.hexEncode(empty))).length).toBe(0)
    expect(rust.base64Decode(toBytes(rust.base64Encode(empty))).length).toBe(0)
    expect(rust.base64UrlDecode(toBytes(rust.base64UrlEncode(empty))).length).toBe(0)
    expect(rust.urlDecodeBytes(toBytes(rust.urlEncode(empty))).length).toBe(0)
  })
})
