/**
 * Tests for src/shared/codec.ts (runtime-native UTF-8 codec).
 *
 * Under Bun this exercises the native transfer paths (Bun.ArrayBufferSink for
 * encode, zero-copy Buffer-view write for encodeInto, bun:ffi CString for
 * decode). The critical cases are:
 * - CString decode must read EXACTLY `byteLength` bytes — an interior NUL byte
 *   must NOT truncate the string.
 * - encodeUtf8Into must not write past the end of the destination and must not
 *   split a multibyte character.
 * - Round-trips for ASCII / multi-byte / emoji.
 */

import { describe, expect, test } from 'bun:test'
import { decodeUtf8, decodeUtf8Range, encodeUtf8, encodeUtf8Into } from '../../../src/shared/codec'

describe('encodeUtf8', () => {
  test('encodes ASCII', () => {
    expect([...encodeUtf8('hello')]).toEqual([104, 101, 108, 108, 111])
  })

  test('encodes multi-byte + emoji (4-byte UTF-8)', () => {
    const bytes = encodeUtf8('héllo 🚀')
    expect(encodeUtf8('é').byteLength).toBe(2)
    expect(encodeUtf8('🚀').byteLength).toBe(4)
    expect(decodeUtf8(bytes)).toBe('héllo 🚀')
  })

  test('encodes empty string', () => {
    expect(encodeUtf8('').byteLength).toBe(0)
  })
})

describe('decodeUtf8', () => {
  test('decodes ASCII bytes', () => {
    expect(decodeUtf8(new Uint8Array([104, 105]))).toBe('hi')
  })

  test('decodes an interior NUL byte WITHOUT truncation (exact-length CString)', () => {
    // "a\0b" — a NUL-terminated C-string read would stop at the NUL; the
    // exact-length codec must preserve all three bytes.
    const bytes = new Uint8Array([97, 0, 98])
    expect(decodeUtf8(bytes)).toBe('a\u0000b')
  })

  test('round-trips arbitrary bytes (incl. NUL)', () => {
    const raw = 'v=1\u0000next\u0000done'
    const bytes = encodeUtf8(raw)
    expect(decodeUtf8(bytes)).toBe(raw)
  })

  test('decodes empty bytes', () => {
    expect(decodeUtf8(new Uint8Array(0))).toBe('')
  })

  test('decodes a subarray view', () => {
    const full = encodeUtf8('hello world')
    expect(decodeUtf8(full.subarray(6, 11))).toBe('world')
  })
})

describe('encodeUtf8Into', () => {
  test('writes at offset 0 and returns bytes written', () => {
    const out = new Uint8Array(8)
    const w = encodeUtf8Into('hi', out)
    expect(w).toBe(2)
    expect([...out.subarray(0, 2)]).toEqual([104, 105])
  })

  test('writes at a nonzero offset', () => {
    const out = new Uint8Array(8)
    const w = encodeUtf8Into('hi', out, 4)
    expect(w).toBe(2)
    expect(out[3]).toBe(0)
    expect([...out.subarray(4, 6)]).toEqual([104, 105])
  })

  test('never writes past the end of the destination', () => {
    const out = new Uint8Array(3)
    const w = encodeUtf8Into('hello', out)
    expect(w).toBeLessThanOrEqual(3)
    // Whatever fits is valid prefix bytes.
    expect(decodeUtf8(out.subarray(0, w))).toBe('hel')
  })

  test('does not split a multibyte character at the boundary', () => {
    const out = new Uint8Array(3) // "hé" is 3 bytes (h + 2-byte é) — fits; "hél" is 4
    const w = encodeUtf8Into('hé', out)
    expect(w).toBe(3)
    expect(decodeUtf8(out.subarray(0, w))).toBe('hé')
  })

  test('matches encode().length for full-fit writes', () => {
    const s = 'hello world'
    const out = new Uint8Array(s.length * 2)
    const w = encodeUtf8Into(s, out)
    expect(w).toBe(encodeUtf8(s).byteLength)
  })
})

describe('decodeUtf8Range', () => {
  const E = (s: string): Uint8Array => encodeUtf8(s)

  test('decodes an ASCII range via the latin1 fast path', () => {
    const bytes = E('\x00multipart/form-data\x00charset')
    expect(decodeUtf8Range(bytes, 1, 20)).toBe('multipart/form-data')
    expect(decodeUtf8Range(bytes, 21, 28)).toBe('charset')
  })

  test('falls back to real UTF-8 decoding for multi-byte ranges', () => {
    const s = 'héllo→世界'
    const bytes = new Uint8Array(4 + E(s).byteLength + 2)
    bytes.set(E(s), 4)
    expect(decodeUtf8Range(bytes, 4, 4 + E(s).byteLength)).toBe(s)
  })

  test('handles mixed ASCII + multi-byte in one range', () => {
    const mixed = 'a=é=b'
    const bytes = E(`prefix${mixed}suffix`)
    expect(decodeUtf8Range(bytes, 6, 6 + E(mixed).byteLength)).toBe(mixed)
  })

  test('empty range → empty string', () => {
    expect(decodeUtf8Range(E('abc'), 1, 1)).toBe('')
  })
})
