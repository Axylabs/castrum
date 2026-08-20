/**
 * Tests for the `rust.packed.*` batch METADATA helpers — the count/total
 * accessors that were previously untested:
 *
 *   jsonValidBatchCountPacked, validate{Email,Uuid,Ipv4,Ipv6}BatchCountPacked,
 *   jsonSumBatchTotalPacked, queryParseBatchTotalLenPacked,
 *   cookieParseBatchTotalLenPacked, httpParseRequestBatchTotalLenPacked
 *
 * Each is cross-checked against the corresponding `rust.batch.*` array
 * result (bitset count / summed BigInt64 / summed packed-output lengths), so
 * a drift between the packed-metadata path and the array-batch path is caught.
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { packBatch } from '../../../src/shared/packed'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function countBits(bitset: Uint8Array): number {
  let n = 0
  for (const b of bitset) n += b & 1
  return n
}

function sumBigInts(arr: BigInt64Array): number {
  let n = 0
  for (const b of arr) n += Number(b)
  return n
}

function sumLens(arrs: Uint8Array[]): number {
  return arrs.reduce((acc, a) => acc + a.length, 0)
}

describe('rust.packed.* batch metadata helpers', () => {
  test('jsonValidBatchCountPacked matches the bitset batch', () => {
    const items = [enc('{"a":1}'), enc('not json'), enc('[1,2,3]'), enc('null')]
    const packed = packBatch(items)
    expect(rust.packed.jsonValidBatchCountPacked(packed)).toBe(
      countBits(rust.batch.jsonValid(items)),
    )
  })

  test('validator counts match the bitset batches', () => {
    const emails = [enc('a@b.com'), enc('nope'), enc('x@y.co')]
    const uuids = [enc('550e8400-e29b-41d4-a716-446655440000'), enc('bad')]
    const ipv4s = [enc('192.168.0.1'), enc('999.1.1.1'), enc('10.0.0.1')]
    const ipv6s = [enc('2001:db8::1'), enc('::1'), enc('not-ipv6')]

    expect(rust.packed.validateEmailBatchCountPacked(packBatch(emails))).toBe(
      countBits(rust.batch.validateEmail(emails)),
    )
    expect(rust.packed.validateUuidBatchCountPacked(packBatch(uuids))).toBe(
      countBits(rust.batch.validateUuid(uuids)),
    )
    expect(rust.packed.validateIpv4BatchCountPacked(packBatch(ipv4s))).toBe(
      countBits(rust.batch.validateIpv4(ipv4s)),
    )
    expect(rust.packed.validateIpv6BatchCountPacked(packBatch(ipv6s))).toBe(
      countBits(rust.batch.validateIpv6(ipv6s)),
    )
  })

  test('jsonSumBatchTotalPacked matches the summed BigInt64Array batch', () => {
    const items = [enc('[{"id":1},{"id":2}]'), enc('nope'), enc('[{"id":10}]')]
    const total = sumBigInts(rust.batch.jsonSumIds(items))
    expect(rust.packed.jsonSumBatchTotalPacked(packBatch(items))).toBe(total)
  })

  test('total-len helpers match the summed packed outputs', () => {
    const queries = [enc('a=1&b=2'), enc('x=hello%20world'), enc('')]
    const cookies = [enc('a=1; b=2'), enc('sid=abc')]
    const reqs = [
      enc('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
      enc('POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n'),
    ]

    expect(rust.packed.queryParseBatchTotalLenPacked(packBatch(queries))).toBe(
      sumLens(rust.batch.queryParse(queries)),
    )
    expect(rust.packed.cookieParseBatchTotalLenPacked(packBatch(cookies))).toBe(
      sumLens(rust.batch.cookieParse(cookies)),
    )
    expect(rust.packed.httpParseRequestBatchTotalLenPacked(packBatch(reqs))).toBe(
      sumLens(rust.batch.httpParseRequest(reqs)),
    )
  })

  test('empty packed batch → zero metadata', () => {
    const empty = packBatch([])
    expect(rust.packed.jsonValidBatchCountPacked(empty)).toBe(0)
    expect(rust.packed.jsonSumBatchTotalPacked(empty)).toBe(0)
    expect(rust.packed.queryParseBatchTotalLenPacked(empty)).toBe(0)
    expect(rust.packed.cookieParseBatchTotalLenPacked(empty)).toBe(0)
  })
})
