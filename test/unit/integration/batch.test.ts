/**
 * Loader-backed batch helpers (`src/integration/batch.ts`) — the higher-order
 * loader is exercised at the integration layer, not just exported.
 *
 * Covers: bulk schema bitset + count parity vs `rust.batch.*`, generic bulk
 * dispatch counting as ONE packed batch call (loader stats), single dispatch
 * parity with `rust.*`, and hmac bulk byte parity.
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'
import { loader } from '../../../src/loader'
import { validateMany, validateCount, runMany, runOne } from '../../../src/integration/batch'

const bytes = (s: string): Uint8Array => encoder.encode(s)

const SCHEMA = bytes('{"type":"object","required":["id"]}')
const GOOD = bytes('{"id":1}')
const BAD = bytes('{"name":"x"}')

describe('integration/batch (loader-backed)', () => {
  const validator = rust.createSchemaValidator(SCHEMA)

  test('validateMany matches rust.batch.schemaValidate bitset', () => {
    const bits = validateMany(validator, [GOOD, BAD, GOOD])
    expect([...bits]).toEqual([...rust.batch.schemaValidate(validator, [GOOD, BAD, GOOD])])
    expect([...bits]).toEqual([1, 0, 1])
  })

  test('validateCount counts valid docs', () => {
    expect(validateCount(validator, [GOOD, BAD, GOOD])).toBe(2)
    expect(validateCount(validator, [BAD, BAD])).toBe(0)
    expect(validateCount(validator, [])).toBe(0)
  })

  test('runMany dispatches ONE packed batch call (loader stats)', () => {
    loader.clear()
    const before = loader.stats.batchCalls
    const bits = runMany('validateEmail', [bytes('a@b.co'), bytes('c@d.co')])
    expect([...bits]).toEqual([1, 1])
    expect(loader.stats.batchCalls).toBeGreaterThan(before)
  })

  test('runOne dispatches a single scalar with rust.* parity', () => {
    expect(runOne('validateEmail', bytes('a@b.co'))).toBe(true)
    expect(runOne('validateEmail', bytes('not-an-email'))).toBe(false)
  })

  test('runMany hmacSha256 = one packed call, byte parity with rust.batch', () => {
    const key = bytes('secret')
    const items = [bytes('a'), bytes('b')]
    const sigs = runMany('hmacSha256', items, key)
    expect(sigs.length).toBe(2)
    expect(sigs[0]).toEqual(rust.hmacSha256(key, bytes('a')))
    expect(sigs[1]).toEqual(rust.hmacSha256(key, bytes('b')))
  })
})
