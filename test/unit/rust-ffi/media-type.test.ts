/**
 * Tests for the Rust media-type FFI: `rust.parseMediaType` and
 * `rust.createMediaTypeParser` (higher-order instance) — cross-checked against
 * the hand-rolled JS baseline.
 */

import { describe, expect, test } from 'bun:test'
import {
  nativeMediaTypeMatches,
  nativeParseMediaType,
} from '../../../src/bench/media-type-baseline'
import { getBunFFI } from '../../../src/native/ffi'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'

const JSON_CT = encoder.encode('application/json; charset=utf-8')
const MULTIPART_CT = encoder.encode(
  'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW',
)

describe('rust.parseMediaType', () => {
  test('parses essence + params matching the JS baseline', () => {
    for (const header of [JSON_CT, MULTIPART_CT]) {
      const rustM = rust.parseMediaType(header)
      const nativeM = nativeParseMediaType(decoder.decode(header))
      expect(rustM.mediaType).toBe(nativeM.mediaType)
      expect(rustM.params).toEqual(nativeM.params)
    }
  })

  test('exposes charset and boundary', () => {
    const json = rust.parseMediaType(JSON_CT)
    expect(json.charset).toBe('utf-8')
    expect(json.boundary).toBeNull()
    const mp = rust.parseMediaType(MULTIPART_CT)
    expect(mp.boundary).toBe('----WebKitFormBoundary7MA4YWxkTrZu0gW')
    expect(mp.charset).toBeNull()
  })

  test('retains independent results with Unicode and empty quoted parameters', () => {
    const first = rust.parseMediaType(
      encoder.encode('text/plain; charset=""; boundary="界😀"; note="café"'),
    )
    rust.parseMediaType(MULTIPART_CT)
    expect(first).toEqual({
      mediaType: 'text/plain',
      charset: '',
      boundary: '界😀',
      params: { charset: '', boundary: '界😀', note: 'café' },
    })
    first.params.boundary = 'changed'
    expect(first.boundary).toBe('界😀')
    expect(rust.parseMediaType(encoder.encode('text/plain')).params).toEqual({})
  })

  test('preserves FFI first summary and last parameter values for duplicates', () => {
    if (!getBunFFI()) return // napi has a different existing duplicate-summary policy.
    const result = rust.parseMediaType(
      encoder.encode('text/plain; charset=""; charset=UTF-8; boundary="界"; boundary=last'),
    )
    expect(result.charset).toBe('')
    expect(result.boundary).toBe('界')
    expect(result.params).toEqual({ charset: 'UTF-8', boundary: 'last' })
  })

  test('lowercases type/subtype and param names', () => {
    const m = rust.parseMediaType(encoder.encode('Application/JSON; Charset=UTF-8'))
    expect(m.mediaType).toBe('application/json')
    expect(m.params.charset).toBe('UTF-8')
  })
})

describe('MediaTypeMatcher (higher-order instance)', () => {
  test('wildcard parity with the JS baseline', () => {
    const actual = 'application/json'
    for (const expected of [
      'application/json',
      'application/*',
      '*/*',
      'text/*',
      'application/xml',
    ]) {
      const matcher = rust.createMediaTypeMatcher(encoder.encode(expected))
      expect(matcher.matches(encoder.encode(actual))).toBe(nativeMediaTypeMatches(actual, expected))
    }
  })
})
