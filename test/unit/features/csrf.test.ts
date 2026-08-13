/**
 * Tests for the Rust CSRF FFI: `rust.csrfToken`/`csrfVerify`,
 * `rust.createCsrfProtector` (higher-order instance), and the batch namespace —
 * cross-checked against the node:crypto baseline.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'
import { nativeCsrfToken, nativeCsrfVerify } from '../../../src/bench/csrf-baseline'

const SECRET = encoder.encode('csrf-secret')

describe('CsrfProtector (higher-order instance)', () => {
  const protector = rust.createCsrfProtector(SECRET)

  test('create produces a token and verify accepts it', () => {
    const token = protector.create()
    expect(token.byteLength).toBe(64 + 1 + 64)
    expect(protector.verify(token)).toBe(true)
  })

  test('rejects tampered and wrong secret', () => {
    const token = protector.create()
    const tampered = new Uint8Array(token)
    tampered[0] = tampered[0] === 97 ? 98 : 97
    expect(protector.verify(tampered)).toBe(false)
    const other = rust.createCsrfProtector(encoder.encode('other'))
    expect(other.verify(token)).toBe(false)
  })
})

describe('rust.csrfToken / csrfVerify (scalar)', () => {
  test('roundtrip + parity with native baseline', () => {
    const token = rust.csrfToken(SECRET)
    expect(rust.csrfVerify(token, SECRET)).toBe(true)
    expect(nativeCsrfVerify(token, SECRET)).toBe(true)
  })

  test('native create is also accepted by rust', () => {
    const token = nativeCsrfToken(SECRET)
    expect(rust.csrfVerify(token, SECRET)).toBe(true)
  })
})

describe('rust.batch.csrfVerify', () => {
  test('bitset matches', () => {
    const good = rust.csrfToken(SECRET)
    const bits = rust.batch.csrfVerify([good, encoder.encode('bad.bad')], SECRET)
    expect(Array.from(bits)).toEqual([1, 0])
  })
})
