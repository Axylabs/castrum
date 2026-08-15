/**
 * Tests for `createIngressRouter` — the per-route compiled ingress router.
 *
 * Verifies: (1) per-route native instances are compiled with that route's
 * options, (2) per-route dispatch (path + method), (3) raw handlers bypass the
 * pipeline, (4) dynamic `:param`/`*` routes, (5) 404/405, (6) pre-warm runs a
 * probe through every compiled handler, and (7) the `routes` map is
 * Bun.serve / Node-adapter compatible.
 */

import { describe, test, expect } from 'bun:test'
import { createIngressRouter } from '../../../src/ingress/router'
import { createIngressHandler } from '../../../src/ingress/handlers'
import type { OptimizedIngressHandler } from '../../../src/ingress/types'

describe('createIngressRouter', () => {
  test('compiles a dedicated native instance per route with that route options', () => {
    const router = createIngressRouter({
      routes: {
        '/health': { read: true, options: { parseCookies: false, parseQuery: false } },
        '/api/users': {
          read: true,
          write: true,
          options: { parseCookies: true, parseQuery: true, requireJsonBody: true },
        },
      },
    })
    // Each pipeline-backed route gets its own compiled handler.
    expect(typeof router.routeHandlers['/health']).toBe('object')
    expect(typeof router.routeHandlers['/api/users']).toBe('object')
    // Distinct options → distinct instances.
    expect(router.routeHandlers['/health']).not.toBe(router.routeHandlers['/api/users'])
    // The routes map has the method wiring (Bun.serve-compatible shape).
    expect(typeof router.routes['/health'].GET).toBe('function')
    expect(typeof router.routes['/health'].HEAD).toBe('function')
    expect(typeof router.routes['/api/users'].POST).toBe('function')
    expect(typeof router.routes['/api/users'].PUT).toBe('function')
    expect(typeof router.routes['/api/users'].PATCH).toBe('function')
  })

  test('matches exact paths and dispatches GET/HEAD/POST/DELETE', async () => {
    const router = createIngressRouter({
      routes: {
        '/health': { read: true, options: { parseCookies: false, parseQuery: false } },
        '/api/users': { read: true, write: true, options: { parseCookies: true, parseQuery: true } },
        '/api/echo': { echo: true, options: { parseCookies: false, parseQuery: false } },
        '/api/thing': { delete: true, options: { parseCookies: false, parseQuery: false } },
      },
    })

    expect((await router.fetch(new Request('http://x/health'))).status).toBe(200)
    expect((await router.fetch(new Request('http://x/health', { method: 'HEAD' }))).status).toBe(200)
    expect(
      (
        await router.fetch(
          new Request('http://x/api/users', {
            method: 'POST',
            body: '{"a":1}',
            headers: { 'content-type': 'application/json' },
          }),
        )
      ).status,
    ).toBe(200)
    expect((await router.fetch(new Request('http://x/api/thing', { method: 'DELETE' }))).status).toBe(
      200,
    )
    // echo returns the body back.
    const echoRes = await router.fetch(
      new Request('http://x/api/echo', {
        method: 'POST',
        body: 'hello',
        headers: { 'content-type': 'text/plain' },
      }),
    )
    expect(echoRes.status).toBe(200)
    expect(await echoRes.text()).toBe('hello')
  })

  test('raw handlers bypass the pipeline', async () => {
    const raw = () => new Response('raw-ok', { status: 201 })
    const router = createIngressRouter({
      routes: { '/metrics': { raw }, '/health': { read: true } },
    })
    const res = await router.fetch(new Request('http://x/metrics'))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('raw-ok')
    // Raw routes are NOT in routeHandlers (no native instance compiled).
    expect(router.routeHandlers['/metrics']).toBeUndefined()
  })

  test('matches dynamic :param and * routes via the path matcher', async () => {
    const router = createIngressRouter({
      routes: {
        '/users/:id': { read: true, options: { parseCookies: false, parseQuery: false } },
        '/files/*': { read: true, options: { parseCookies: false, parseQuery: false } },
      },
    })
    const m1 = router.match('/users/42')
    expect(m1).toBeDefined()
    expect(m1?.params.id).toBe('42')
    const m2 = router.match('/files/a/b/c')
    expect(m2).toBeDefined()
    expect(m2?.params['*']).toBe('a/b/c')
    expect((await router.fetch(new Request('http://x/users/42'))).status).toBe(200)
    expect((await router.fetch(new Request('http://x/files/x/y'))).status).toBe(200)
  })

  test('returns 404 for unmatched paths and 405 for unwired methods', async () => {
    const router = createIngressRouter({
      routes: { '/health': { read: true, options: { parseCookies: false, parseQuery: false } } },
    })
    expect((await router.fetch(new Request('http://x/nope'))).status).toBe(404)
    expect((await router.fetch(new Request('http://x/health', { method: 'DELETE' }))).status).toBe(
      405,
    )
  })

  test('prewarm runs a probe through every compiled handler without throwing', () => {
    const router = createIngressRouter({
      warmOnCreate: true,
      routes: {
        '/health': { read: true, options: { parseCookies: false, parseQuery: false } },
        '/api/users': { read: true, write: true, options: { parseCookies: true, parseQuery: true } },
        '/metrics': { raw: () => new Response('metrics') },
      },
    })
    // Pre-warm ran at construction; running it again is a no-op-safe.
    router.prewarm()
    expect(Object.keys(router.routeHandlers)).toContain('/health')
    expect(Object.keys(router.routeHandlers)).toContain('/api/users')
  })

  test('the compiled handler is a real OptimizedIngressHandler (usable directly)', () => {
    const router = createIngressRouter({
      routes: { '/health': { read: true, options: { parseCookies: false, parseQuery: false } } },
    })
    const handler = router.routeHandlers['/health'] as OptimizedIngressHandler
    const res = handler.run<Response>(
      new Request('http://x/health'),
      '127.0.0.1',
      null,
      (result, ctx) => {
        const terminal = handler.terminalResponse(undefined, result, ctx)
        return terminal ?? new Response(result.bodyJson(true), { status: 200 })
      },
    )
    expect(res.status).toBe(200)
  })

  test('a route with no pipeline-backed specs compiles no native instance', () => {
    const router = createIngressRouter({
      routes: { '/plain': { raw: () => new Response('plain') } },
    })
    expect(Object.keys(router.routeHandlers)).toHaveLength(0)
    expect(router.routes['/plain']).toBeDefined()
  })

  test('shares the same rate-limit budget across routes (no route-splitting bypass)', async () => {
    // Two routes with IDENTICAL rate-limit config share one process-wide
    // budget (SHARED_LIMITERS keys by configuration). The router compiles two
    // handlers but both resolve to the same shared limiter — a burst on /a
    // must deplete /b.
    const rateOpts = { limit: 2, windowMs: 60_000 }
    const router = createIngressRouter({
      routes: {
        '/a': { read: true, options: { rateLimit: rateOpts, parseCookies: false, parseQuery: false } },
        '/b': { read: true, options: { rateLimit: rateOpts, parseCookies: false, parseQuery: false } },
      },
    })
    const req = (p: string) => new Request(`http://x${p}`)
    // Drain the shared budget across both routes.
    await router.fetch(req('/a'))
    await router.fetch(req('/a'))
    // Third request (on /b) is rate-limited because the budget is shared.
    const res = await router.fetch(req('/b'))
    expect(res.status).toBe(429)
  })

  test('createIngressHandler and createIngressRouter compile identical wire output', async () => {
    const opts = { parseCookies: true, parseQuery: true, requireJsonBody: true }
    const router = createIngressRouter({ routes: { '/x': { read: true, options: opts } } })
    const direct = createIngressHandler(opts)
    const req = new Request('http://x/x?a=1', { method: 'GET', headers: { cookie: 'c=1' } })

    const viaRouter = router.routeHandlers['/x'].run<Response>(req, '127.0.0.1', null, (r, ctx) => {
      const t = router.routeHandlers['/x'].terminalResponse(undefined, r, ctx)
      return t ?? new Response(r.bodyJson(true), { status: 200 })
    })
    const viaDirect = direct.run<Response>(req, '127.0.0.1', null, (r, ctx) => {
      const t = direct.terminalResponse(undefined, r, ctx)
      return t ?? new Response(r.bodyJson(true), { status: 200 })
    })
    expect(viaRouter.status).toBe(viaDirect.status)
    expect(await viaRouter.text()).toBe(await viaDirect.text())
  })
})

describe('router path-traversal defense', () => {
  const traversalRouter = () =>
    createIngressRouter({
      routes: {
        '/admin': { read: true, options: { parseCookies: false, parseQuery: false } },
        '/files/*': { read: true, options: { parseCookies: false, parseQuery: false } },
      },
    })

  test('dot-segment URLs are normalized at the URL layer (canonical dispatch, no escape)', async () => {
    const router = traversalRouter()
    // Bun's URL parser resolves dot-segments BEFORE the router dispatches, so a
    // traversal request collapses to its canonical path and dispatches to the
    // canonical route — there is no parent-route escape possible.
    expect((await router.fetch(new Request('http://x/../admin'))).status).toBe(200)
    expect((await router.fetch(new Request('http://x/users/../../admin'))).status).toBe(200)
    expect((await router.fetch(new Request('http://x/..\\admin'))).status).toBe(200)
    // A traversal that collapses to an UNREGISTERED path is still a 404.
    expect((await router.fetch(new Request('http://x/..'))).status).toBe(404)
    expect((await router.fetch(new Request('http://x/files/../../nope'))).status).toBe(404)
  })

  test('encoded dot-segments are NOT decoded by the router (literal → 404)', async () => {
    const router = traversalRouter()
    expect((await router.fetch(new Request('http://x/%2e%2e%2fadmin'))).status).toBe(404)
    expect((await router.fetch(new Request('http://x/..%2Fadmin'))).status).toBe(404)
    expect(router.match('/%2e%2e%2fadmin')).toBeUndefined()
  })

  test('raw traversal / control-byte path strings match nothing on exact routes', async () => {
    const router = traversalRouter()
    expect(router.match('/../admin')).toBeUndefined()
    expect(router.match('/..\\admin')).toBeUndefined()
    expect(router.match('/\u0000admin')).toBeUndefined()
    expect(router.match('//admin')).toBeUndefined()
  })

  test('a * catch-all passes .. segments through UNNORMALIZED (handler must sanitize)', async () => {
    const router = traversalRouter()
    const m = router.match('/files/../../etc/passwd')
    expect(m).toBeDefined()
    // The wildcard is passed through verbatim — the router does NOT normalize
    // dot-dot segments, so file-serving handlers must resolve paths safely
    // themselves. Pinning this so a future "normalization" change is reviewed.
    expect(m?.params['*']).toBe('../../etc/passwd')
  })
})
