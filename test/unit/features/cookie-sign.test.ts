/**
 * Tests for the Rust signed-cookie FFI: `rust.signCookie`/`verifyCookie`,
 * `rust.createCookieSigner` (higher-order instance), and the batch namespace —
 * cross-checked against the node:crypto baseline.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'
import { nativeSignCookie, nativeVerifyCookie } from '../../../src/bench/cookie-sign-baseline'

const SECRET = encoder.encode('super-secret-cookie-key')
const VALUE = encoder.encode('session=abc123; theme=dark')

describe('CookieSigner (higher-order instance)', () => {
  const signer = rust.createCookieSigner(SECRET)

  test('sign matches the node:crypto baseline byte-for-byte', () => {
    expect(Array.from(signer.sign(VALUE))).toEqual(Array.from(nativeSignCookie(VALUE, SECRET)))
  })

  test('verify roundtrips the value', () => {
    const signed = signer.sign(VALUE)
    expect(Array.from(signer.verify(signed) ?? new Uint8Array(0))).toEqual(Array.from(VALUE))
  })

  test('rejects tampered and wrong secret', () => {
    const signed = signer.sign(VALUE)
    const tampered = new Uint8Array(signed)
    tampered[0] = tampered[0] === 115 ? 116 : 115 // flip first byte
    expect(signer.verify(tampered)).toBeNull()
    const other = rust.createCookieSigner(encoder.encode('other-secret'))
    expect(other.verify(signed)).toBeNull()
  })
})

describe('rust.signCookie / verifyCookie (scalar)', () => {
  test('matches baseline', () => {
    expect(decoder.decode(rust.signCookie(VALUE, SECRET))).toBe(
      decoder.decode(nativeSignCookie(VALUE, SECRET)),
    )
    expect(
      Array.from(rust.verifyCookie(rust.signCookie(VALUE, SECRET), SECRET) ?? new Uint8Array(0)),
    ).toEqual(Array.from(VALUE))
    expect(nativeVerifyCookie(nativeSignCookie(VALUE, SECRET), SECRET)).not.toBeNull()
  })
})

describe('rust.batch cookie', () => {
  test('signCookie returns N results; verifyCookie bitset', () => {
    const signed = rust.batch.signCookie([VALUE, VALUE], SECRET)
    expect(signed.length).toBe(2)
    const bits = rust.batch.verifyCookie(signed, SECRET)
    expect(Array.from(bits)).toEqual([1, 1])
  })
})
