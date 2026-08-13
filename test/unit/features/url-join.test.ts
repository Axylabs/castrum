/**
 * Tests for the Rust URL-building FFI: `rust.urlResolve`, `rust.urlEncodeQuery`,
 * and `rust.createUrlBuilder` (higher-order instance) — cross-checked against
 * the WHATWG URL baseline.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'
import { nativeUrlEncodeQuery, nativeUrlResolve } from '../../../src/bench/url-join-baseline'

const BASE = encoder.encode('http://example.com/api/users?page=1')

const REFS = [
  'v2/items/42?active=true#top',
  '../../../g',
  '?y',
  '#frag',
  'http://other.example/x',
  '//cdn.example/img.png',
]

describe('rust.urlResolve', () => {
  test('matches the WHATWG URL baseline', () => {
    for (const ref of REFS) {
      const refBytes = encoder.encode(ref)
      expect(decoder.decode(rust.urlResolve(BASE, refBytes))).toBe(
        decoder.decode(nativeUrlResolve(BASE, refBytes)),
      )
    }
  })
})

describe('UrlBuilder (higher-order instance)', () => {
  const builder = rust.createUrlBuilder(BASE)

  test('base parsed once, reused across resolves', () => {
    for (const ref of REFS) {
      const refBytes = encoder.encode(ref)
      expect(decoder.decode(builder.resolve(refBytes))).toBe(
        decoder.decode(nativeUrlResolve(BASE, refBytes)),
      )
    }
  })
})

describe('rust.urlEncodeQuery', () => {
  test('matches the encodeURIComponent baseline (sorted keys)', () => {
    const params = { q: 'hello world', page: '2', tag: 'a b' }
    expect(decoder.decode(rust.urlEncodeQuery(params))).toBe(
      decoder.decode(nativeUrlEncodeQuery(params)),
    )
  })
})
