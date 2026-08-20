/**
 * Tests for the Rust hashing/HMAC FFI: `rust.crc32`, `rust.fnv1a64`,
 * `rust.hmacSha256` / `rust.hmacSha256Verify` and the `createHmacSigner`
 * compiled-once instance. CRC32/FNV are cross-checked against hand-rolled JS
 * implementations; HMAC against node:crypto.
 */

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const enc = (s: string) => encoder.encode(s)

// ── JS reference implementations ──────────────────────────────────
function jsCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function jsFnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}

function jsHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  // The native FFI returns the HMAC HEX-ENCODED (64 ASCII bytes), so the JS
  // reference produces the same hex string bytes for a direct comparison.
  return encoder.encode(createHmac('sha256', key).update(data).digest('hex'))
}

describe('crc32', () => {
  test('matches a hand-rolled CRC-32 (IEEE)', () => {
    for (const input of ['', 'a', 'hello', 'the quick brown fox']) {
      expect(rust.crc32(enc(input))).toBe(jsCrc32(enc(input)))
    }
  })

  test('known value', () => {
    expect(rust.crc32(enc('hello'))).toBe(907060870)
  })

  test('batch matches scalar per item', () => {
    const items = [enc(''), enc('a'), enc('hello')]
    const out = rust.batch.crc32(items)
    for (let i = 0; i < items.length; i++) {
      expect(out[i]).toBe(rust.crc32(items[i]))
    }
  })
})

describe('fnv1a64', () => {
  test('matches a hand-rolled FNV-1a 64', () => {
    for (const input of ['', 'a', 'hello', 'fnv test']) {
      expect(rust.fnv1a64(enc(input))).toBe(jsFnv1a64(enc(input)))
    }
  })

  test('returns a bigint', () => {
    expect(typeof rust.fnv1a64(enc('x'))).toBe('bigint')
  })
})

describe('xxh3', () => {
  test('returns a deterministic 64-bit bigint', () => {
    const a = rust.xxh3(enc('castrum'))
    const b = rust.xxh3(enc('castrum'))
    expect(typeof a).toBe('bigint')
    expect(a).toBe(b)
  })

  test('differs across distinct inputs', () => {
    expect(rust.xxh3(enc('a'))).not.toBe(rust.xxh3(enc('b')))
  })

  test('matches Bun.hash.xxHash3 when available', () => {
    if (typeof Bun !== 'undefined' && typeof Bun.hash?.xxHash3 === 'function') {
      for (const input of ['', 'hello', 'the quick brown fox']) {
        expect(rust.xxh3(enc(input))).toBe(Bun.hash.xxHash3(enc(input)))
      }
    }
  })
})

describe('hmacSha256', () => {
  const key = enc('secret-key')
  const data = enc('message to sign')

  test('sign matches node:crypto HMAC-SHA256', () => {
    const sig = rust.hmacSha256(key, data)
    // Bun returns the hex STRING; the JS reference produces hex bytes —
    // re-encode for a direct byte comparison.
    expect(Array.from(encoder.encode(sig))).toEqual(Array.from(jsHmacSha256(key, data)))
  })

  test('verify accepts the correct signature and rejects tampered', () => {
    const sig = rust.hmacSha256(key, data)
    expect(rust.hmacSha256Verify(key, data, encoder.encode(sig))).toBe(true)
    expect(rust.hmacSha256Verify(key, enc('different'), encoder.encode(sig))).toBe(false)
    const tampered = encoder.encode(sig)
    tampered[0] ^= 0xff
    expect(rust.hmacSha256Verify(key, data, tampered)).toBe(false)
  })

  test('createHmacSigner instance (compiled-once key)', () => {
    const signer = rust.createHmacSigner(key)
    const sig = signer.sign(data)
    expect(Array.from(sig)).toEqual(Array.from(jsHmacSha256(key, data)))
    expect(signer.verify(data, sig)).toBe(true)
    expect(signer.verify(enc('other'), sig)).toBe(false)
  })

  test('batch sign matches scalar per item', () => {
    const items = [enc('a'), enc('bb'), enc('ccc')]
    const out = rust.batch.hmacSha256(items, key)
    for (let i = 0; i < items.length; i++) {
      expect(Array.from(out[i])).toEqual(Array.from(encoder.encode(rust.hmacSha256(key, items[i]))))
    }
  })
})
