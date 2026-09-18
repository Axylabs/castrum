/**
 * Tests for static route promotion (`BakedRoute.static`) — prebuilt `Response`
 * values served for GET without entering the ingress pipeline.
 *
 * Covers:
 * - `buildRouteHandlers` places `static` in the GET slot verbatim and it takes
 *   precedence over `read` (the pipeline handler never runs).
 * - A real `createIngressServer` (Bun.serve) responds with the prebuilt
 *   status/body/headers.
 * - The one-shot `Response` hazard: hitting the SAME static route twice yields
 *   the full body both times (Bun snapshots the body into its native table; on
 *   Node the adapter re-materializes a fresh `Response` per request).
 * - The node:http adapter serves a bare static `Response` across requests.
 * - `staticLiveness()` returns a prebuilt 200 `Response`.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { staticLiveness } from '../../../src/ingress/health'
import { createIngressRouter } from '../../../src/ingress/router'
import { buildRouteHandlers, createIngressServer } from '../../../src/ingress/server'
import { createIngressServerNode } from '../../../src/ingress/server-node'

function prebuilt(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

describe('buildRouteHandlers: static promotion', () => {
  test('static is placed in the GET slot verbatim and wins over read', () => {
    const prebuiltResponse = prebuilt('static-body', 201, { 'x-kind': 'static' })
    let readCalls = 0
    const readFn = () => {
      readCalls += 1
      return new Response('pipeline')
    }

    const { routes } = buildRouteHandlers({
      routes: { '/livez': { read: readFn, static: prebuiltResponse } },
    })

    expect(routes['/livez'].GET).toBe(prebuiltResponse)
    // The raw read handler must never be wired or invoked when static wins.
    expect(readCalls).toBe(0)
  })

  test('a static route does not wire OPTIONS preflight from the ignored read', () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const { routes } = buildRouteHandlers({
      routes: { '/livez': { read: ingress, static: prebuilt('ok') } },
    })
    expect(routes['/livez'].GET).toBeDefined()
    expect(routes['/livez'].OPTIONS).toBeUndefined()
  })

  test('a factory static value is stored verbatim (fresh Response per call)', () => {
    const factory = () => prebuilt('from-factory', 200, { 'x-factory': 'yes' })
    const { routes } = buildRouteHandlers({
      routes: { '/livez': { static: factory } },
    })
    expect(routes['/livez'].GET).toBe(factory)

    const first = (routes['/livez'].GET as () => Response)()
    const second = (routes['/livez'].GET as () => Response)()
    expect(first).not.toBe(second)
  })
})

describe('createIngressServer (Bun): static route', () => {
  test('serves the prebuilt status/body/headers', async () => {
    const body = 'static-json-ish-payload'
    const srv = createIngressServer({
      port: 0,
      routes: {
        '/livez': {
          static: new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-static': 'yes' },
          }),
        },
      },
    })

    const base = `http://127.0.0.1:${srv.port}`
    try {
      const res = await fetch(`${base}/livez`)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-static')).toBe('yes')
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(await res.text()).toBe(body)
    } finally {
      srv.stop()
    }
  })

  test('hitting the same static route twice yields the full body both times', async () => {
    const body = `one-shot-hazard-${'x'.repeat(4096)}`
    const srv = createIngressServer({
      port: 0,
      routes: { '/livez': { static: prebuilt(body) } },
    })

    const base = `http://127.0.0.1:${srv.port}`
    try {
      const first = await fetch(`${base}/livez`)
      const second = await fetch(`${base}/livez`)
      const third = await fetch(`${base}/livez`)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(third.status).toBe(200)
      expect(await first.text()).toBe(body)
      expect(await second.text()).toBe(body)
      expect(await third.text()).toBe(body)
    } finally {
      srv.stop()
    }
  })

  test('bypasses the ingress pipeline entirely (marker counter stays 0)', async () => {
    let pipelineCalls = 0
    const ingress = createIngressHandler(
      { emitMetadataJson: true },
      {
        onRequest: () => {
          pipelineCalls += 1
        },
      },
    )

    const srv = createIngressServer({
      port: 0,
      routes: {
        '/livez': { read: ingress, static: staticLiveness() },
        '/dynamic': { read: ingress },
      },
    })

    const base = `http://127.0.0.1:${srv.port}`
    try {
      const live = await fetch(`${base}/livez`)
      expect(live.status).toBe(200)
      expect(await live.text()).toBe('{"status":"ok"}')
      // The native pipeline never ran for the static route.
      expect(pipelineCalls).toBe(0)

      // Control: the same ingress on a non-static route DOES run the pipeline,
      // proving the counter would have observed it.
      const dyn = await fetch(`${base}/dynamic`)
      expect(dyn.status).toBe(200)
      expect(pipelineCalls).toBeGreaterThan(0)
    } finally {
      srv.stop()
    }
  })

  test('a static factory returning a fresh Response works across requests', async () => {
    const body = `factory-${'y'.repeat(2048)}`
    const srv = createIngressServer({
      port: 0,
      routes: {
        '/livez': {
          static: () => new Response(body, { status: 200, headers: { 'x-factory': 'yes' } }),
        },
      },
    })

    const base = `http://127.0.0.1:${srv.port}`
    try {
      const a = await fetch(`${base}/livez`)
      const b = await fetch(`${base}/livez`)
      expect(await a.text()).toBe(body)
      expect(await b.text()).toBe(body)
      expect(b.headers.get('x-factory')).toBe('yes')
    } finally {
      srv.stop()
    }
  })
})

describe('createIngressServerNode: static route', () => {
  test('serves a bare static Response across requests (fresh per request)', async () => {
    const body = `node-static-${'z'.repeat(4096)}`
    const srv = createIngressServerNode({
      port: 0,
      routes: {
        '/livez': {
          static: new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/plain', 'x-static': 'node' },
          }),
        },
      },
    })

    const port = await srv.ready
    try {
      const first = await fetch(`http://127.0.0.1:${port}/livez`, {
        headers: { connection: 'close' },
      })
      const second = await fetch(`http://127.0.0.1:${port}/livez`, {
        headers: { connection: 'close' },
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.headers.get('x-static')).toBe('node')
      expect(await first.text()).toBe(body)
      expect(await second.text()).toBe(body)
    } finally {
      srv.stop()
    }
  })

  test('concurrent first requests share one body read (no one-shot race)', async () => {
    const body = `concurrent-${'q'.repeat(4096)}`
    const srv = createIngressServerNode({
      port: 0,
      routes: { '/livez': { static: new Response(body, { status: 200 }) } },
    })

    const port = await srv.ready
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`http://127.0.0.1:${port}/livez`, { headers: { connection: 'close' } }),
        ),
      )
      const texts = await Promise.all(responses.map((r) => r.text()))
      for (const text of texts) {
        expect(text).toBe(body)
      }
    } finally {
      srv.stop()
    }
  })

  test('does not replay a stale content-length framing header', async () => {
    const body = 'framing'
    const srv = createIngressServerNode({
      port: 0,
      routes: {
        '/livez': {
          // Deliberately wrong content-length on the static value.
          static: new Response(body, { status: 200, headers: { 'content-length': '999' } }),
        },
      },
    })

    const port = await srv.ready
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`, {
        headers: { connection: 'close' },
      })
      // The stale framing header must not be replayed (Node streams the body,
      // so it is chunked and exposes no content-length).
      expect(res.headers.get('content-length')).not.toBe('999')
      expect(await res.text()).toBe(body)
    } finally {
      srv.stop()
    }
  })
})

describe('staticLiveness', () => {
  test('returns a prebuilt 200 {"status":"ok"} Response', async () => {
    const res = staticLiveness()
    expect(res instanceof Response).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('{"status":"ok"}')
  })
})

describe('createIngressRouter: static route', () => {
  test('routes table carries the bare Response and fetch clones it per request', async () => {
    const prebuiltResponse = prebuilt('router-static-body')
    const router = createIngressRouter({
      routes: { '/livez': { static: prebuiltResponse } },
    })
    expect(router.routes['/livez'].GET).toBe(prebuiltResponse)

    const first = await router.fetch(new Request('http://localhost/livez'))
    const second = await router.fetch(new Request('http://localhost/livez'))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.text()).toBe('router-static-body')
    expect(await second.text()).toBe('router-static-body')
  })

  test('fetch serves a static factory fresh per request', async () => {
    let n = 0
    const router = createIngressRouter({
      routes: {
        '/n': { static: () => new Response(`n=${++n}`, { status: 200 }) },
      },
    })
    const first = await router.fetch(new Request('http://localhost/n'))
    const second = await router.fetch(new Request('http://localhost/n'))
    expect(await first.text()).toBe('n=1')
    expect(await second.text()).toBe('n=2')
  })
})
