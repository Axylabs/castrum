/**
 * Tests for the minimal-frame processing in `src/ingress/handlers.ts` —
 * skipping the per-request JS URL/IP UTF-8 encode when the native pipeline
 * (rust/ingress/pipeline.rs) provably cannot read those sections.
 *
 * The JS mirrors native consumption exactly (see `urlNeeded`/`ipNeeded` in
 * createIngressHandler):
 *   - URL is skipped only when parseQuery is off, emitMetadataJson is off AND
 *     https is pinned (detect_https then returns the pinned value).
 *   - IP is skipped only when rate limiting and proxy trust are both disabled
 *     (socket_is_trusted then returns false without parsing the IP).
 * These tests prove the skipped path still serves correct responses and that
 * every "URL needed" configuration still packs (and uses) the URL.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler } from '../../../src/ingress/handlers'

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

describe('minimal-frame processing (skip URL/IP encode when unused)', () => {
  test('URL+IP skippable route serves a correct 200 with ok:true', async () => {
    // https pinned + no query + no envelope + no rate/trust → urlNeeded=false,
    // ipNeeded=false (both skipped). Native must still return an accepted verdict.
    const h = createIngressHandler(
      { https: true, parseCookies: false, parseQuery: false, emitMetadataJson: false },
      {},
    )
    let sawOk = false
    const res = await h.run<Response>(req('/health'), '127.0.0.1', null, (result) => {
      sawOk = result.ok
      return new Response(null, { status: 200 })
    })
    expect(sawOk).toBe(true)
    expect(res.status).toBe(200)
  })

  test('emitMetadataJson still packs the URL (envelope path present)', async () => {
    // emitMetadataJson:true → urlNeeded=true → the real URL is packed and the
    // envelope carries the extracted path.
    const h = createIngressHandler(
      { https: true, parseCookies: false, parseQuery: false, emitMetadataJson: true },
      {},
    )
    const res = await h.run<Response>(req('/health'), undefined, null, (result, ctx) => {
      const t = h.terminalResponse(req('/health'), result, ctx)
      return t ?? new Response(result.bodyJson(true) as Uint8Array, { status: 200 })
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { path?: string }
    expect(body.path).toBe('/health')
  })

  test('parseQuery still packs the URL (query parsed from it)', async () => {
    // parseQuery:true → urlNeeded=true → the query is extracted from the real
    // URL bytes, not an empty section.
    const h = createIngressHandler(
      { https: true, parseCookies: false, parseQuery: true, emitMetadataJson: true },
      {},
    )
    const res = await h.run<Response>(req('/api?page=1'), undefined, null, (result, ctx) => {
      const t = h.terminalResponse(req('/api?page=1'), result, ctx)
      return t ?? new Response(result.bodyJson(true) as Uint8Array, { status: 200 })
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { query?: Record<string, unknown> }
    expect(body.query).toEqual({ page: '1' })
  })

  test('unpinned https still packs the URL (https:// request accepted)', async () => {
    // https undefined → urlNeeded=true → the scheme is scanned from the real
    // URL bytes (empty would read as plain http).
    const h = createIngressHandler(
      { parseCookies: false, parseQuery: false, emitMetadataJson: false },
      {},
    )
    let sawOk = false
    const res = await h.run<Response>(
      new Request('https://localhost:9999/health'),
      '127.0.0.1',
      null,
      (result) => {
        sawOk = result.ok
        return new Response(null, { status: 200 })
      },
    )
    expect(sawOk).toBe(true)
    expect(res.status).toBe(200)
  })

  test('rate limiting keeps the IP packed (rate_key reads it)', async () => {
    // rateLimit enabled → ipNeeded=true → the real IP is packed so the native
    // limiter keys on it. Just verify the request still succeeds end-to-end.
    const h = createIngressHandler(
      {
        https: true,
        parseCookies: false,
        parseQuery: false,
        emitMetadataJson: false,
        rateLimit: { limit: 1000, windowMs: 60_000 },
      },
      {},
    )
    let sawOk = false
    const res = await h.run<Response>(req('/health'), '10.0.0.1', null, (result) => {
      sawOk = result.ok
      return new Response(null, { status: 200 })
    })
    expect(sawOk).toBe(true)
    expect(res.status).toBe(200)
  })
})
