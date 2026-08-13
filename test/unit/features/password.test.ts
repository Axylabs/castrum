/**
 * Tests for the Rust argon2id password hashing FFI.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'

const password = encoder.encode('correct horse battery staple')
const salt = encoder.encode('0123456789abcdef')
const options = { mCost: 4096, tCost: 2, pCost: 1 }

describe('rust.passwordHash', () => {
  test('hash then verify roundtrip', () => {
    const phc = rust.passwordHash(password, salt, options)
    expect(decoder.decode(phc)).toMatch(/^\$argon2id\$v=19\$/)
    expect(rust.passwordVerify(password, phc)).toBe(true)
  })

  test('rejects wrong password', () => {
    const phc = rust.passwordHash(password, salt, options)
    expect(rust.passwordVerify(encoder.encode('wrong'), phc)).toBe(false)
  })

  test('is deterministic given the same salt', () => {
    const a = rust.passwordHash(password, salt, options)
    const b = rust.passwordHash(password, salt, options)
    expect([...a]).toEqual([...b])
  })

  test('rejects malformed phc', () => {
    expect(rust.passwordVerify(password, encoder.encode('garbage'))).toBe(false)
    expect(rust.passwordVerify(password, encoder.encode(''))).toBe(false)
  })
})

describe('rust.batch.passwordHash', () => {
  test('hashes many passwords in parallel', () => {
    const passwords = Array.from({ length: 8 }, (_, i) => encoder.encode(`password-${i}`))
    const phcs = rust.batch.passwordHash(passwords, salt, options)
    expect(phcs).toHaveLength(passwords.length)
    passwords.forEach((p, i) => {
      expect(rust.passwordVerify(p, phcs[i] as Uint8Array)).toBe(true)
    })
  })
})

describe('rust.passwordHashBcrypt', () => {
  // cost 4 keeps the test fast while still exercising the real KDF.
  const COST = 4

  test('hash then verify roundtrip (PHC $2b$)', () => {
    const phc = rust.passwordHashBcrypt(password, COST)
    expect(phc).toMatch(/^\$2b\$04\$/)
    expect(phc.length).toBe(60)
    expect(rust.passwordVerifyBcrypt(password, phc)).toBe(true)
  })

  test('rejects wrong password', () => {
    const phc = rust.passwordHashBcrypt(password, COST)
    expect(rust.passwordVerifyBcrypt(encoder.encode('wrong'), phc)).toBe(false)
  })

  test('clamps cost into 4..=31 and is salted per call', () => {
    const a = rust.passwordHashBcrypt(password, 1) // clamped up to 4
    const b = rust.passwordHashBcrypt(password, 1)
    expect(a).toMatch(/^\$2b\$04\$/)
    expect(a).not.toBe(b) // distinct salts
    expect(rust.passwordVerifyBcrypt(password, a)).toBe(true)
    expect(rust.passwordVerifyBcrypt(password, b)).toBe(true)
  })

  test('rejects malformed hash', () => {
    expect(rust.passwordVerifyBcrypt(password, 'garbage')).toBe(false)
  })
})

describe('rust.pbkdf2Sha256', () => {
  test('matches node:crypto pbkdf2Sync (known vector)', () => {
    const { pbkdf2Sync } = require('node:crypto') as typeof import('node:crypto')
    const out = rust.pbkdf2Sha256(password, salt, 1, 32)
    const expected = pbkdf2Sync(Buffer.from(password), Buffer.from(salt), 1, 32, 'sha256')
    expect([...out]).toEqual([...new Uint8Array(expected)])
  })

  test('is iteration-sensitive and length-clamped', () => {
    const a = rust.pbkdf2Sha256(password, salt, 1, 16)
    const b = rust.pbkdf2Sha256(password, salt, 2, 16)
    expect(a).toHaveLength(16)
    expect([...a]).not.toEqual([...b])
    // dkLen 0 is clamped to 1 (min), not empty.
    expect(rust.pbkdf2Sha256(password, salt, 1, 0)).toHaveLength(1)
  })
})
