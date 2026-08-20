// test/integration/node-smoke.test.mjs
//
// Node.js smoke test for the compiled ESM entry (`dist/index.js`).
// Run with: bun run build:js && node --test test/integration/
//
// Covers: native FFI primitives, the fast ingress path, the pre-baked handler
// path, and the node:http server adapter — all under plain Node.js.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as castrum from '../../dist/index.js'

const encoder = new TextEncoder()

// ── 1. Native FFI primitives ──────────────────────────────────────
test('native FFI primitives work under Node', () => {
  assert.equal(castrum.rust.crc32(new Uint8Array([104, 105])), 3633523372)
  assert.equal(typeof castrum.rust.fnv1a64(new Uint8Array([104, 105])), 'bigint')
  assert.equal(castrum.rust.jsonValid(encoder.encode('{"a":1}')), true)
})

// ── 2. Fast ingress path (sync, native) ───────────────────────────
test('createIngressFast processes a GET through the native pipeline', () => {
  const fast = castrum.createIngressFast({
    emitMetadataJson: true,
    parseCookies: true,
    parseQuery: true,
  })
  const req = new Request('http://localhost/api/users?x=1', { method: 'GET' })

  let captured = null
  fast.run(req, '1.2.3.4', undefined, 'req-fast-1', (result) => {
    // Inspect INSIDE the callback — the result is invalidated after run().
    captured = {
      ok: result.ok,
      status: result.status,
      errorCode: result.errorCode,
      requestId: result.requestId,
    }
  })

  assert.ok(captured !== null, 'callback must run synchronously')
  assert.equal(captured.ok, true, 'valid GET should be ok')
  assert.equal(captured.status, 200)
  assert.equal(captured.errorCode, 0)
  assert.equal(captured.requestId, 'req-fast-1')
})

// ── 3. Pre-baked handler path (Response-returning) ────────────────
test('createIngressHandler + readHandler return a 200 ok Response', async () => {
  const { createIngressHandler, readHandler } = castrum
  const ingress = createIngressHandler(
    { emitMetadataJson: true, parseCookies: true, parseQuery: true },
    { outputBufferSize: 65536 },
  )
  const handler = readHandler(ingress, { copyBody: true })

  const req = new Request('http://localhost/api/users', { method: 'GET' })
  const res = await handler(req, null)

  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.equal(typeof json.requestId, 'string')
})

// ── 4. node:http server adapter ───────────────────────────────────
test('createIngressServerNode serves GET/HEAD/POST and stops gracefully', async () => {
  const { createIngressHandler, createIngressServerNode } = castrum

  const ingress = createIngressHandler(
    { emitMetadataJson: true, parseCookies: true, parseQuery: true },
    { outputBufferSize: 65536 },
  )

  const srv = createIngressServerNode({
    port: 0,
    routes: {
      '/health': { read: ingress },
      '/api/echo': { read: ingress },
    },
    fallback: ingress,
  })

  // Wait for the server to be listening (node:http binds asynchronously).
  const port = await srv.ready
  assert.ok(port > 0, 'ephemeral port should be bound')

  const base = `http://127.0.0.1:${port}`
  // Connection: close keeps undici from holding keep-alive sockets open so the
  // server can shut down promptly.
  const closeHeader = { connection: 'close' }

  try {
    // GET
    const getRes = await fetch(`${base}/health`, { headers: closeHeader })
    assert.equal(getRes.status, 200)
    const getJson = await getRes.json()
    assert.equal(getJson.ok, true)

    // HEAD (no body)
    const headRes = await fetch(`${base}/health`, {
      method: 'HEAD',
      headers: closeHeader,
    })
    assert.equal(headRes.status, 200)
    assert.equal((await headRes.arrayBuffer()).byteLength, 0)

    // Unmatched method on a known path -> fallback 404
    const postRes = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...closeHeader },
      body: JSON.stringify({ name: 'castrum' }),
    })
    assert.equal(postRes.status, 404)

    // Unmatched path -> fallback 404
    const missingRes = await fetch(`${base}/nope`, { headers: closeHeader })
    assert.equal(missingRes.status, 404)
  } finally {
    // Force-stop (drains + closes connections) so the test process can exit.
    srv.server.stop(true)
  }
})
