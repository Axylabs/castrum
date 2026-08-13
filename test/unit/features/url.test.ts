/**
 * Tests for the Rust URL FFI: `rust.urlEncode/urlDecode/urlDecodeBytes`
 * (scalar + text namespace) — percent-encoding (rust/http/url_codec.rs),
 * including unicode and raw-byte (`%FF`) round-trips.
 */

import { describe, test, expect } from 'bun:test'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'

describe('urlEncode / urlDecode', () => {
  test('encodes reserved characters', () => {
    expect(decoder.decode(rust.urlEncode(encoder.encode('a b&c=d')))).toBe('a%20b%26c%3Dd')
  })

  test('decodes percent-encoded input', () => {
    expect(decoder.decode(rust.urlDecode(encoder.encode('a%20b%26c%3Dd')))).toBe('a b&c=d')
  })

  test('encode → decode round-trips text incl. unicode', () => {
    const inputs = [
      'plain',
      'with space and + plus',
      'héllo wörld',
      'emoji 🚀 test',
      'reserved /?:@&=+$,#%',
    ]
    for (const input of inputs) {
      const enc = rust.urlEncode(encoder.encode(input))
      expect(decoder.decode(rust.urlDecode(enc))).toBe(input)
    }
  })

  test('text namespace (string in / string out)', () => {
    expect(rust.text.urlEncode('a b')).toBe('a%20b')
    expect(rust.text.urlDecode('a%20b')).toBe('a b')
  })

  test('urlDecodeBytes preserves raw non-UTF-8 bytes', () => {
    // `%FF` must decode to a raw 0xFF byte, not throw on invalid UTF-8.
    const out = rust.urlDecodeBytes(encoder.encode('a=%FF'))
    expect(Array.from(out)).toEqual([97, 61, 255])
  })

  test('reusable-output variants agree with allocating', () => {
    const input = encoder.encode('a b&c=d')
    const alloc = rust.urlEncode(input)
    const out = new Uint8Array(alloc.byteLength + 16)
    const written = rust.urlEncodeInto(input, out)
    expect(written).toBe(alloc.byteLength)
    expect(Array.from(out.subarray(0, written))).toEqual(Array.from(alloc))

    const decOut = new Uint8Array(input.byteLength + 16)
    const decWritten = rust.urlDecodeInto(alloc, decOut)
    expect(Array.from(decOut.subarray(0, decWritten))).toEqual(Array.from(input))
  })

  test('malformed percent-encoding in urlDecode throws', () => {
    expect(() => rust.urlDecode(encoder.encode('%ZZ'))).toThrow()
  })

  test('Bun-builtin binding matches the napi addon byte-for-byte', () => {
    // Under Bun, rust.urlEncode/urlDecode delegate to encodeURIComponent/
    // decodeURIComponent (skipping the FFI crossing); this pins byte-parity
    // with the napi transport so the two can never drift.
    const addon = getAddon()
    if (!addon) return
    const inputs = ['a b&c=d', 'héllo wörld', 'emoji 🚀 test', 'reserved /?:@&=+$,#%', "~!*'()_-.0"]
    for (const input of inputs) {
      const bytes = encoder.encode(input)
      expect(Array.from(rust.urlEncode(bytes))).toEqual(Array.from(addon.urlEncode(bytes)))
      const encoded = addon.urlEncode(bytes)
      expect(Array.from(rust.urlDecode(encoded))).toEqual(Array.from(addon.urlDecode(encoded)))
    }
  })

  test('text namespace Bun-binding matches the napi addon', () => {
    const addon = getAddon()
    if (!addon) return
    for (const input of ['a b&c=d', 'héllo 🚀', "~!*'()"]) {
      expect(rust.text.urlEncode(input)).toBe(
        decoder.decode(addon.urlEncode(encoder.encode(input))),
      )
      expect(rust.text.urlDecode('a%20b%26c%3Dd')).toBe(
        decoder.decode(addon.urlDecode(encoder.encode('a%20b%26c%3Dd'))),
      )
    }
  })
})
