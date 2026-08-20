/**
 * Tests for src/shared/bytes.ts
 *
 * Covers:
 * - encoder (TextEncoder) output
 * - decoder (TextDecoder) output
 * - toPlainBuffer copy semantics
 */

import { describe, expect, test } from 'bun:test'
import { decoder, encoder, toPlainBuffer } from '../../../src/shared/bytes'

describe('encoder', () => {
  test('encodes ASCII string to Uint8Array', () => {
    const result = encoder.encode('hello')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.byteLength).toBe(5)
    expect([...result]).toEqual([104, 101, 108, 108, 111])
  })

  test('encodes empty string', () => {
    const result = encoder.encode('')
    expect(result.byteLength).toBe(0)
  })

  test('encodes UTF-8 multi-byte characters', () => {
    const result = encoder.encode('héllo')
    // é is 2 bytes in UTF-8
    expect(result.byteLength).toBe(6)
  })

  test('encodes emoji (4-byte UTF-8)', () => {
    const result = encoder.encode('🚀')
    expect(result.byteLength).toBe(4)
  })
})

describe('decoder', () => {
  test('decodes ASCII bytes to string', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111])
    expect(decoder.decode(bytes)).toBe('hello')
  })

  test('decodes empty bytes', () => {
    expect(decoder.decode(new Uint8Array(0))).toBe('')
  })

  test('decodes UTF-8 multi-byte characters', () => {
    const bytes = encoder.encode('héllo 🚀')
    const decoded = decoder.decode(bytes)
    expect(decoded).toBe('héllo 🚀')
  })

  test('decodes with offset and length via subarray', () => {
    const full = encoder.encode('hello world')
    const sliced = full.subarray(6, 11) // "world"
    expect(decoder.decode(sliced)).toBe('world')
  })
})

describe('toPlainBuffer', () => {
  test('creates a copy of the input buffer', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5])
    const copy = toPlainBuffer(original)

    expect(copy).toEqual(original)
    expect(copy.buffer).not.toBe(original.buffer) // Different backing store
  })

  test('modifying copy does not affect original', () => {
    const original = new Uint8Array([1, 2, 3])
    const copy = toPlainBuffer(original)
    copy[0] = 99

    expect(original[0]).toBe(1)
    expect(copy[0]).toBe(99)
  })

  test('handles empty buffer', () => {
    const original = new Uint8Array(0)
    const copy = toPlainBuffer(original)
    expect(copy.byteLength).toBe(0)
  })

  test('handles buffer with single element', () => {
    const original = new Uint8Array([42])
    const copy = toPlainBuffer(original)
    expect(copy[0]).toBe(42)
    expect(copy.byteLength).toBe(1)
  })

  test('handles large buffer', () => {
    const original = new Uint8Array(10_000)
    for (let i = 0; i < original.length; i++) {
      original[i] = i & 0xff
    }
    const copy = toPlainBuffer(original)
    expect(copy.byteLength).toBe(10_000)
    expect(copy[0]).toBe(0)
    expect(copy[9999]).toBe(9999 & 0xff)
  })
})
