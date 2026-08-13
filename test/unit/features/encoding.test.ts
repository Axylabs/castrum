/**
 * Tests for the Rust encoding FFI: `rust.base64Encode/Decode`,
 * `rust.base64urlEncode/Decode`, `rust.hexEncode/Decode`, and
 * `rust.createBase64Codec` (higher-order instance) — cross-checked against
 * the Buffer baseline.
 */

import { describe, test, expect } from 'bun:test'
import { Buffer } from 'node:buffer'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'
import { nativeHexDecode, nativeHexEncode } from '../../../src/bench/encoding-baseline'

const DATA = new Uint8Array([104, 105, 0, 255, 32, 64, 126, 10]) // "hi\0\xff @~\n"

describe('base64', () => {
  test('encode matches Buffer baseline', () => {
    expect(Array.from(rust.base64Encode(DATA))).toEqual(
      Array.from(encoder.encode(Buffer.from(DATA).toString('base64'))),
    )
    expect(Array.from(rust.base64UrlEncode(DATA))).toEqual(
      Array.from(encoder.encode(Buffer.from(DATA).toString('base64url'))),
    )
  })

  test('decode roundtrips byte-for-byte', () => {
    const enc = rust.base64Encode(DATA)
    expect(Array.from(rust.base64Decode(enc))).toEqual(Array.from(DATA))
  })

  test('decode throws on invalid input', () => {
    expect(() => rust.base64Decode(encoder.encode('!!!'))).toThrow()
  })

  test('Base64Codec instance (url-safe, no pad)', () => {
    const codec = rust.createBase64Codec(true, false)
    expect(decoder.decode(codec.encode(DATA))).toBe(Buffer.from(DATA).toString('base64url'))
    expect(Array.from(codec.decode(codec.encode(DATA)))).toEqual(Array.from(DATA))
  })
})

describe('hex', () => {
  test('encode matches Buffer baseline', () => {
    expect(Array.from(rust.hexEncode(DATA))).toEqual(Array.from(nativeHexEncode(DATA)))
  })

  test('decode roundtrips byte-for-byte', () => {
    const enc = decoder.decode(rust.hexEncode(DATA))
    expect(Array.from(rust.hexDecode(encoder.encode(enc)))).toEqual(Array.from(DATA))
    expect(Array.from(rust.hexDecode(nativeHexEncode(DATA)))).toEqual(
      Array.from(nativeHexDecode(nativeHexEncode(DATA))),
    )
  })

  test('decode throws on odd length and bad digits', () => {
    expect(() => rust.hexDecode(encoder.encode('abc'))).toThrow()
    expect(() => rust.hexDecode(encoder.encode('zz'))).toThrow()
  })
})

describe('rust.batch hex/base64 (packed batch)', () => {
  test('hexEncode batch matches the scalar per item', () => {
    const items = [DATA, encoder.encode('abc')]
    const results = rust.batch.hexEncode(items)
    expect(results.length).toBe(2)
    expect(Array.from(results[0])).toEqual(Array.from(rust.hexEncode(DATA)))
    expect(Array.from(results[1])).toEqual(Array.from(rust.hexEncode(encoder.encode('abc'))))
  })

  test('hexDecode batch roundtrips byte-for-byte', () => {
    const items = [rust.hexEncode(DATA), rust.hexEncode(encoder.encode('xyz'))]
    const results = rust.batch.hexDecode(items)
    expect(Array.from(results[0])).toEqual(Array.from(DATA))
    expect(Array.from(results[1])).toEqual(Array.from(encoder.encode('xyz')))
  })

  test('base64Encode batch matches the scalar per item', () => {
    const items = [DATA, encoder.encode('abc')]
    const results = rust.batch.base64Encode(items)
    expect(results.length).toBe(2)
    expect(Array.from(results[0])).toEqual(Array.from(rust.base64Encode(DATA)))
    expect(Array.from(results[1])).toEqual(Array.from(rust.base64Encode(encoder.encode('abc'))))
  })

  test('base64Decode batch roundtrips byte-for-byte', () => {
    const items = [rust.base64Encode(DATA), rust.base64Encode(encoder.encode('xyz'))]
    const results = rust.batch.base64Decode(items)
    expect(Array.from(results[0])).toEqual(Array.from(DATA))
    expect(Array.from(results[1])).toEqual(Array.from(encoder.encode('xyz')))
  })

  test('base64 batch respects url-safe / no-padding config', () => {
    const items = [new Uint8Array([0xfb])]
    const std = rust.batch.base64Encode(items, false, true)
    const url = rust.batch.base64Encode(items, true, false)
    expect(Array.from(url[0])).toEqual(Array.from(encoder.encode('-w')))
    expect(Array.from(std[0])).toEqual(Array.from(rust.base64Encode(new Uint8Array([0xfb]))))
  })
})

describe('reusable-output (_into) variants', () => {
  test('hexEncodeInto matches hexEncode byte-for-byte', () => {
    const out = new Uint8Array(DATA.length * 2)
    const written = rust.hexEncodeInto(DATA, out)
    const expected = rust.hexEncode(DATA)
    expect(written).toBe(expected.length)
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected))
  })

  test('hexDecodeInto roundtrips byte-for-byte', () => {
    const enc = rust.hexEncode(DATA)
    const out = new Uint8Array(DATA.length)
    const written = rust.hexDecodeInto(enc, out)
    expect(written).toBe(DATA.length)
    expect(out.slice(0, written)).toEqual(DATA)
  })

  test('hexDecodeInto throws on odd length and bad digits', () => {
    expect(() => rust.hexDecodeInto(encoder.encode('abc'), new Uint8Array(4))).toThrow()
    expect(() => rust.hexDecodeInto(encoder.encode('zz'), new Uint8Array(4))).toThrow()
  })

  test('base64EncodeInto matches base64Encode', () => {
    const out = new Uint8Array(64)
    const written = rust.base64EncodeInto(DATA, out)
    const expected = rust.base64Encode(DATA)
    expect(written).toBe(expected.length)
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected))
  })

  test('base64DecodeInto roundtrips byte-for-byte', () => {
    const enc = rust.base64Encode(DATA)
    const out = new Uint8Array(DATA.length)
    const written = rust.base64DecodeInto(enc, out)
    expect(written).toBe(DATA.length)
    expect(out.slice(0, written)).toEqual(DATA)
  })

  test('base64DecodeInto throws on invalid input', () => {
    expect(() => rust.base64DecodeInto(encoder.encode('!!!'), new Uint8Array(16))).toThrow()
  })

  test('too-small output buffer throws', () => {
    expect(() => rust.hexEncodeInto(DATA, new Uint8Array(2))).toThrow()
    expect(() => rust.hexDecodeInto(rust.hexEncode(DATA), new Uint8Array(1))).toThrow()
    expect(() => rust.base64EncodeInto(DATA, new Uint8Array(2))).toThrow()
    expect(() => rust.base64DecodeInto(rust.base64Encode(DATA), new Uint8Array(1))).toThrow()
  })

  test('urlEncodeInto matches urlEncode', () => {
    const src = encoder.encode('a b&c=d')
    const out = new Uint8Array(32)
    const written = rust.urlEncodeInto(src, out)
    const expected = rust.urlEncode(src)
    expect(written).toBe(expected.length)
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected))
  })

  test('urlDecodeInto matches urlDecode', () => {
    const src = encoder.encode('a%20b%26c%3Dd')
    const out = new Uint8Array(16)
    const written = rust.urlDecodeInto(src, out)
    const expected = rust.urlDecode(src)
    expect(written).toBe(expected.length)
    expect(Array.from(out.slice(0, written))).toEqual(Array.from(expected))
  })
})
