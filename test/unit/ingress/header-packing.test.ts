/**
 * Tests for src/ingress/packing/header-packing.ts
 *
 * Regression coverage for the >8KB header corruption bug: writeHeaderPair grew
 * the buffer/view LOCALLY on overflow and never returned it, so any request
 * whose packed headers exceeded HEADER_BUF_SIZE (8192 bytes) silently lost the
 * overflow bytes.
 */

import { describe, expect, test } from 'bun:test'
import { gatherRawHeadersPacked } from '../../../src/ingress/packing/gather-raw-headers'
import { packHeaders } from '../../../src/ingress/packing/header-packing'
import { forEachSelectedHeader } from '../../../src/ingress/packing/select-headers'
import { type HeaderPlan, METHOD_KIND } from '../../../src/ingress/shared'
import { decoder } from '../../../src/shared/bytes'

/**
 * Test-local string-array reference for the packed header path — mirrors the
 * legacy `gatherRawHeaders` impl (same selection + size guards) so the packed
 * path can be cross-checked against a readable reference without shipping it.
 */
function gatherRawHeadersRef(
  req: Request,
  plan: HeaderPlan,
  methodKind: number,
): Array<[string, string]> {
  const headers: Array<[string, string]> = []
  forEachSelectedHeader(req, plan, methodKind, undefined, (name, value) => {
    headers.push([decoder.decode(name), value])
  })
  return headers
}

const FULL_PLAN: HeaderPlan = {
  cookie: true,
  cors: true,
  proxy: true,
  proto: true,
}

/** Decode the packed header format: [u16 count][u16 nameLen][name][u32 valLen][value]... */
function decodePacked(packed: Uint8Array): Array<[name: string, value: string]> {
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  const count = dv.getUint16(0, true)
  let pos = 2
  const pairs: Array<[string, string]> = []

  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(pos, true)
    pos += 2
    const name = new TextDecoder().decode(packed.subarray(pos, pos + nameLen))
    pos += nameLen

    const valLen = dv.getUint32(pos, true)
    pos += 4
    const value = new TextDecoder().decode(packed.subarray(pos, pos + valLen))
    pos += valLen

    pairs.push([name, value])
  }

  return pairs
}

describe('packHeaders', () => {
  test('packs small headers into the fixed 8192-byte buffer', () => {
    const req = new Request('http://example.com/', {
      headers: {
        cookie: 'session=abc123',
        origin: 'https://app.example.com',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
        'x-forwarded-proto': 'https',
      },
    })

    const packed = packHeaders(req, FULL_PLAN)
    const pairs = decodePacked(packed)

    expect(pairs).toEqual([
      ['cookie', 'session=abc123'],
      ['origin', 'https://app.example.com'],
      ['x-forwarded-for', '1.2.3.4'],
      ['x-real-ip', '5.6.7.8'],
      ['x-forwarded-proto', 'https'],
    ])
  })

  test('preserves a header block larger than HEADER_BUF_SIZE (8192 bytes)', () => {
    // Multiple within-guard values whose SUM exceeds the fixed buffer force
    // writeHeaderPair to grow it; every value must survive uncorrupted.
    const bigCookie = `big=${String('a').repeat(8000)}` // <= MAX_COOKIE_HEADER_BYTES
    const origin = `https://app.example.com/${String('b').repeat(2000)}` // <= MAX_SMALL_HEADER_BYTES

    const req = new Request('http://example.com/', {
      headers: {
        cookie: bigCookie,
        origin,
      },
    })

    const packed = packHeaders(req, FULL_PLAN)
    expect(packed.length).toBeGreaterThan(8192)

    const pairs = decodePacked(packed)
    expect(pairs).toEqual([
      ['cookie', bigCookie],
      ['origin', origin],
    ])
  })

  test('preserves multiple large headers that overflow together', () => {
    // Each value is within its per-header size guard, but the SUM exceeds the
    // 8192 scratch buffer, so the buffer must grow and preserve every header.
    const bigCookie = `session=${String('c').repeat(5000)}` // <= 8192
    const bigXff = String('9').repeat(5000) // <= 8192
    const bigOrigin = `https://app.example.com/${String('b').repeat(2000)}` // <= 2048

    const req = new Request('http://example.com/', {
      headers: {
        cookie: bigCookie,
        origin: bigOrigin,
        'x-forwarded-for': bigXff,
      },
    })

    const packed = packHeaders(req, FULL_PLAN)
    expect(packed.length).toBeGreaterThan(8192)

    const pairs = decodePacked(packed)
    expect(pairs).toEqual([
      ['cookie', bigCookie],
      ['origin', bigOrigin],
      ['x-forwarded-for', bigXff],
    ])
  })

  test('oversized headers are dropped by packHeaders (shared guard policy)', () => {
    const big = new Request('http://example.com/', {
      headers: {
        cookie: `c=${String('x').repeat(9000)}`, // > MAX_COOKIE_HEADER_BYTES
        origin: 'https://app.example.com', // within MAX_SMALL_HEADER_BYTES
      },
    })
    const pairs = decodePacked(packHeaders(big, FULL_PLAN))
    // The 9000-byte cookie is dropped; the within-guard origin is kept.
    expect(pairs).toEqual([['origin', 'https://app.example.com']])
  })

  test('reuses the thread-local buffer without cross-request contamination', () => {
    // Two sequential packs: a small request followed by a large one must not
    // leak the large request's bytes into the small request's output.
    const small = new Request('http://example.com/', {
      headers: { cookie: 'a=1' },
    })
    const large = new Request('http://example.com/', {
      headers: { cookie: `big=${String('x').repeat(6000)}` },
    })

    const smallPacked = packHeaders(small, FULL_PLAN)
    const smallPairs = decodePacked(smallPacked)
    expect(smallPairs).toEqual([['cookie', 'a=1']])

    const largePacked = packHeaders(large, FULL_PLAN)
    const largePairs = decodePacked(largePacked)
    expect(largePairs).toEqual([['cookie', `big=${String('x').repeat(6000)}`]])
  })
})

describe('gatherRawHeaders vs gatherRawHeadersPacked parity', () => {
  const req = new Request('http://example.com/api?x=1', {
    method: 'GET',
    headers: {
      cookie: 'session=abc123; theme=dark',
      origin: 'https://app.example.com',
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '5.6.7.8',
      'x-forwarded-proto': 'https',
    },
  })

  test('packed gathering selects the same headers as the string-array path', () => {
    const raw = gatherRawHeadersRef(req, FULL_PLAN, METHOD_KIND.GET)
    const packed = decodePacked(gatherRawHeadersPacked(req, FULL_PLAN, METHOD_KIND.GET))
    expect(packed).toEqual(raw)
  })

  test('oversized headers are dropped by BOTH paths (same size guards)', () => {
    const big = new Request('http://example.com/', {
      headers: {
        cookie: `c=${String('x').repeat(9000)}`,
        origin: 'https://app.example.com',
      },
    })
    const raw = gatherRawHeadersRef(big, FULL_PLAN, METHOD_KIND.GET)
    const packed = decodePacked(gatherRawHeadersPacked(big, FULL_PLAN, METHOD_KIND.GET))
    expect(packed).toEqual(raw)
    // The 9000-byte cookie exceeds MAX_COOKIE_HEADER_BYTES → dropped in both.
    expect(packed.find(([n]) => n === 'cookie')).toBeUndefined()
  })

  test('fast packHeaders agrees with the baked packed path on oversized headers', () => {
    const big = new Request('http://example.com/', {
      headers: {
        cookie: `c=${String('x').repeat(9000)}`,
        'x-forwarded-for': `xff=${String('y').repeat(10_000)}`,
        origin: 'https://app.example.com',
      },
    })
    const fast = decodePacked(packHeaders(big, FULL_PLAN))
    const baked = decodePacked(gatherRawHeadersPacked(big, FULL_PLAN, METHOD_KIND.GET))
    expect(fast).toEqual(baked)
    // Oversized cookie + xff dropped on the fast path too (was a 500 before).
    expect(fast.find(([n]) => n === 'cookie')).toBeUndefined()
    expect(fast.find(([n]) => n === 'x-forwarded-for')).toBeUndefined()
  })
})
