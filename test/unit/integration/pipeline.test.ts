/**
 * Tests for src/integration/pipeline.ts — the framework-agnostic ingress
 * pipeline adapter.
 *
 * Covers:
 * - handleRequest renders a 200 ok JSON for a GET
 * - handleRequest short-circuits a schema failure to 422
 * - preprocess short-circuits on terminal, returns ctx + snapshot for ok
 * - preprocess reads a request body into the result
 * - readBody enforces the size limit
 * - custom render is used for ok responses
 * - preprocess body-read failure maps to a terminal 413
 */

import { describe, expect, test } from 'bun:test'
import { createPipeline } from '../../../src/integration'

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

const decoder = new TextDecoder()

describe('createPipeline', () => {
  test('handleRequest returns a 200 ok JSON for a GET', async () => {
    const p = createPipeline({})
    const res = await p.handleRequest(req('/health'))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      ok: boolean
      requestId: string
    }
    expect(body.ok).toBe(true)
    expect(typeof body.requestId).toBe('string')
  })

  test('handleRequest short-circuits a schema failure to 422', async () => {
    const schema = new TextEncoder().encode(
      JSON.stringify({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      }),
    )
    const p = createPipeline({ options: { requireJsonBody: true, schema } })

    const res = await p.handleRequest(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ age: 3 }),
      }),
    )
    expect(res.status).toBe(422)
    const body = JSON.parse(await res.text()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  test('preprocess short-circuits on terminal, returns ctx for ok', async () => {
    const p = createPipeline({ options: { parseQuery: true } })

    const ok = await p.preprocess(req('/api/users?page=2'))
    expect(ok.terminal).toBe(false)
    expect(ok.response).toBeNull()
    expect(ok.result).not.toBeNull()
    expect(ok.result?.ok).toBe(true)
    expect(ok.ctx.requestId).toBeTruthy()
    expect(ok.ctx.locals).toBeInstanceOf(Map)
    ok.ctx.locals.set('user', 'ada')
    expect(ok.ctx.locals.get('user')).toBe('ada')

    // A terminal request (schema failure) short-circuits with a response.
    const schema = new TextEncoder().encode(JSON.stringify({ type: 'object', required: ['name'] }))
    const strict = createPipeline({ options: { requireJsonBody: true, schema } })
    const term = await strict.preprocess(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ age: 3 }),
      }),
    )
    expect(term.terminal).toBe(true)
    expect(term.response).not.toBeNull()
    expect(term.result).toBeNull()
  })

  test('preprocess reads a request body into the result', async () => {
    const p = createPipeline({
      options: { requireJsonBody: true, emitMetadataJson: true },
    })
    const out = await p.preprocess(
      req('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ada' }),
      }),
    )
    expect(out.terminal).toBe(false)
    expect(out.result?.bodyValidJson).toBe(true)
    expect(decoder.decode(out.result?.body ?? new Uint8Array(0))).toContain('"name":"ada"')
    // metadataJson carries the ingress metadata (requestId etc.)
    expect(decoder.decode(out.result?.metadataJson ?? new Uint8Array(0))).toContain('requestId')
  })

  test('preprocess maps a body-too-large read to a terminal 413', async () => {
    const p = createPipeline({ maxBodyBytes: 32 })
    const out = await p.preprocess(req('/api', { method: 'POST', body: 'x'.repeat(1000) }))
    expect(out.terminal).toBe(true)
    expect(out.response?.status).toBe(413)
    const text = await (out.response as Response).text()
    expect(text).toContain('body_too_large')
  })

  test('readBody helper enforces the limit', async () => {
    const p = createPipeline({ maxBodyBytes: 16 })
    await expect(
      p.readBody(req('/api', { method: 'POST', body: 'x'.repeat(100) })),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
  })

  test('custom render is used for ok responses', async () => {
    const p = createPipeline({
      render: (result, ctx) =>
        new Response(`hello ${result.requestId}@${ctx.requestId}`, { status: 201 }),
    })
    const res = await p.handleRequest(req('/health'))
    expect(res.status).toBe(201)
    expect(await res.text()).toMatch(/^hello .+@.+/)
  })
})
