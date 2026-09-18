// test/unit/ingress/server-error.test.ts — escaped-handler fault containment:
// the shared masked-500 responder + route guard, the Bun/Node wiring, and the
// `onError` observability hook.

import { describe, expect, test } from 'bun:test'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { buildRouteHandlers, createIngressServer } from '../../../src/ingress/server'
import { createIngressServerNode } from '../../../src/ingress/server-node'
import { createServerErrorHandler, guardRouteHandler } from '../../../src/ingress/server-error'

const INTERNAL_BODY =
  '{"ok":false,"error":{"code":"internal_error","message":"Internal server error"}}'

test('sync throw becomes a generic 500 with no thrown text', async () => {
  const handler = guardRouteHandler(() => {
    throw new Error('secret-db-password')
  }, createServerErrorHandler({}))
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  const body = await res.text()
  expect(body).toBe(INTERNAL_BODY)
  expect(body).not.toContain('secret-db-password')
})

test('async rejection becomes a generic 500', async () => {
  const handler = guardRouteHandler(async () => {
    throw new Error('secret-2')
  }, createServerErrorHandler({}))
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain('secret-2')
})

test('onError sees the real error, runs once, and cannot break the response', async () => {
  let calls = 0
  const onServerError = createServerErrorHandler({
    onError: (info) => {
      calls++
      expect(info.error.message).toBe('boom')
      throw new Error('hook-broke')
    },
  })
  const handler = guardRouteHandler(() => {
    throw new Error('boom')
  }, onServerError)
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  expect(calls).toBe(1)
})

test('success path is unaffected (no wrapping overhead semantics change)', async () => {
  const handler = guardRouteHandler(() => new Response('ok'), createServerErrorHandler({}))
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})

describe('route wiring', () => {
  test('a raw read function that throws is contained (Bun) and reports via onError', async () => {
    const seen: string[] = []
    const { routes } = buildRouteHandlers({
      routes: {
        '/boom': {
          read: () => {
            throw new Error('leak-secret')
          },
        },
      },
      onError: (info) => {
        seen.push(info.error.message)
      },
    })
    const handler = routes['/boom'].GET as (req: Request) => Response | Promise<Response>
    const res = await handler(new Request('http://x/boom'))
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toBe(INTERNAL_BODY)
    expect(body).not.toContain('leak-secret')
    expect(seen).toEqual(['leak-secret'])
  })

  test('a responder that throws is contained and masked', async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const { routes } = buildRouteHandlers({
      routes: {
        '/r': {
          responder: {
            ingress,
            handler: () => {
              throw new Error('responder-secret')
            },
          },
        },
      },
    })
    const handler = routes['/r'].GET as (req: Request) => Response | Promise<Response>
    const res = await handler(new Request('http://x/r'))
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toBe(INTERNAL_BODY)
    expect(body).not.toContain('responder-secret')
  })

  test('createIngressServer forwards onError and masks the failure on the wire', async () => {
    const seen: string[] = []
    const srv = createIngressServer({
      port: 0,
      routes: {
        '/boom': {
          read: async () => {
            throw new Error('bun-secret')
          },
        },
      },
      onError: (info) => {
        seen.push(info.error.message)
      },
    })

    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/boom`)
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toBe(INTERNAL_BODY)
      expect(body).not.toContain('bun-secret')
      expect(seen).toEqual(['bun-secret'])
    } finally {
      srv.stop()
    }
  })

  test('createIngressServerNode emits the same masked 500 and forwards onError', async () => {
    const seen: string[] = []
    const srv = createIngressServerNode({
      port: 0,
      routes: {
        '/boom': {
          read: () => {
            throw new Error('node-secret')
          },
        },
      },
      onError: (info) => {
        seen.push(info.error.message)
      },
    })

    const port = await srv.ready
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`, {
        headers: { connection: 'close' },
      })
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toBe(INTERNAL_BODY)
      expect(body).not.toContain('node-secret')
      expect(seen).toEqual(['node-secret'])
    } finally {
      srv.stop()
    }
  })

  test('the Node adapter catch-all reuses the shared body + onError hook', async () => {
    // `getIp` runs inside a BUILT-IN factory (unwrapped), so this escapes to
    // the adapter catch-all rather than the route guard — proving the adapter
    // itself routes through `createServerErrorHandler`.
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const seen: string[] = []
    const srv = createIngressServerNode({
      port: 0,
      routes: { '/x': { read: ingress } },
      getIp: () => {
        throw new Error('ip-boom')
      },
      onError: (info) => {
        seen.push(info.error.message)
      },
    })

    const port = await srv.ready
    try {
      const res = await fetch(`http://127.0.0.1:${port}/x`, {
        headers: { connection: 'close' },
      })
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toBe(INTERNAL_BODY)
      expect(body).not.toContain('ip-boom')
      expect(seen).toEqual(['ip-boom'])
    } finally {
      srv.stop()
    }
  })
})
