/**
 * HTTP request-smuggling defense tests (raw-socket).
 *
 * The ingress pipeline is built on `Bun.serve`, so the framing is parsed by
 * Bun's HTTP server — these tests pin that OUR deployed surface rejects the
 * classic smuggling vectors (CL.TE / TE.CL / duplicate Content-Length /
 * obfuscated Transfer-Encoding) rather than accepting an ambiguous request.
 *
 * Sending raw bytes over `node:net` (Bun-compatible) lets us control the
 * exact wire framing, which `fetch()` cannot.
 */

import { describe, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { createIngressServer } from '../../../src/ingress/server'

const handler = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
})

/** Open a raw TCP connection, write `raw`, and resolve the full response text. */
function rawHttp(port: number, raw: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(raw))
    let data = ''
    const done = () => {
      sock.destroy()
      resolve(data)
    }
    sock.on('data', (c: Buffer) => (data += c.toString()))
    sock.on('end', done)
    sock.on('error', reject)
    setTimeout(done, timeoutMs)
  })
}

/** First status line of a raw HTTP response (e.g. "HTTP/1.1 400 Bad Request"). */
function statusLine(raw: string): string {
  return raw.split('\r\n')[0] ?? ''
}

async function startServer(): Promise<{
  srv: ReturnType<typeof createIngressServer>
  port: number
}> {
  const srv = createIngressServer({
    port: 0,
    routes: {
      '/write': { write: handler },
      '/health': { read: handler },
    },
  })
  const port = srv.port
  await Bun.sleep(50)
  return { srv, port }
}

describe('request smuggling defense (raw socket)', () => {
  test('a well-formed GET request is accepted (control)', async () => {
    const { srv, port } = await startServer()
    try {
      // Control: proves the server accepts normal requests, so the 4xx
      // responses below are specifically about ambiguous framing.
      const raw = 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n'
      const res = await rawHttp(port, raw)
      expect(res.startsWith('HTTP/1.1 2')).toBe(true)
    } finally {
      srv.stop()
    }
  })

  test('even a clean chunked request body is rejected (Bun rejects TE framing)', async () => {
    const { srv, port } = await startServer()
    try {
      // Bun.serve does not accept `Transfer-Encoding: chunked` request bodies
      // at all, so no TE-framed body can ever reach the pipeline — the
      // strongest possible smuggling defense. Pinning this as a contract.
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '7\r\n' +
        '{"ok":1}\r\n' +
        '0\r\n' +
        '\r\n'
      const res = await rawHttp(port, raw)
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
    } finally {
      srv.stop()
    }
  })

  test('CL.TE: both Content-Length and Transfer-Encoding → rejected (no smuggling)', async () => {
    const { srv, port } = await startServer()
    try {
      // Smuggling probe: backend trusts CL (4 bytes) while a front-end proxy
      // uses TE; the trailing bytes are a second "GPOST" request. A vulnerable
      // server would process GPOST as a fresh request.
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Length: 4\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '5c\r\n' +
        'GPOST /admin HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'X-Smuggled: 1\r\n' +
        '\r\n' +
        '0\r\n' +
        '\r\n'
      const res = await rawHttp(port, raw)
      // The ambiguous request must be rejected, never honored.
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
      // The smuggled body must not be acknowledged as a success.
      expect(res.includes('"ok":true')).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test('TE.CL: chunked + Content-Length → rejected', async () => {
    const { srv, port } = await startServer()
    try {
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 5\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '5\r\n' +
        'hello\r\n' +
        '0\r\n' +
        '\r\n'
      const res = await rawHttp(port, raw)
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
      expect(res.includes('"ok":true')).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test('duplicate Content-Length with differing values → rejected', async () => {
    const { srv, port } = await startServer()
    try {
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 5\r\n' +
        'Content-Length: 6\r\n' +
        '\r\n' +
        'hello!'
      const res = await rawHttp(port, raw)
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
    } finally {
      srv.stop()
    }
  })

  test('obfuscated Transfer-Encoding (space before colon) → rejected', async () => {
    const { srv, port } = await startServer()
    try {
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Transfer-Encoding : chunked\r\n' +
        '\r\n' +
        '5\r\n' +
        'hello\r\n' +
        '0\r\n' +
        '\r\n'
      const res = await rawHttp(port, raw)
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
    } finally {
      srv.stop()
    }
  })

  test('nested chunked framing (Transfer-Encoding: chunked, chunked) → rejected', async () => {
    const { srv, port } = await startServer()
    try {
      const raw =
        'POST /write HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Transfer-Encoding: chunked, chunked\r\n' +
        '\r\n' +
        '5\r\n' +
        'hello\r\n' +
        '0\r\n' +
        '\r\n'
      const res = await rawHttp(port, raw)
      expect(statusLine(res).startsWith('HTTP/1.1 4')).toBe(true)
    } finally {
      srv.stop()
    }
  })
})
