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

describe('gzip stream-integrity edges', () => {
  test('trailing garbage after a valid member is ignored (lenient, first member wins)', () => {
    const g = rust.gzipCompress(encoder.encode('abc'))
    const junk = new Uint8Array(g.byteLength + 4)
    junk.set(g, 0)
    junk.set(encoder.encode('XYZ!'), g.byteLength)
    // The decoder stops at the end of the first valid member and ignores the
    // trailing bytes — it must NOT throw and must NOT mis-parse the garbage.
    expect(toBytes(rust.gzipDecompress(junk))).toEqual([...encoder.encode('abc')])
  })

  test('multi-member streams decode only the FIRST member (documented truncation)', () => {
    const g1 = rust.gzipCompress(encoder.encode('abc'))
    const g2 = rust.gzipCompress(encoder.encode('def'))
    const multi = new Uint8Array(g1.byteLength + g2.byteLength)
    multi.set(g1, 0)
    multi.set(g2, g1.byteLength)
    // flate2's GzDecoder reads a single member; a concatenated stream silently
    // truncates at the first member rather than erroring or concatenating.
    // Pin this so callers never assume multi-member concatenation.
    expect(toBytes(rust.gzipDecompress(multi))).toEqual([...encoder.encode('abc')])
  })

  test('truncated gzip member throws (no silent partial output)', () => {
    const g = rust.gzipCompress(encoder.encode('the quick brown fox jumps over the lazy dog'))
    const cut = g.subarray(0, Math.floor(g.byteLength / 2))
    expect(() => rust.gzipDecompress(cut)).toThrow()
  })

  test('advisory header metadata (MTIME) is ignored without corrupting output', () => {
    const g = rust.gzipCompress(encoder.encode('payload'))
    const tweaked = new Uint8Array(g)
    // MTIME (bytes 4-7) is advisory metadata. Flip a bit — the payload must
    // decode identically (the header is not part of the DEFLATE stream).
    const mtime = tweaked[5] ?? 0
    tweaked[5] = mtime ^ 0x40
    expect(toBytes(rust.gzipDecompress(tweaked))).toEqual([...encoder.encode('payload')])
  })
})
