// test/unit/ingress/baked-response.test.ts — pre-baked response builders.
//
// The CORS steady-state path memoizes an Origin-augmented header array per
// (variant, origin). Under wildcard CORS every Origin is allowed, so an
// attacker can stream distinct Origins — the cache MUST stay bounded.

import { describe, expect, test } from 'bun:test'
import { HV_CORS_SIMPLE, HV_JSON, HV_RATE_ACTIVE } from '../../../src/ingress/constants'
import {
  buildBakedResponseBuilders,
  ORIGIN_HEADER_CACHE_MAX,
  prewarmOriginHeaders,
} from '../../../src/ingress/response/baked-response'

const TEMPLATES: Array<Array<[string, string]>> = [[['content-type', 'application/json']]]

function makeBuilders(cache: Map<string, [string, string][]>) {
  return buildBakedResponseBuilders({
    headerTemplates: TEMPLATES,
    terminalTemplates: TEMPLATES,
    emitRequestIdHeader: false,
    zeroCopyTimeoutMs: 1000,
    originHeaderCache: cache,
    state: { currentHandle: null, responseBorrowsBuffer: false },
  })
}

describe('baked response — per-origin header cache', () => {
  test('a stream of distinct origins does not grow the cache without bound', () => {
    const cache = new Map<string, [string, string][]>()
    const b = makeBuilders(cache)
    for (let i = 0; i < 1024; i++) {
      b.responseHeaders(HV_CORS_SIMPLE, null, `https://o${i}.example.com`)
    }
    expect(cache.size).toBeLessThanOrEqual(ORIGIN_HEADER_CACHE_MAX)
  })

  test('a repeated origin still hits the cache', () => {
    const cache = new Map<string, [string, string][]>()
    const b = makeBuilders(cache)
    const origin = 'https://app.example.com'
    const first = b.responseHeaders(HV_CORS_SIMPLE, null, origin)
    const second = b.responseHeaders(HV_CORS_SIMPLE, null, origin)
    expect(second).toBe(first)
    expect(cache.size).toBe(1)
  })

  test('successHeaders reuses the memoized base when there are no extras', () => {
    const b = makeBuilders(new Map())
    const origin = 'https://app.example.com'
    const variant = HV_JSON | HV_CORS_SIMPLE
    const first = b.successHeaders?.(variant, null, origin)
    const second = b.successHeaders?.(variant, null, origin)
    expect(first).toBeInstanceOf(Headers)
    expect(second).toBe(first) // base is memoized (hit)
  })

  test('successHeaders with rate extras clones the base (no mutation) and carries the fields', () => {
    const b = makeBuilders(new Map())
    const origin = 'https://app.example.com'
    const base = b.successHeaders?.(HV_JSON | HV_CORS_SIMPLE, null, origin)
    const withRate = b.successHeaders?.(
      HV_JSON | HV_CORS_SIMPLE | HV_RATE_ACTIVE,
      null,
      origin,
      7,
      42,
    )
    expect(withRate).not.toBe(base)
    expect(withRate?.get('ratelimit-remaining')).toBe('7')
    expect(withRate?.get('ratelimit-reset')).toBe('42')
    expect(withRate?.get('content-type')).toBe('application/json')
    // The memoized base must not have been mutated by the clone+set.
    expect(base?.get('ratelimit-remaining')).toBeNull()
  })

  test('prewarm uses the SUCCESS variant so the first request is a cache hit', () => {
    const cache = new Map<string, [string, string][]>()
    const b = makeBuilders(cache)
    const origin = 'https://app.example.com'
    const successVariant = HV_JSON | HV_CORS_SIMPLE
    prewarmOriginHeaders(b.responseHeaders, [origin], successVariant)
    expect(cache.size).toBe(1)

    // The real success path must be a HIT (no new cache entry).
    b.responseHeaders(successVariant, null, origin)
    expect(cache.size).toBe(1)
    // Regression guard: warming the CORS-only variant (the old bug) left the
    // success variant uncached.
    expect(cache.has(`${HV_CORS_SIMPLE}\u0000${origin}`)).toBe(false)
  })
})
