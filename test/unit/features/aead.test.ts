/**
 * Tests for the Rust AEAD FFI (AES-256-GCM + ChaCha20-Poly1305), cross-checked
 * for byte parity against node:crypto.
 */

import { describe, test, expect } from 'bun:test'
import { nativeAeadEncrypt } from '../../../src/baseline/tasks/aead'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const key = encoder.encode('0123456789abcdef0123456789abcdef')
const nonce = encoder.encode('0123456789ab')
const plaintext = encoder.encode('sensitive session payload')

function toBytes(actual: unknown): number[] {
  if (actual === null) return []
  return [...(actual as Uint8Array)]
}

describe('rust.aeadEncrypt (aes-256-gcm)', () => {
  test('matches node:crypto byte-for-byte', () => {
    const rustCt = rust.aeadEncrypt(key, nonce, plaintext)
    const nativeCt = nativeAeadEncrypt(key, nonce, plaintext)
    expect(toBytes(rustCt)).toEqual(toBytes(nativeCt))
  })

  test('ciphertext is plaintext + 16-byte tag', () => {
    const rustCt = rust.aeadEncrypt(key, nonce, plaintext)
    expect(rustCt.byteLength).toBe(plaintext.byteLength + 16)
  })

  test('decrypt roundtrip', () => {
    const ct = rust.aeadEncrypt(key, nonce, plaintext)
    const pt = rust.aeadDecrypt(key, nonce, ct)
    expect(toBytes(pt)).toEqual([...plaintext])
  })

  test('rejects tampered ciphertext', () => {
    const ct = rust.aeadEncrypt(key, nonce, plaintext).slice()
    ct[0] ^= 0xff
    expect(rust.aeadDecrypt(key, nonce, ct)).toBeNull()
  })

  test('rejects wrong key / nonce', () => {
    const ct = rust.aeadEncrypt(key, nonce, plaintext)
    const badKey = encoder.encode('ffffffffffffffffffffffffffffffff')
    expect(rust.aeadDecrypt(badKey, nonce, ct)).toBeNull()
    const badNonce = encoder.encode('abcdefabcdef')
    expect(rust.aeadDecrypt(key, badNonce, ct)).toBeNull()
  })
})

describe('chacha20-poly1305', () => {
  test('roundtrips and rejects tampering', () => {
    const ct = rust.aeadEncrypt(key, nonce, plaintext, 'chacha20-poly1305')
    expect(ct.byteLength).toBe(plaintext.byteLength + 16)
    const pt = rust.aeadDecrypt(key, nonce, ct, 'chacha20-poly1305')
    expect(toBytes(pt)).toEqual([...plaintext])
    const bad = ct.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01
    expect(rust.aeadDecrypt(key, nonce, bad, 'chacha20-poly1305')).toBeNull()
  })

  test('cross-checks with node:crypto when available', () => {
    // Bun's node:crypto does not ship `chacha20-poly1305` on all builds, so
    // this is a best-effort parity check.
    let nativeCt: Uint8Array
    try {
      nativeCt = nativeAeadEncrypt(key, nonce, plaintext, 'chacha20-poly1305')
    } catch {
      return // cipher unavailable — skip
    }
    const rustCt = rust.aeadEncrypt(key, nonce, plaintext, 'chacha20-poly1305')
    expect(toBytes(rustCt)).toEqual(toBytes(nativeCt))
  })
})

describe('rust.batch.aeadEncrypt', () => {
  test('encrypts/decrypts a batch', () => {
    const items = Array.from({ length: 8 }, (_, i) => encoder.encode(`payload-${i}`))
    const cts = rust.batch.aeadEncrypt(key, nonce, items)
    const pts = rust.batch.aeadDecrypt(key, nonce, cts)
    items.forEach((item, i) => {
      expect(toBytes(pts[i])).toEqual([...item])
    })
  })
})
