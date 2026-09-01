// test/unit/ingress/native-route-public.test.ts — Public `createNativeRoute`
// surface + the router `native` route kind (route-wire v3 in castrum).
//
// The lean per-route native stack (`rust/ingress/native_route.rs`) is now a
// first-class castrum surface: `createNativeRoute` compiles a plan once and
// runs each frame in ONE native call; `nativeRouteHandler` wraps it as a
// `RouteHandler`; `createIngressRouter`'s `native` route spec wires it into a
// server. This suite pins the public API behavior (verdicts, lenient parse,
// error codes, the router integration) — the raw wire round-trip and
// lenient-parse parity vectors stay in `native-route.test.ts`.

import { describe, expect, test } from 'bun:test'
import {
  createIngressRouter,
  createNativeRoute,
  encodeRouteDescriptor,
  type NativeRoutePlan,
  packRouteFrame,
  ROUTE_FLAG,
} from '../../../src/ingress'

const enc = new TextEncoder()

/** Compile a plan through the public factory (skips when no addon route stack). */
function tryCompile(plan: NativeRoutePlan) {
  try {
    return createNativeRoute(plan)
  } catch {
    return null // addon without the route stack (pre-rebuild) — skip
  }
}

describe('createNativeRoute (public route-wire v3 surface)', () => {
  test('parseQuery+parseCookies: lenient decode + OK flag', () => {
    const route = tryCompile({ parseQuery: true, parseCookies: true })
    if (!route) return
    const r = route.run('page=1&limit=20&q=hello%20world', 'session=abc; theme=dark', null)
    expect(r.errorCode).toBe(0)
    expect(r.flags & ROUTE_FLAG.OK).toBe(ROUTE_FLAG.OK)
    expect(r.query).toEqual([
      ['page', '1'],
      ['limit', '20'],
      ['q', 'hello world'],
    ])
    expect(r.cookie).toEqual([
      ['session', 'abc'],
      ['theme', 'dark'],
    ])
    route.destroy()
  })

  test('lenient parse passes malformed %ZZ through raw (byte-parity)', () => {
    const route = tryCompile({ parseQuery: true })
    if (!route) return
    const r = route.run('m=%ZZ&n=abc%', '', null)
    expect(r.query).toEqual([
      ['m', '%ZZ'],
      ['n', 'abc%'],
    ])
    route.destroy()
  })

  test('requireJsonBody: non-JSON → 400, well-formed → 0', () => {
    const route = tryCompile({ requireJsonBody: true })
    if (!route) return
    const bad = route.run('', '', enc.encode('not json'))
    expect(bad.errorCode).toBe(400)
    expect(bad.flags & ROUTE_FLAG.OK).toBe(0)
    const ok = route.run('', '', enc.encode('{"x":1}'))
    expect(ok.errorCode).toBe(0)
    expect(ok.flags & ROUTE_FLAG.BODY_VALID_JSON).toBe(ROUTE_FLAG.BODY_VALID_JSON)
    route.destroy()
  })

  test('validateBody: schema fail → 422, pass → 0', () => {
    const schema = enc.encode(
      JSON.stringify({
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'number' } },
      }),
    )
    const route = tryCompile({ validateBody: true, schema })
    if (!route) return
    const bad = route.run('', '', enc.encode('{"x":"str"}'))
    expect(bad.errorCode).toBe(422)
    const good = route.run('', '', enc.encode('{"x":1}'))
    expect(good.errorCode).toBe(0)
    expect(good.flags & ROUTE_FLAG.BODY_VALID).toBe(ROUTE_FLAG.BODY_VALID)
    route.destroy()
  })

  test('runFrame accepts a hand-packed frame (same wire as run)', () => {
    const route = tryCompile({ parseQuery: true })
    if (!route) return
    const frame = packRouteFrame('a=1', '', null)
    const r = route.runFrame(frame)
    expect(r.query).toEqual([['a', '1']])
    route.destroy()
  })

  test('descriptor encode is stable (magic + version + stages + schema)', () => {
    const schema = enc.encode('{"type":"object"}')
    const desc = encodeRouteDescriptor(
      [0, 1, 4, 5], // parseQuery, parseCookies, validateBody, requireJsonBody
      [{ part: 3, bytes: schema }],
      { maxBodyBytes: 1024, maxQueryBytes: 512, maxCookieBytes: 512, maxPairs: 0 },
    )
    const view = new DataView(desc.buffer)
    expect(view.getUint32(0, true)).toBe(0x524f5554) // ROUT
    expect(view.getUint32(4, true)).toBe(3) // version 3
    expect(view.getUint32(24, true)).toBe(4) // stageCount
    expect(desc[28]).toBe(0)
    expect(desc[29]).toBe(1)
    expect(desc[30]).toBe(4)
    expect(desc[31]).toBe(5)
    expect(view.getUint32(32, true)).toBe(1) // schemaCount
    expect(desc[36]).toBe(3) // part: body
  })
})

describe('router native route kind (lean responder)', () => {
  const router = createIngressRouter({
    routes: {
      '/api/native': {
        native: {
          plan: { parseQuery: true, parseCookies: true },
          handler: (snap) =>
            Response.json({
              ok: true,
              requestId: snap.requestId,
              query: snap.query,
              cookies: snap.cookies,
            }),
        },
      },
    },
  })

  test('serves GET with decoded query + cookies', async () => {
    const res = await router.fetch(
      new Request('http://localhost:0/api/native?page=2', { headers: { cookie: 'sid=v' } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      requestId: string
      query: Record<string, string>
      cookies: Record<string, string>
    }
    expect(body.ok).toBe(true)
    expect(typeof body.requestId).toBe('string')
    expect(body.query).toEqual({ page: '2' })
    expect(body.cookies).toEqual({ sid: 'v' })
  })

  test('unwired method → 405 (only GET wired by default)', async () => {
    const res = await router.fetch(
      new Request('http://localhost:0/api/native?page=2', { method: 'POST' }),
    )
    expect(res.status).toBe(405)
  })
})

describe('nativeRouteHandler (lean responder factory)', () => {
  test('terminal 422 on schema failure, 2xx on success', async () => {
    const { nativeRouteHandler } = await import('../../../src/ingress/routes/native')
    const schema = enc.encode(
      JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'number' } } }),
    )
    const route = createNativeRoute({ validateBody: true, schema })
    const handler = nativeRouteHandler(
      route,
      (snap) => Response.json({ ok: true, bodyOk: snap.body.byteLength > 0 }),
      { readBody: true },
    )
    const bad = await handler(
      new Request('http://localhost:0/api/native', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"x":"str"}',
      }),
    )
    expect(bad.status).toBe(422)
    const good = await handler(
      new Request('http://localhost:0/api/native', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"x":1}',
      }),
    )
    expect(good.status).toBe(200)
    route.destroy()
  })
})
