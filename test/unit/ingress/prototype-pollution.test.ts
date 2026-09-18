// test/unit/ingress/prototype-pollution.test.ts — request-derived object
// materialization must treat `__proto__` / `constructor` / `prototype` as inert
// own data.
//
// castrum's native parsers return packed pairs; JS turns request-derived data
// into objects in two places — the responder bridge's JSON section decode
// (`parseSection`) and the lean native-route pair decode (`pairsToRecord`).
// Both must be prototype-safe: a query/cookie/body key of `__proto__` must not
// reach `Object.prototype`, and a `constructor` key must not replace the
// record's constructor.

import { describe, expect, test } from 'bun:test'
import { createIngressHandler, createNativeRoute, nativeResponderRoute } from '../../../src/ingress'
import { nativeRouteHandler, pairsToRecord } from '../../../src/ingress/routes/native'
import { parseSection } from '../../../src/ingress/routes/responder'

describe('parseSection (JSON → object)', () => {
  test('__proto__ key is inert own data (never pollutes)', () => {
    const rec = parseSection('{"__proto__":{"polluted":true},"a":1}')
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    expect(rec.a).toBe(1)
    expect(Object.getPrototypeOf(rec)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(true)
    // The value is reachable as an OWN data property, not via the setter.
    expect((rec as { __proto__?: unknown }).__proto__).toEqual({ polluted: true })
  })

  test('constructor key does not replace the object constructor', () => {
    const rec = parseSection('{"constructor":"evil"}')
    expect(typeof rec.constructor).not.toBe('function')
    expect((rec as { [key: string]: unknown })['constructor']).toBe('evil')
    expect(Object.getPrototypeOf(rec)).toBeNull()
    // The global constructor is untouched.
    expect(Object.prototype.constructor).toBe(Object)
  })

  test('malformed / non-object JSON → empty prototype-safe record', () => {
    for (const bad of ['not json', 'null', '42', '[1,2]', '"str"']) {
      const rec = parseSection(bad)
      expect(Object.getPrototypeOf(rec)).toBeNull()
      expect(Object.keys(rec)).toHaveLength(0)
    }
  })
})

describe('pairsToRecord (packed pairs → object)', () => {
  test('__proto__ pair is inert own data (never pollutes)', () => {
    const rec = pairsToRecord([
      ['__proto__', 'polluted'],
      ['a', '1'],
    ])
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    expect(rec.a).toBe('1')
    expect(Object.getPrototypeOf(rec)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(true)
    expect((rec as { __proto__?: unknown }).__proto__).toBe('polluted')
  })

  test('constructor pair does not replace the object constructor', () => {
    const rec = pairsToRecord([['constructor', 'evil']])
    expect(typeof rec.constructor).not.toBe('function')
    expect((rec as { [key: string]: unknown })['constructor']).toBe('evil')
    expect(Object.prototype.constructor).toBe(Object)
  })

  test('prototype pair is inert and keys stay last-wins', () => {
    const rec = pairsToRecord([
      ['prototype', 'polluted'],
      ['a', '1'],
      ['a', '2'],
    ])
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    expect(rec.prototype).toBe('polluted')
    expect(rec.a).toBe('2')
  })
})

describe('real route paths end-to-end', () => {
  /** Own-key reader that bypasses the built-in `.constructor` Function type. */
  const own = (rec: unknown, key: string): unknown =>
    (rec as { [key: string]: unknown } | null)?.[key]

  test('nativeResponderRoute: __proto__ query/cookie is inert in the snapshot', async () => {
    const handler = createIngressHandler({ parseQuery: true, parseCookies: true })
    let query: unknown
    let cookies: unknown
    const route = nativeResponderRoute(handler, (snap) => {
      query = snap.query
      cookies = snap.cookies
      return new Response('{}', { status: 200 })
    })

    const res = await route(
      new Request('http://localhost/x?__proto__=polluted&a=1', {
        headers: { cookie: '__proto__=polluted; sid=abc' },
      }),
    )
    expect(res.status).toBe(200)
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(query)).toBeNull()
    expect(Object.getPrototypeOf(cookies)).toBeNull()
    expect(own(query, 'a')).toBe('1')
    expect(own(cookies, '__proto__')).toBe('polluted')
  })

  test('nativeRouteHandler: __proto__ pair is inert in the snapshot', async () => {
    let route: ReturnType<typeof createNativeRoute>
    try {
      route = createNativeRoute({ parseQuery: true, parseCookies: true })
    } catch {
      return // addon without the route stack — skip
    }
    let query: unknown
    const handler = nativeRouteHandler(route, (snap) => {
      query = snap.query
      return new Response('{}', { status: 200 })
    })

    const res = await handler(new Request('http://localhost/x?__proto__=polluted&a=1'))
    expect(res.status).toBe(200)
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(query)).toBeNull()
    expect(own(query, 'a')).toBe('1')
  })
})
