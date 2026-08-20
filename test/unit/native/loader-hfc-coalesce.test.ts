/**
 * Tests for the loader coalescing + caching lifecycle (castrum.loader):
 * DataLoader-style microtask coalescing, the bounded hot-function LRU cache,
 * configure() re-binding, the load() availability guard, the load-aware
 * single↔coalesce strategy, and the adaptive default cache key.
 *
 * Dispatch + per-op parity tests live in loader-hfc.test.ts.
 */

import { describe, expect, test } from 'bun:test'
import { createLoader, LOADER_OP_NAMES, type LoaderOpName } from '../../../src/loader'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const bytes = (s: string): Uint8Array => encoder.encode(s)

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMAIL_OK = bytes('alice@example.com')
const EMAIL_BAD = bytes('not-an-email')
const HMAC_DATA = bytes('hello world')

describe('loader: microtask coalescing (load)', () => {
  test('same-tick loads coalesce into ONE native batch call', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    const beforeBatch = l.stats.batchCalls
    const beforeFlushes = l.stats.flushes

    const [r1, r2, r3] = await Promise.all([
      isEmail.load(EMAIL_OK),
      isEmail.load(EMAIL_BAD),
      isEmail.load(EMAIL_OK),
    ])

    expect(r1).toBe(true)
    expect(r2).toBe(false)
    expect(r3).toBe(true)
    expect(l.stats.flushes).toBe(beforeFlushes + 1)
    expect(l.stats.batchCalls).toBe(beforeBatch + 1) // ONE packed call, not 3
  })

  test('results resolve in enqueue order', async () => {
    const l = createLoader()
    const results: (string | null)[] = []
    const p1 = l('validateEmail').load(EMAIL_OK)
    const p2 = l('validateEmail').load(EMAIL_BAD)
    const p3 = l('validateEmail').load(EMAIL_OK)
    results.push((await p1) ? 'ok' : 'no')
    results.push((await p2) ? 'ok' : 'no')
    results.push((await p3) ? 'ok' : 'no')
    expect(results).toEqual(['ok', 'no', 'ok'])
  })

  test('different ops in one tick flush separately', async () => {
    const l = createLoader()
    const before = l.stats.flushes
    const [e, c] = await Promise.all([
      l('validateEmail').load(EMAIL_OK),
      l('crc32').load(HMAC_DATA),
    ])
    expect(e).toBe(true)
    expect(c).toBe(rust.crc32(HMAC_DATA))
    expect(l.stats.flushes).toBeGreaterThan(before)
  })

  test('a single load in a tick uses the scalar path', async () => {
    const l = createLoader()
    const beforeScalar = l.stats.scalarCalls
    const value = await l('validateEmail').load(EMAIL_OK)
    expect(value).toBe(true)
    expect(l.stats.scalarCalls).toBeGreaterThan(beforeScalar)
  })
})

describe('loader: hot-function cache (LRU)', () => {
  test('default key = fnv1a64(input); repeat loads hit the cache', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')

    expect(isEmail.cache(EMAIL_OK)).toBeUndefined() // cold
    await isEmail.load(EMAIL_OK)
    expect(isEmail.cache(EMAIL_OK)).toBe(true) // warmed, default fnv1a64 key

    const hitsBefore = l.stats.cachedHits
    const again = await isEmail.load(EMAIL_OK)
    expect(again).toBe(true)
    expect(l.stats.cachedHits).toBe(hitsBefore + 1) // no native compute
  })

  test('explicit key opts into caching and dedupes same-tick computes', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    const beforeBatch = l.stats.batchCalls

    const [a, b] = await Promise.all([
      isEmail.load(EMAIL_OK, { key: 'k1' }),
      isEmail.load(EMAIL_OK, { key: 'k1' }), // same key → same tick
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(l.stats.batchCalls).toBe(beforeBatch + 1)
    expect(isEmail.cache(EMAIL_OK, 'k1')).toBe(true)
  })

  test('LRU evicts the oldest key when capacity is exceeded', async () => {
    const l = createLoader({ maxCacheKeys: 3 })
    const crc = l('crc32')
    for (let i = 0; i < 4; i++) {
      await crc.load(bytes(`item-${i}`), { key: `k${i}` })
    }
    expect(l.stats.cacheEvictions).toBe(1)
    // k0 was evicted (oldest); k1..k3 are resident.
    expect(crc.cache(bytes('item-0'), 'k0')).toBeUndefined()
    expect(crc.cache(bytes('item-3'), 'k3')).toBe(rust.crc32(bytes('item-3')))
  })

  test('cache:false opts out for a single load', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    await isEmail.load(EMAIL_OK, { cache: false })
    expect(isEmail.cache(EMAIL_OK)).toBeUndefined()
  })

  test('clear() empties the shared cache', async () => {
    const l = createLoader()
    await l('validateEmail').load(EMAIL_OK)
    expect(l('validateEmail').cache(EMAIL_OK)).toBe(true)
    l.clear()
    expect(l('validateEmail').cache(EMAIL_OK)).toBeUndefined()
  })
})

describe('loader: configure() keeps dispatch + stats on the current context', () => {
  test('memoized op fn picks up the new cost model after configure', () => {
    const l = createLoader({ adaptive: false, batchMin: 2 })
    const isEmail = l('validateEmail')
    isEmail(EMAIL_OK)
    expect(isEmail.stats.batchMin).toBe(2)

    l.configure({ batchMin: 8 }) // a stale capture would keep reporting 2
    expect(isEmail.stats.batchMin).toBe(8)

    // n=2 now routes through the scalar loop (threshold raised), so the batch
    // counter must not advance.
    const beforeBatch = l.stats.batchCalls
    l.run('validateEmail', [EMAIL_OK, EMAIL_BAD])
    expect(l.stats.batchCalls).toBe(beforeBatch)
  })

  test('opFn dispatches stay visible in loader.stats after configure', () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    l.configure({ sampleEvery: 64 }) // rebuilds ctxs + rebinds op fns
    const before = l.stats.scalarCalls
    isEmail(EMAIL_OK)
    expect(l.stats.scalarCalls).toBeGreaterThan(before)
  })

  test('configure clamps batchMin and rebuilds the cache on capacity change', async () => {
    const l = createLoader({ maxCacheKeys: 5 })
    l.configure({ batchMin: 99 })
    expect(l('validateEmail').stats.batchMin).toBe(8) // clamped to [2, 8]

    await l('validateEmail').load(EMAIL_OK) // populate the old cache
    l.configure({ maxCacheKeys: 10 })
    expect(l.stats.cacheSize).toBe(0) // rebuilt → old entries are gone
  })
})

describe('loader: load() availability guard', () => {
  test('load() exists on no-rest ops and is absent on required-rest ops', () => {
    // Mirrors `hasRequiredRest` in src/loader/index.ts — guards against drift
    // between the LoadableName type and the runtime allowlist. Includes every
    // op with required extra args OR per-item companions (can't be coalesced).
    const REQUIRED_REST: LoaderOpName[] = [
      'signCookie',
      'verifyCookie',
      'csrfVerify',
      'passwordHash',
      'passwordVerify',
      'hmacSha256',
      'hmacSha256Verify',
      'aeadEncrypt',
      'aeadDecrypt',
      'jwtSign',
      'jwtVerify',
      'jsonPatch',
      'urlResolve',
      'wsFrameEncode',
      'schemaValidate',
    ]
    const l = createLoader()
    for (const name of LOADER_OP_NAMES) {
      const fn = l(name)
      if (REQUIRED_REST.includes(name)) {
        expect(fn.load, name).toBeUndefined()
      } else {
        expect(typeof fn.load, name).toBe('function')
      }
    }
  })
})

describe('loader: load-aware single↔coalesce strategy', () => {
  test('low sustained load switches load() to direct singles (no flush)', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    // 4 isolated single loads (unique inputs so they reach the flush, not the
    // cache) → each flushes alone → streak reaches SINGLE_AFTER.
    for (let i = 0; i < 4; i++) {
      expect(await isEmail.load(bytes(`user${i}@example.com`))).toBe(true)
    }
    expect(isEmail.stats.mode).toBe('single')

    const flushesBefore = l.stats.flushes
    const scalarBefore = l.stats.scalarCalls
    expect(await isEmail.load(EMAIL_BAD)).toBe(false)
    // Single mode dispatches the scalar directly — no coalescer flush.
    expect(l.stats.flushes).toBe(flushesBefore)
    expect(l.stats.scalarCalls).toBeGreaterThan(scalarBefore)
  })

  test('a same-tick burst switches a single-mode op back to bulk', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    // Unique inputs so the streak is built from real flushes, not cache hits.
    for (let i = 0; i < 4; i++) {
      await isEmail.load(bytes(`user${i}@example.com`))
    }
    expect(isEmail.stats.mode).toBe('single')

    const flushesBefore = l.stats.flushes
    const [a, b, c] = await Promise.all([
      isEmail.load(EMAIL_OK),
      isEmail.load(EMAIL_BAD),
      isEmail.load(EMAIL_OK),
    ])
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(c).toBe(true)
    expect(isEmail.stats.mode).toBe('coalesce') // burst → back to bulk
    expect(l.stats.flushes).toBe(flushesBefore + 1) // ONE coalesced flush
  })

  test("loadStrategy: 'single' dispatches direct scalars from the start", async () => {
    const l = createLoader({ loadStrategy: 'single' })
    const before = l.stats.scalarCalls
    expect(await l('validateEmail').load(EMAIL_OK)).toBe(true)
    expect(l.stats.scalarCalls).toBeGreaterThan(before)
    expect(l.stats.flushes).toBe(0) // never touched the coalescer
  })

  test("loadStrategy: 'coalesce' always batches same-tick loads", async () => {
    const l = createLoader({ loadStrategy: 'coalesce' })
    const before = l.stats.batchCalls
    const [a, b] = await Promise.all([
      l('validateEmail').load(EMAIL_OK),
      l('validateEmail').load(EMAIL_BAD),
    ])
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(l.stats.batchCalls).toBe(before + 1)
  })
})

describe('loader: adaptive default cache key', () => {
  test('keys are skipped once inputs prove unique (no cache growth)', async () => {
    const l = createLoader()
    const crc = l('crc32')
    for (let i = 0; i < 8; i++) {
      await crc.load(bytes(`unique-${i}`)) // warm-up keys all computed
    }
    expect(l.stats.cacheSize).toBe(8)
    for (let i = 8; i < 12; i++) {
      await crc.load(bytes(`unique-${i}`)) // keys skipped → no writes
    }
    expect(l.stats.cacheSize).toBe(8)
    expect(crc.cache(bytes('unique-9'))).toBeUndefined()
  })

  test('repeated inputs still hit the cache (keys not skipped)', async () => {
    const l = createLoader()
    const isEmail = l('validateEmail')
    // Warm up the cache with the repeated key (keys computed during warm-up).
    expect(await isEmail.load(EMAIL_OK)).toBe(true)
    expect(isEmail.cache(EMAIL_OK)).toBe(true)
    // Keep computing keys for the repeated workload (keyHits > 0).
    expect(await isEmail.load(EMAIL_OK)).toBe(true)
    expect(l.stats.cachedHits).toBeGreaterThan(0)
  })
})
