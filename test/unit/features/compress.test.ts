/**
 * Tests for the Rust gzip/brotli compression FFI.
 */

import { describe, test, expect } from 'bun:test'
import {
  nativeBrotliDecompress,
  nativeBrotliCompress,
  nativeGzipDecompress,
  nativeGzipCompress,
} from '../../../src/baseline/tasks/compress'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const payload = encoder.encode('the quick brown fox jumps over the lazy dog '.repeat(20))

function toBytes(actual: unknown): number[] {
  return [...(actual as Uint8Array)]
}

describe('gzip', () => {
  test('rust roundtrip', () => {
    const compressed = rust.gzipCompress(payload)
    expect(compressed.byteLength).toBeLessThan(payload.byteLength)
    expect(toBytes(rust.gzipDecompress(compressed))).toEqual([...payload])
  })

  test('cross-impl: rust decompresses native, native decompresses rust', () => {
    expect(toBytes(rust.gzipDecompress(nativeGzipCompress(payload)))).toEqual([...payload])
    expect(toBytes(nativeGzipDecompress(rust.gzipCompress(payload)))).toEqual([...payload])
  })

  test('rejects garbage', () => {
    expect(() => rust.gzipDecompress(encoder.encode('not-gzip'))).toThrow()
  })
})

describe('brotli', () => {
  test('rust roundtrip', () => {
    const compressed = rust.brotliCompress(payload)
    expect(compressed.byteLength).toBeLessThan(payload.byteLength)
    expect(toBytes(rust.brotliDecompress(compressed))).toEqual([...payload])
  })

  test('cross-impl decompress', () => {
    expect(toBytes(rust.brotliDecompress(nativeBrotliCompress(payload)))).toEqual([...payload])
    expect(toBytes(nativeBrotliDecompress(rust.brotliCompress(payload)))).toEqual([...payload])
  })
})

describe('decompression cap (zip-bomb guard)', () => {
  test('gzip output over the cap errors', () => {
    // 2 MiB of zeros compresses to a few KB but inflates past a 64 KiB cap.
    const bomb = new Uint8Array(2 * 1024 * 1024)
    const compressed = rust.gzipCompress(bomb)
    expect(compressed.byteLength).toBeLessThan(bomb.byteLength / 100)
    expect(() => rust.gzipDecompress(compressed, 64 * 1024)).toThrow()
  })

  test('brotli output over the cap errors', () => {
    const bomb = new Uint8Array(2 * 1024 * 1024)
    const compressed = rust.brotliCompress(bomb, 0)
    expect(compressed.byteLength).toBeLessThan(bomb.byteLength / 100)
    expect(() => rust.brotliDecompress(compressed, 64 * 1024)).toThrow()
  })

  test('batch decompress caps each item independently', () => {
    const bomb = new Uint8Array(2 * 1024 * 1024)
    const ok = rust.gzipCompress(new Uint8Array([1, 2, 3]))
    const [a, b] = rust.batch.gzipDecompress([ok, rust.gzipCompress(bomb)], 64 * 1024)
    expect(a.byteLength).toBe(3)
    expect(b.byteLength).toBe(0) // over-cap item becomes empty
  })
})

describe('batch', () => {
  test('gzip batch roundtrips', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      encoder.encode(`item-${i}: ${String('abc').repeat(i)}`),
    )
    const compressed = rust.batch.gzipCompress(items)
    const decompressed = rust.batch.gzipDecompress(compressed)
    items.forEach((item, i) => {
      expect(toBytes(decompressed[i])).toEqual([...item])
    })
  })
})
