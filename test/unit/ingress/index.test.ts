/**
 * Tests for src/ingress/index.ts — the async `createIngress` / sync
 * `createIngressSync` convenience APIs (previously untested).
 *
 * Covers:
 * - createIngress returns an ok context (caller renders the 200; response null)
 * - terminal error contexts carry a real Response with the right status
 * - onRequest / onResponse hooks fire exactly once per request
 * - content-length over maxBodyBytes short-circuits to 413 (hook fires)
 * - BODY_TOO_LARGE mid-read becomes 413
 * - schema validation failure maps to 422
 * - enableRequestIds:false yields an empty requestId
 * - createIngressSync captures synchronous result fields
 */

import { describe, expect, test } from 'bun:test'
import { createIngress, createIngressSync } from '../../../src/ingress'

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

describe('createIngress (async convenience API)', () => {
  test('GET returns a 200 ok context; caller renders the 200', async () => {
    const ingress = createIngress({})
    const ctx = await ingress(req('/health'))
    expect(ctx.ok).toBe(true)
    expect(ctx.status).toBe(200)
    // Terminal responses carry a Response; successful results are rendered by
    // the caller (response stays null).
    expect(ctx.response).toBeNull()
  })

  test('onRequest/onResponse fire exactly once per request with matching requestId', async () => {
    const events: string[] = []
    const ingress = createIngress({
      onRequest: (_req, requestId) => events.push(`request:${requestId}`),
      onResponse: (_req, _result, status, requestId) =>
        events.push(`response:${status}:${requestId}`),
    })

    await ingress(req('/health'))

    expect(events).toHaveLength(2)
    expect(events[0]).toMatch(/^request:/)
    const rid = events[0]?.slice('request:'.length) ?? ''
    expect(events[1]).toBe(`response:200:${rid}`)
  })

  test('content-length over maxBodyBytes short-circuits to 413 and fires onResponse', async () => {
    const statuses: number[] = []
    const ingress = createIngress({
      maxBodyBytes: 64,
      onResponse: (_r, _res, status) => statuses.push(status),
    })

    const ctx = await ingress(
      req('/api', {
        method: 'POST',
        headers: { 'content-length': '1000' },
        body: 'x'.repeat(100),
      }),
    )

    expect(ctx.status).toBe(413)
    expect(ctx.ok).toBe(false)
    expect(ctx.response).not.toBeNull()
    expect(ctx.response?.status).toBe(413)
    expect(statuses).toEqual([413])
  })

  test('accepts security options (createIngress applies them, not the fast path)', async () => {
    // `security`/`enableSecurityHeaders` are rejected by the raw fast path;
    // `createIngress` consumes them itself via buildResponseContext and must
    // not forward them to the underlying fast handler.
    const ingress = createIngress({
      maxBodyBytes: 16,
      security: { nosniff: true, frameOptions: 'SAMEORIGIN' },
    })
    const ctx = await ingress(
      req('/api', {
        method: 'POST',
        headers: { 'content-length': '1000' },
      }),
    )
    expect(ctx.status).toBe(413)
    expect(ctx.response?.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ctx.response?.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  test('BODY_TOO_LARGE mid-read becomes 413', async () => {
    const ingress = createIngress({ maxBodyBytes: 32 })
    const ctx = await ingress(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(1000),
      }),
    )
    expect(ctx.status).toBe(413)
    expect(ctx.ok).toBe(false)
  })

  test('schema validation failure maps to 422, valid body to 200', async () => {
    const schema = new TextEncoder().encode(
      JSON.stringify({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      }),
    )
    const ingress = createIngress({ requireJsonBody: true, schema })

    const bad = await ingress(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ age: 3 }),
      }),
    )
    expect(bad.status).toBe(422)
    expect(bad.ok).toBe(false)
    expect(bad.response?.status).toBe(422)

    const good = await ingress(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ada' }),
      }),
    )
    expect(good.status).toBe(200)
    expect(good.ok).toBe(true)
  })

  test('enableRequestIds:false yields an empty requestId', async () => {
    const ingress = createIngress({ enableRequestIds: false })
    const ctx = await ingress(req('/health'))
    expect(ctx.requestId).toBe('')
  })
})

describe('createIngressSync (sync convenience API)', () => {
  test('captures synchronous result fields (GET ok)', () => {
    const sync = createIngressSync({ parseQuery: true })
    let captured: { ok: boolean; status: number } = { ok: false, status: 0 }

    const out = sync.run(req('/health?x=1'), undefined, null, 'rid-123', (r) => {
      captured = { ok: r.ok, status: r.status }
      return 'done'
    })

    expect(out).toBe('done')
    expect(captured).toEqual({ ok: true, status: 200 })
  })

  test('rejects an async callback', () => {
    const sync = createIngressSync({})
    expect(() =>
      sync.run(req('/health'), undefined, null, 'rid', () => Promise.resolve('nope')),
    ).toThrow(/synchronous/)
  })
})
