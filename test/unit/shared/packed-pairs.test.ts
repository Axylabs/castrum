/**
 * Tests for the pair/parser helpers in src/shared/packed.ts.
 *
 * Split from packed.test.ts (which covers the packBatch/unpack* primitives):
 * `packPairs` / `readPairsPacked` (zero-alloc packed pair round-trip) and the
 * ergonomic string parsers `pairsToObject` / `parseQueryString` /
 * `parseCookieHeader` that sit on top of the packed-pair wire format.
 */

import { describe, expect, test } from 'bun:test'
import {
  packPairs,
  pairsToObject,
  parseCookieHeader,
  parseQueryString,
  readPairsPacked,
} from '../../../src/shared/packed'

describe('packPairs / readPairsPacked', () => {
  test('roundtrips pairs', () => {
    const packed = packPairs([
      ['a', '1'],
      ['b', 'hello world'],
    ])
    expect(readPairsPacked(packed)).toEqual([
      ['a', '1'],
      ['b', 'hello world'],
    ])
  })

  test('handles empty input', () => {
    expect(readPairsPacked(packPairs([]))).toEqual([])
    expect(readPairsPacked(new Uint8Array(0))).toEqual([])
  })
})

describe('pairsToObject', () => {
  test('last-wins for unique keys, arrays for duplicates', () => {
    expect(
      pairsToObject([
        ['x', '1'],
        ['x', '2'],
        ['y', '3'],
      ]),
    ).toEqual({
      x: ['1', '2'],
      y: '3',
    })
  })
})

describe('parseQueryString / parseCookieHeader', () => {
  test('parses query string with decoding and duplicate keys', () => {
    expect(parseQueryString('a=1&b=2&name=John%20Doe&tag=a&tag=b')).toEqual({
      a: '1',
      b: '2',
      name: 'John Doe',
      tag: ['a', 'b'],
    })
  })

  test('parses cookie header', () => {
    expect(parseCookieHeader('session=abc123; theme=dark')).toEqual({
      session: 'abc123',
      theme: 'dark',
    })
  })

  test('empty inputs yield empty objects', () => {
    expect(parseQueryString('')).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
  })
})
