/**
 * Tests for the Rust form-urlencoded FFI: `rust.formParsePacked`,
 * `rust.createFormParser` (higher-order instance), `rust.batch.formParse`,
 * and the `parseFormBody` helper — cross-checked against URLSearchParams.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'
import { pairsToObject, parseFormBody, readPairsPacked } from '../../../src/shared/packed'
import { nativeFormParsePacked } from '../../../src/bench/form-baseline'

const BODY = encoder.encode('name=John+Doe&email=john%40example.com&age=30&tags=a&tags=b&empty=')

describe('rust.formParsePacked', () => {
  test('parses to pairs matching URLSearchParams', () => {
    const rustObj = pairsToObject(readPairsPacked(rust.formParsePacked(BODY)))
    const nativeObj = pairsToObject(readPairsPacked(nativeFormParsePacked(BODY)))
    expect(rustObj).toEqual(nativeObj)
    expect(rustObj.name).toBe('John Doe')
    expect(rustObj.email).toBe('john@example.com')
    expect(rustObj.tags).toEqual(['a', 'b'])
    expect(rustObj.empty).toBe('')
  })

  test('throws on malformed percent encoding', () => {
    expect(() => rust.formParsePacked(encoder.encode('a=%ZZ'))).toThrow()
  })

  test('handles empty body', () => {
    expect(pairsToObject(readPairsPacked(rust.formParsePacked(new Uint8Array(0))))).toEqual({})
  })
})

describe('FormParser (higher-order instance)', () => {
  test('reuses the instance across parses', () => {
    const parser = rust.createFormParser(256)
    const first = pairsToObject(readPairsPacked(parser.parse(BODY)))
    const second = pairsToObject(readPairsPacked(parser.parse(BODY)))
    expect(first).toEqual(second)
    expect(first.name).toBe('John Doe')
  })

  test('parseInto writes into a caller-provided buffer', () => {
    const parser = rust.createFormParser(256)
    const out = new Uint8Array(4096)
    const written = parser.parseInto(BODY, out)
    const pairs = readPairsPacked(out.subarray(0, written))
    expect(pairs).toContainEqual(['name', 'John Doe'])
  })
})

describe('rust.batch.formParse', () => {
  test('returns one packed result per input body', () => {
    const bodies = [BODY, encoder.encode('x=1'), encoder.encode('a=b&c=d')]
    const results = rust.batch.formParse(bodies)
    expect(results.length).toBe(3)
    expect(pairsToObject(readPairsPacked(results[2]))).toEqual({
      a: 'b',
      c: 'd',
    })
  })
})

describe('parseFormBody helper', () => {
  test('returns a key/value object', () => {
    expect(parseFormBody(BODY)).toEqual({
      name: 'John Doe',
      email: 'john@example.com',
      age: '30',
      tags: ['a', 'b'],
      empty: '',
    })
  })
})
