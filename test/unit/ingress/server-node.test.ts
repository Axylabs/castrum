/**
 * Tests for `createIngressServerNode` — the node:http adapter over the same
 * pre-baked route handlers as `createIngressServer` (Bun). Exercises the
 * adapter under bun test (node:http runs fine on Bun) so the Node path is
 * covered by the default suite, not only the Node CI job.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { buildPathMatcher } from '../../../src/ingress/server'
import { createIngressServerNode } from '../../../src/ingress/server-node'

describe('createIngressServerNode', () => {
  test('serves GET through the pre-baked handlers over node:http', async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const srv = createIngressServerNode({
      port: 0,
      routes: { '/health': { read: ingress } },
    })

    const port = await srv.ready
    expect(typeof port).toBe('number')

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { connection: 'close' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)

    srv.stop()
  })

  test('unknown routes fall back to 404', async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const srv = createIngressServerNode({
      port: 0,
      routes: {},
      fallback: ingress,
    })

    const port = await srv.ready
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { connection: 'close' },
    })
    expect(res.status).toBe(404)
    srv.stop()
  })

  test('POST on a write route validates JSON and returns the ok wire format', async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const srv = createIngressServerNode({
      port: 0,
      routes: { '/api/users': { read: ingress, write: ingress } },
    })

    const port = await srv.ready
    const res = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ name: 'Ada' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; requestId?: string }
    expect(body.ok).toBe(true)
    expect(typeof body.requestId).toBe('string')
    srv.stop()
  })

  test('matches dynamic :param routes over node:http', async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true })
    const srv = createIngressServerNode({
      port: 0,
      routes: { '/users/:id': { read: ingress } },
    })

    const port = await srv.ready
    const res = await fetch(`http://127.0.0.1:${port}/users/42`, {
      headers: { connection: 'close' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)
    srv.stop()
  })
})

describe('buildPathMatcher', () => {
  const routes = {
    '/users': { GET: 'users-list' },
    '/users/:id': { GET: 'user-detail' },
    '/users/:id/posts': { GET: 'user-posts' },
    '/files/*': { GET: 'file-rest' },
  } as unknown as Record<string, Record<string, unknown>>
  const match = buildPathMatcher(routes)

  test('exact paths win over dynamic patterns', () => {
    expect(match('/users')?.methods.GET).toBe('users-list')
    expect(match('/users')?.params).toEqual({})
  })

  test('matches :param segments and extracts params', () => {
    const m = match('/users/42')
    expect(m?.methods.GET).toBe('user-detail')
    expect(m?.params).toEqual({ id: '42' })
  })

  test('most-specific dynamic pattern wins', () => {
    const m = match('/users/42/posts')
    expect(m?.methods.GET).toBe('user-posts')
    expect(m?.params).toEqual({ id: '42' })
  })

  test('matches * rest segments', () => {
    const m = match('/files/a/b/c.png')
    expect(m?.methods.GET).toBe('file-rest')
    expect(m?.params['*']).toBe('a/b/c.png')
  })

  test('decodes percent-encoded params', () => {
    const m = match('/users/a%20b')
    expect(m?.params.id).toBe('a b')
  })

  test('no match returns undefined', () => {
    expect(match('/nonexistent')).toBeUndefined()
  })
})
