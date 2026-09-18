/**
 * Regression guard for the memoized `Headers` used by the pre-baked success
 * path (`buildSuccessInit`, src/ingress/routes/common.ts).
 *
 * `new Response(body, { headers })` is ~4x cheaper when handed a recurring
 * `Headers` instance than the equivalent array-of-pairs, so `buildSuccessInit`
 * memoizes one `Headers` per baked header array. That optimization is only safe
 * if the cached `Headers` is never mutated: the Response constructor must copy
 * it, and mutating a SERVED response's headers must never leak into the next
 * response built from the same cache.
 *
 * These tests pin the observable contract (correct header values + isolation),
 * so a future change that shares mutable header state fails here rather than
 * in production.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler, readHandler } from '../../../src/ingress/handlers'

// No request-id emission and no Origin => `responseHeaders` returns the frozen
// baked template, i.e. the recurring-array case the memo targets.
const OPTIONS = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
}
const RUNTIME = {
  securityHeaders: [
    ['x-frame-options', 'DENY'],
    ['content-security-policy', "default-src 'self'"],
  ] as [string, string][],
}

const get = (path = '/health', init?: RequestInit): Request =>
  new Request(`http://localhost:9999${path}`, init)

describe('memoized success headers', () => {
  test('serves the full baked header set on every request', async () => {
    const read = readHandler(createIngressHandler(OPTIONS, RUNTIME))
    for (let i = 0; i < 3; i++) {
      const res = await read(get())
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
      expect(res.headers.get('content-type')).toBe('application/json')
    }
  })

  test("mutating a served response's headers never leaks into the next response", async () => {
    const read = readHandler(createIngressHandler(OPTIONS, RUNTIME))

    const first = await read(get())
    expect(first.headers.get('x-frame-options')).toBe('DENY')
    // Mutate the SERVED response's header list (a copy — must not touch the
    // cached source).
    first.headers.set('x-frame-options', 'MUTATED')
    first.headers.set('x-leak', '1')

    const second = await read(get())
    expect(second.headers.get('x-frame-options')).toBe('DENY')
    expect(second.headers.get('x-leak')).toBeNull()

    // And two live responses from the same cache stay independent.
    const third = await read(get())
    second.headers.set('x-only-second', '1')
    expect(third.headers.get('x-only-second')).toBeNull()
  })

  test('CORS-origin header sets are cached per origin and stay isolated', async () => {
    const handler = createIngressHandler(
      {
        ...OPTIONS,
        cors: { allowOrigin: ['https://a.example.com', 'https://b.example.com'] },
      },
      RUNTIME,
    )
    const read = readHandler(handler)
    const a = await read(get('/health', { headers: { origin: 'https://a.example.com' } }))
    const b = await read(get('/health', { headers: { origin: 'https://b.example.com' } }))
    expect(a.headers.get('access-control-allow-origin')).toBe('https://a.example.com')
    expect(b.headers.get('access-control-allow-origin')).toBe('https://b.example.com')
    // Re-request origin A: still A (no cross-origin bleed from the shared cache).
    const a2 = await read(get('/health', { headers: { origin: 'https://a.example.com' } }))
    expect(a2.headers.get('access-control-allow-origin')).toBe('https://a.example.com')
  })
})
