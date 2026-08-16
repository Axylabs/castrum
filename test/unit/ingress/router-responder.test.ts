// test/unit/ingress/router-responder.test.ts — JS responder bridge over the
// native pipeline ("native decides, JS formats the 2xx").
//
// Pins the Phase-1 foundation for delegating a WHOLE request to the per-route
// native `IngressInner` while keeping the 2xx body in JS: native parses/
// validates/decides and emits terminal (rejection) responses in the chosen
// envelope style; a `NativeResponder` builds the 2xx from a decoded snapshot.
// Covers the sync-run/async-responder boundary, both terminal styles, and the
// `createIngressRouter` wiring.

import { describe, expect, test } from 'bun:test'
import {
  createIngressHandler,
  createIngressRouter,
  nativeResponderRoute,
} from '../../../src/ingress'
import { encoder } from '../../../src/shared/bytes'

const schema = encoder.encode(
  JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'number' } } }),
)

describe('nativeResponderRoute (JS responder bridge)', () => {
  test('success path: responder builds the 2xx from the decoded snapshot', async () => {
    const handler = createIngressHandler({ parseQuery: true, parseCookies: true })
    const route = nativeResponderRoute(
      handler,
      (snap) =>
        new Response(
          JSON.stringify({
            ok: true,
            requestId: snap.requestId,
            query: snap.query,
            cookies: snap.cookies,
          }),
          { status: 200 },
        ),
    )

    const req = new Request('http://localhost/api/users?page=1&limit=20', {
      headers: { cookie: 'sid=abc; theme=dark' },
    })
    const res = await route(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      requestId: string
      query: Record<string, string>
      cookies: Record<string, string>
    }
    expect(body.ok).toBe(true)
    expect(typeof body.requestId).toBe('string')
    expect(body.query).toEqual({ page: '1', limit: '20' })
    expect(body.cookies).toEqual({ sid: 'abc', theme: 'dark' })
  })

  test('readBody: valid body is included in the snapshot; invalid → native terminal', async () => {
    const handler = createIngressHandler({ requireJsonBody: true, schema })
    const route = nativeResponderRoute(
      handler,
      (snap) =>
        new Response(JSON.stringify({ ok: true, hasBody: snap.body.byteLength > 0 }), {
          status: 200,
        }),
      { readBody: true },
    )

    const okReq = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    })
    const ok = await route(okReq)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { hasBody: boolean }).hasBody).toBe(true)

    // Schema-invalid body → native terminal 422 (responder never called).
    const badReq = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":"str"}',
    })
    const bad = await route(badReq)
    expect(bad.status).toBe(422)
  })

  test('terminal path, ignex style: {error,status,code} + security headers', async () => {
    const handler = createIngressHandler({ requireJsonBody: true, schema })
    const route = nativeResponderRoute(
      handler,
      () => new Response('responder should not run', { status: 200 }),
      { terminalStyle: 'ignex', readBody: true },
    )
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":"str"}',
    })
    const res = await route(req)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { status: number; error: string; code: string }
    expect(body.status).toBe(422)
    expect(typeof body.error).toBe('string') // ignex: error is the message
    expect(typeof body.code).toBe('string')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('terminal path, castrum style (default): ok:false wire preserved', async () => {
    const handler = createIngressHandler({ requireJsonBody: true, schema })
    const route = nativeResponderRoute(
      handler,
      () => new Response('responder should not run', { status: 200 }),
      { readBody: true },
    )
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":"str"}',
    })
    const res = await route(req)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  test('createIngressRouter wires a responder route for the requested methods', async () => {
    const router = createIngressRouter({
      terminalStyle: 'ignex',
      routes: {
        '/api/users': {
          options: { parseQuery: true },
          responder: {
            methods: ['GET', 'POST'],
            handler: (snap) =>
              new Response(JSON.stringify({ ok: true, q: snap.query }), { status: 200 }),
          },
        },
      },
    })

    const get = router.routes['/api/users']?.GET as (req: Request) => Response | Promise<Response>
    const post = router.routes['/api/users']?.POST as (req: Request) => Response | Promise<Response>
    expect(typeof get).toBe('function')
    expect(typeof post).toBe('function')

    const res = await get(new Request('http://localhost/api/users?page=1'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { q: Record<string, string> }).q).toEqual({ page: '1' })

    // router.fetch dispatches through the same route table.
    const fetched = await router.fetch(new Request('http://localhost/api/users?page=2'))
    expect(fetched.status).toBe(200)
    expect(((await fetched.json()) as { q: Record<string, string> }).q).toEqual({ page: '2' })
  })
})
