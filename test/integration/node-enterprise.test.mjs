// test/integration/node-enterprise.test.mjs
//
// Enterprise Node.js coverage for the compiled ESM entry (`dist/index.js`):
//   - Buffer-as-input interop (the natural Node input type)
//   - the precompiled higher-order instances (JwtSigner/AeadCipher/Argon2Hasher/
//     MediaTypeMatcher + TemplateRenderer batch)
//   - node:crypto cross-checks, including chacha20-poly1305 (verifiable ONLY on
//     Node — Bun's node:crypto lacks it)
//   - node:http adapter hardening: keep-alive reuse, socket-level 413, malformed
//     request → castrum JSON 400, slowloris body timeout → 408
//
// Run with: bun run build:js && node --test test/integration/node-enterprise.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createCipheriv, randomBytes } from 'node:crypto'

import * as castrum from '../../dist/index.js'

const encoder = new TextEncoder()

// ── 1. Buffer-as-input interop (Buffer extends Uint8Array) ────────
test('Node Buffer works as FFI input everywhere', () => {
  const buf = Buffer.from([104, 105])
  assert.equal(castrum.rust.crc32(buf), 3633523372)
  assert.equal(castrum.rust.jsonValid(Buffer.from('{"a":1}')), true)

  const key = Buffer.from('0123456789abcdef0123456789abcdef')
  const data = Buffer.from('hello buffer')
  const sig = castrum.rust.hmacSha256(key, data)
  assert.equal(
    castrum.rust.hmacSha256Verify(key, data, sig),
    true,
    'hmac sign+verify with Buffer inputs',
  )
})

// ── 2. Precompiled higher-order instances ─────────────────────────
test('JwtSigner signs and verifies with a precompiled key', () => {
  const signer = castrum.rust.createJwtSigner(Buffer.from('super-secret-jwt-key'), 3600)
  const now = 1_000_000
  const token = signer.sign({ sub: '123', role: 'admin' }, now)
  const verified = signer.verify(token, now)
  assert.equal(verified.sub, '123')
  assert.equal(verified.iat, now)
  assert.equal(verified.exp, now + 3600)

  const other = castrum.rust.createJwtSigner(Buffer.from('other-secret'), 3600)
  assert.equal(other.verify(token, now), null)
})

test('AeadCipher roundtrips and matches node:crypto (AES-256-GCM)', () => {
  const key = Buffer.from('0123456789abcdef0123456789abcdef')
  const nonce = Buffer.from('abcdefghijkl')
  const pt = Buffer.from('session payload')

  const cipher = castrum.rust.createAeadCipher(key)
  const ct = Buffer.from(cipher.encrypt(nonce, pt))
  assert.deepEqual(Buffer.from(cipher.decrypt(nonce, ct)), pt)
  assert.equal(ct.byteLength, pt.byteLength + 16)

  // Cross-check against node:crypto (Node's OpenSSL AES-256-GCM).
  const nodeCipher = createCipheriv('aes-256-gcm', key, nonce)
  const nodeCt = Buffer.concat([nodeCipher.update(pt), nodeCipher.final()])
  const nodeTag = nodeCipher.getAuthTag()
  assert.deepEqual(Buffer.concat([nodeCt, nodeTag]), ct, 'AES-256-GCM parity')
})

// Bun's node:crypto lacks chacha20-poly1305 — only Node/OpenSSL can verify it.
let CHACHA_SUPPORTED = true
try {
  createCipheriv('chacha20-poly1305', randomBytes(32), randomBytes(12))
} catch {
  CHACHA_SUPPORTED = false
}

test('AeadCipher chacha20-poly1305 cross-check (Node-only OpenSSL)', (t) => {
  if (!CHACHA_SUPPORTED) {
    t.skip("chacha20-poly1305 is unavailable in this runtime's node:crypto")
    return
  }
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const pt = Buffer.from('cross-check payload')

  const nodeCipher = createCipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: 16,
  })
  const nodeCt = Buffer.concat([nodeCipher.update(pt), nodeCipher.final()])
  const nodeTag = nodeCipher.getAuthTag()
  const expected = Buffer.concat([nodeCt, nodeTag])

  const aead = castrum.rust.createAeadCipher(key, 'chacha20-poly1305')
  const got = Buffer.from(aead.encrypt(nonce, pt))
  assert.deepEqual(got, expected, 'chacha20-poly1305 parity with node:crypto')
  assert.deepEqual(Buffer.from(aead.decrypt(nonce, got)), pt, 'chacha decrypt roundtrip')
})

test('Argon2Hasher + MediaTypeMatcher work under Node', () => {
  const hasher = castrum.rust.createArgon2Hasher({
    mCost: 4096,
    tCost: 2,
    pCost: 1,
  })
  const password = Buffer.from('correct horse battery staple')
  const salt = Buffer.from('0123456789abcdef')
  const phc = hasher.hash(password, salt)
  assert.equal(hasher.verify(password, phc), true)
  assert.equal(hasher.verify(Buffer.from('wrong'), phc), false)

  const matcher = castrum.rust.createMediaTypeMatcher(Buffer.from('Application/JSON'))
  assert.equal(matcher.matches(Buffer.from('application/json; charset=utf-8')), true)
  assert.equal(matcher.matches(Buffer.from('text/html')), false)
})

test('TemplateRenderer.renderBatchPacked reuses the compiled template', () => {
  const renderer = castrum.rust.createTemplateRenderer('Hello {{ name }}!')
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, 2, true)
  const a = encoder.encode(JSON.stringify({ name: 'Alice' }))
  const b = encoder.encode(JSON.stringify({ name: 'Bob' }))
  const la = new Uint8Array(4)
  const lb = new Uint8Array(4)
  new DataView(la.buffer).setUint32(0, a.byteLength, true)
  new DataView(lb.buffer).setUint32(0, b.byteLength, true)
  const packed = new Uint8Array(4 + la.byteLength + a.byteLength + lb.byteLength + b.byteLength)
  let off = 0
  for (const p of [count, la, a, lb, b]) {
    packed.set(p, off)
    off += p.byteLength
  }
  const out = renderer.renderBatchPacked(packed)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  assert.equal(dv.getUint32(0, true), 2)
  const lenA = dv.getUint32(4, true)
  const sA = Buffer.from(out.subarray(8, 8 + lenA)).toString()
  assert.equal(sA, 'Hello Alice!')
})

// ── 3. createIngressFast POST / JSON body through native ─────────
test('createIngressFast POST with requireJsonBody + schema', async () => {
  const schema = encoder.encode(
    JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }),
  )
  const fast = castrum.createIngressFast({
    requireJsonBody: true,
    schema,
    emitMetadataJson: true,
  })
  const req = new Request('http://localhost/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"alice"}',
  })
  const bodyBytes = new Uint8Array(await req.arrayBuffer())

  let captured
  fast.run(req, '1.2.3.4', bodyBytes, 'rid-1', (result) => {
    captured = {
      ok: result.ok,
      status: result.status,
      bodyValidJson: result.bodyValidJson,
      schemaValid: result.schemaValid,
      bodyTruncated: result.bodyTruncated,
    }
  })
  assert.deepEqual(captured, {
    ok: true,
    status: 200,
    bodyValidJson: true,
    schemaValid: true,
    bodyTruncated: false,
  })

  // Schema failure → 422.
  const bad = new Request('http://localhost/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":123}',
  })
  const badBytes = new Uint8Array(await bad.arrayBuffer())
  let badCaptured
  fast.run(bad, '1.2.3.4', badBytes, 'rid-2', (result) => {
    badCaptured = {
      status: result.status,
      bodyValidJson: result.bodyValidJson,
      schemaValid: result.schemaValid,
    }
  })
  assert.deepEqual(badCaptured, {
    status: 422,
    bodyValidJson: true,
    schemaValid: false,
  })
})

// ── 4. node:http adapter hardening ────────────────────────────────
function startServer(options) {
  const ingress = castrum.createIngressHandler(
    { emitMetadataJson: true, parseCookies: true, parseQuery: true },
    { outputBufferSize: 65536 },
  )
  const srv = castrum.createIngressServerNode({
    port: 0,
    routes: options.routes ?? {
      '/health': { read: ingress },
      '/write': { write: ingress, maxBodyBytes: 128, bodyTimeoutMs: 200 },
    },
    maxRequestBodySize: 1024,
    ...options.extra,
  })
  return { srv, port: srv.ready }
}

test('adapter serves keep-alive requests on one socket', async () => {
  const { srv, port } = startServer({})
  const p = await port
  const http = await import('node:http')
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  try {
    const get = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: p, path, agent, method: 'GET' },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode))
          },
        )
        req.on('error', reject)
        req.end()
      })

    assert.equal(await get('/health'), 200)
    assert.equal(await get('/health'), 200)
    // Let the agent pool the idle socket before introspecting it.
    await new Promise((r) => setTimeout(r, 50))
    // Same agent + single socket → the socket is reused (idle → freeSockets).
    const key = agent.getName({ host: '127.0.0.1', port: p })
    const inUse = (agent.sockets[key] ?? []).length
    const free = (agent.freeSockets[key] ?? []).length
    assert.equal(
      inUse + free,
      1,
      `keep-alive must reuse one socket (key=${key}, inUse=${inUse}, free=${free})`,
    )
  } finally {
    agent.destroy()
    srv.stop(true)
  }
})

test('adapter rejects oversized requests at the socket (413)', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const http = await import('node:http')
    const body = 'x'.repeat(4096) // > maxRequestBodySize (1024)

    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: p,
          path: '/health',
          method: 'POST',
          headers: { 'content-length': String(body.length) },
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve({ status: res.statusCode, data }))
        },
      )
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(status.status, 413)
    assert.match(status.data, /body_too_large/)
  } finally {
    srv.stop(true)
  }
})

test('adapter returns castrum JSON for a malformed request (clientError)', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        sock.write('garbage-not-http\r\n\r\n')
      })
      let data = ''
      sock.on('data', (c) => (data += c.toString()))
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 2000)
    })
    assert.match(response, /400 Bad Request/)
    assert.match(response, /bad_request/)
  } finally {
    srv.stop(true)
  }
})

test('slowloris body read hits the route bodyTimeoutMs → 408', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        // Advertise a body UNDER the route maxBodyBytes (128) but never finish
        // sending it — readBodyWithLimit's deadline must fire → 408.
        sock.write(
          'POST /write HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            'Content-Length: 50\r\n' +
            '\r\n' +
            '{"par',
        )
      })
      let data = ''
      sock.on('data', (c) => (data += c.toString()))
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 2500)
    })

    // bodyTimeoutMs=200 fired while the body was still trickling → 408.
    assert.match(response, /408/)
    assert.match(response, /request_timeout/)
  } finally {
    srv.stop(true)
  }
})

// ── 4b. async createIngress slowloris → 408 (fast-path wire format) ──
test('createIngress async body-read timeout maps to 408, not 500', async () => {
  // Node is lazy about constructed-stream bodies (unlike Bun), so a stream
  // that never finishes is the deterministic way to hit the deadline race.
  const neverEnding = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"par'))
      // never close — the reader's read() never resolves
    },
  })
  const req = new Request('http://localhost/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '50',
    },
    body: neverEnding,
    // @ts-expect-error Node requires `duplex` for a stream body (undici).
    duplex: 'half',
  })

  const ingress = castrum.createIngress({
    requireJsonBody: true,
    maxBodyBytes: 128,
    bodyTimeoutMs: 100,
  })

  const ctx = await ingress(req, '127.0.0.1')

  // Previously the timeout was swallowed into a 500; it must now be a 408.
  assert.equal(ctx.status, 408)
  assert.equal(ctx.ok, false)
  assert.ok(ctx.response, 'terminal timeout context must carry a Response')
  assert.equal(ctx.response.status, 408)

  const body = JSON.parse(await ctx.response.text())
  assert.equal(body.error.code, 'request_timeout')
  assert.equal(body.error.status, 408)
  assert.match(body.error.message, /timed out/i)
})

test('adapter serves HTTP/1.0 requests and closes the connection', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        // HTTP/1.0 has no keep-alive by default — the server must respond and
        // close the socket (which is exactly what "end" below observes).
        sock.write('GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n')
      })
      let data = ''
      sock.on('data', (c) => (data += c.toString()))
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 2000)
    })
    assert.match(response, /200/)
    assert.match(response, /"ok":true/)
  } finally {
    srv.stop(true)
  }
})

test('adapter 413 response honors Connection: close', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const response = await new Promise((resolve, reject) => {
      const body = 'x'.repeat(4096) // > maxRequestBodySize (1024)
      const sock = net.connect(p, '127.0.0.1', () => {
        sock.write(
          'POST /health HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${body.length}\r\n` +
            'Connection: close\r\n\r\n' +
            body,
        )
      })
      let data = ''
      sock.on('data', (c) => (data += c.toString()))
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 2000)
    })
    assert.match(response, /413/)
    assert.match(response, /body_too_large/)
  } finally {
    srv.stop(true)
  }
})

test('adapter handles concurrent requests across many sockets', async () => {
  const { srv, port } = startServer({})
  const p = await port
  try {
    const http = await import('node:http')
    const N = 8
    const statuses = await Promise.all(
      Array.from(
        { length: N },
        () =>
          new Promise((resolve, reject) => {
            const req = http.request(
              { host: '127.0.0.1', port: p, path: '/health', method: 'GET' },
              (res) => {
                res.resume()
                res.on('end', () => resolve(res.statusCode))
              },
            )
            req.on('error', reject)
            req.end()
          }),
      ),
    )
    assert.deepEqual(statuses, Array(N).fill(200))
  } finally {
    srv.stop(true)
  }
})

test('adapter closes idle keep-alive sockets per idleTimeout', async () => {
  const { srv, port } = startServer({ extra: { idleTimeout: 2 } })
  const p = await port
  try {
    const result = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
      })
      let data = ''
      let timedOut = false
      sock.on('data', (c) => (data += c.toString()))
      // The server must close the idle keep-alive socket on its own.
      sock.on('close', () => resolve({ data, timedOut }))
      sock.on('error', reject)
      setTimeout(() => {
        timedOut = true
        sock.destroy()
      }, 6000)
    })
    assert.match(result.data, /200/)
    assert.equal(
      result.timedOut,
      false,
      'server must close the idle socket before our watchdog fires',
    )
  } finally {
    srv.stop(true)
  }
})

test('adapter maps header overflow to 431 (clientError)', async (t) => {
  if (typeof Bun !== 'undefined') {
    t.skip('real-Node clientError behavior; exercised in the Node CI job')
    return
  }
  const { srv, port } = startServer({})
  const p = await port
  try {
    const big = 'x'.repeat(64 * 1024) // > Node's default maxHeaderSize (16KB)
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        sock.write(`GET /health HTTP/1.1\r\nHost: localhost\r\nX-Big: ${big}\r\n\r\n`)
      })
      let data = ''
      sock.on('data', (c) => (data += c.toString()))
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 3000)
    })
    assert.match(response, /431 Request Header Fields Too Large/)
    assert.match(response, /headers_too_large/)
  } finally {
    srv.stop(true)
  }
})

test('adapter completes a WebSocket upgrade handshake via options.upgrade', async (t) => {
  if (typeof Bun !== 'undefined') {
    t.skip("real-Node 'upgrade' event behavior; exercised in the Node CI job")
    return
  }
  const upgraded = []
  const { srv, port } = startServer({
    extra: {
      upgrade: (req) => {
        const key = req.headers.get('sec-websocket-key')
        if (!key) return null
        // Node's Response can't carry a 101, so supply the handshake values
        // directly (accept key + negotiated subprotocol).
        return {
          accept: castrum.rust.text.wsAcceptKey(key),
          protocol: 'chat',
        }
      },
      onUpgrade: () => {
        upgraded.push(true)
        // Leave the upgraded socket open (a real frame codec would attach
        // here); the client closes it after reading the handshake.
      },
    },
  })
  const p = await port
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        sock.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Protocol: chat, superchat\r\n\r\n',
        )
      })
      let data = ''
      sock.on('data', (c) => {
        data += c.toString()
        // End of the 101 response head — enough to assert the handshake.
        if (data.includes('\r\n\r\n')) {
          sock.destroy()
          resolve(data)
        }
      })
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 3000)
    })
    assert.match(response, /101 Switching Protocols/)
    assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
    assert.match(response, /Sec-WebSocket-Protocol: chat/)
    assert.equal(upgraded.length, 1, 'onUpgrade hook fired')
  } finally {
    srv.stop(true)
  }
})

test('adapter drains an unread body so the keep-alive socket stays clean', async (t) => {
  if (typeof Bun !== 'undefined') {
    t.skip('real-Node keep-alive drain behavior; exercised in the Node CI job')
    return
  }
  const { srv, port } = startServer({})
  const p = await port
  try {
    const result = await new Promise((resolve) => {
      const sock = net.connect(p, '127.0.0.1', () => {
        // POST with a JSON body but NO content-type → the write route 415s
        // before reading the body. The unread bytes must be drained so the
        // following GET on the same socket parses cleanly.
        sock.write(
          'POST /write HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Length: 11\r\n\r\n' +
            '{"hi":"there"}',
        )
      })
      let data = ''
      let sentSecond = false
      sock.on('data', (c) => {
        data += c.toString()
        // After the first response arrives, try a second request on the SAME
        // socket — it must NOT be corrupted by the unread POST body (the
        // adapter now forces Connection: close, so the socket ends cleanly).
        if (!sentSecond && /415/.test(data)) {
          sentSecond = true
          try {
            sock.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
          } catch {
            // socket already closing — expected with Connection: close
          }
        }
      })
      sock.on('close', () => resolve(data))
      sock.on('error', () => resolve(data)) // reset after Connection: close is fine
      setTimeout(() => {
        sock.destroy()
        resolve(data)
      }, 4000)
    })
    // The 415 is served and — because the body was not consumed — the socket
    // closes cleanly instead of corrupting the next request (no spurious 400).
    assert.match(result, /415/)
    assert.match(result, /connection: close/i)
    assert.doesNotMatch(result, /400 Bad Request/)
  } finally {
    srv.stop(true)
  }
})
