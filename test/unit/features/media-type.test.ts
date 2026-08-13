/**
 * Tests for the Rust media-type FFI: `rust.parseMediaType` and
 * `rust.createMediaTypeParser` (higher-order instance) — cross-checked against
 * the hand-rolled JS baseline.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'
import {
  nativeMediaTypeMatches,
  nativeParseMediaType,
} from '../../../src/bench/media-type-baseline'

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

  test('lowercases type/subtype and param names', () => {
    const m = rust.parseMediaType(encoder.encode('Application/JSON; Charset=UTF-8'))
    expect(m.mediaType).toBe('application/json')
    expect(m.params.charset).toBe('UTF-8')
  })
})

describe('MediaTypeParser (higher-order instance)', () => {
  test('matches wildcards', () => {
    const parser = rust.createMediaTypeParser()
    expect(parser.matches(JSON_CT, JSON_CT)).toBe(true)
    expect(parser.matches(JSON_CT, encoder.encode('application/*'))).toBe(true)
    expect(parser.matches(JSON_CT, encoder.encode('*/*'))).toBe(true)
    expect(parser.matches(JSON_CT, encoder.encode('text/*'))).toBe(false)
    expect(parser.matches(JSON_CT, encoder.encode('application/xml'))).toBe(false)
  })

  test('matches parity with the JS baseline', () => {
    const parser = rust.createMediaTypeParser()
    const actual = 'application/json'
    for (const expected of [
      'application/json',
      'application/*',
      '*/*',
      'text/*',
      'application/xml',
    ]) {
      expect(parser.matches(encoder.encode(actual), encoder.encode(expected))).toBe(
        nativeMediaTypeMatches(actual, expected),
      )
    }
  })
})
