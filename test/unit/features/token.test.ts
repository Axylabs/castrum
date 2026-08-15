/**
 * Tests for `rust.randomToken` — random hex token generator
 * (rust/crypto/random_token.rs).
 *
 * NOTE: the token is returned HEX-ENCODED (each random byte becomes two hex
 * characters), so the returned buffer is `byteLen * 2` bytes.
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { toText } from '../../../src/shared/bytes'

describe('randomToken', () => {
  test('returns byteLen random bytes as hex (2x length)', () => {
    for (const len of [1, 8, 16, 32, 64, 256]) {
      const tok = rust.randomToken(len)
      // Bun returns the hex STRING (native transfer); Node returns bytes.
      expect(typeof tok).toBe('string')
      expect(tok.length).toBe(len * 2)
    }
  })

  test('token bytes are lowercase hex characters', () => {
    const tok = rust.randomToken(8)
    expect(/^[0-9a-f]{16}$/.test(toText(tok))).toBe(true)
  })

  test('tokens are distinct across calls', () => {
    const a = rust.randomToken(32)
    const b = rust.randomToken(32)
    // Extremely unlikely to collide (256 bits), and a collision would mean
    // the generator is not random.
    expect(a).not.toBe(b)
  })

  test('zero length yields an empty token', () => {
    expect(rust.randomToken(0)).toBe('')
  })

  test('huge lengths are rejected (allocation guard)', () => {
    // The native layer rejects byte_len > 16 MiB so a caller cannot trigger
    // a ~4 GiB single allocation.
    expect(() => rust.randomToken(16 * 1024 * 1024 + 1)).toThrow()
  })
})
