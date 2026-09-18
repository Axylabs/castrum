/**
 * Tests for request cancellation (client disconnect) plumbing:
 *
 * - `src/ingress/abort.ts` — the pure cancellation helpers.
 * - `src/ingress/body.ts` — `readBodyWithLimit` races the read against
 *   `req.signal` and rejects with `code === 'REQUEST_ABORTED'`.
 * - Route wrappers — an aborted signal short-circuits to a 499 without running
 *   the native pipeline or acquiring a pooled output buffer.
 */

import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { createPipeline } from '../../../src/integration/pipeline'
import { ABORT_CODE, abortResponse, isAbortError } from '../../../src/ingress/abort'
import { readBodyWithLimit } from '../../../src/ingress/body'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { jsonWriteHandler } from '../../../src/ingress/routes/json-write'
import { optionsHandler } from '../../../src/ingress/routes/options'
import { readHandler } from '../../../src/ingress/routes/read'
import { nativeResponderRoute } from '../../../src/ingress/routes/responder'
import { nodeRequestToWebRequest } from '../../../src/ingress/server-node'

const decoder = new TextDecoder()

type Handler = ReturnType<typeof createIngressHandler>

/** Wrap `handler.run` so a test can assert the pipeline was never entered. */
function spyRun(handler: Handler): { state: { ran: boolean }; restore: () => void } {
  const original = handler.run
  const state = { ran: false }
  handler.run = ((...args: Parameters<typeof original>) => {
    state.ran = true
    return original(...args)
  }) as typeof original
  return {
    state,
    restore: () => {
      handler.run = original
    },
  }
}

const baseOptions = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

/** A body stream that never produces a chunk, so the read stays pending. */
function pendingBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {})
    },
  })
}

describe('abort helpers', () => {
  test('isAbortError recognizes the REQUEST_ABORTED code only', () => {
    const err = Object.assign(new Error('x'), { code: ABORT_CODE })
    expect(isAbortError(err)).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { code: 'REQUEST_TIMEOUT' }))).toBe(false)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError('REQUEST_ABORTED')).toBe(false)
  })

  test('abortResponse is an empty-body 499', async () => {
    const res = abortResponse()
    expect(res.status).toBe(499)
    expect(await res.text()).toBe('')
  })
})

describe('readBodyWithLimit cancellation', () => {
  test('rejects with REQUEST_ABORTED when already aborted at entry', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = req('/', {
      method: 'POST',
      body: 'hello',
      headers: { 'content-length': '5' },
      signal: ac.signal,
    })
    expect(r.signal.aborted).toBe(true)

    let caught: unknown
    try {
      await readBodyWithLimit(r, 1024, true)
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string })?.code).toBe(ABORT_CODE)
  })

  test('rejects with REQUEST_ABORTED when already aborted at entry (bodyTimeoutMs: 0)', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = req('/', {
      method: 'POST',
      body: 'hello',
      headers: { 'content-length': '5' },
      signal: ac.signal,
    })

    let caught: unknown
    try {
      await readBodyWithLimit(r, 1024, true, 0)
    } catch (err) {
      caught = err
    }
    expect(isAbortError(caught)).toBe(true)
    expect((caught as { code?: string })?.code).toBe(ABORT_CODE)
  })

  test('rejects promptly when aborted during a pending declared-length read (bodyTimeoutMs: 0)', async () => {
    const ac = new AbortController()
    const r = req('/', {
      method: 'POST',
      body: pendingBodyStream(),
      duplex: 'half',
      headers: { 'content-length': '5' },
      signal: ac.signal,
    } as RequestInit)

    // bodyTimeoutMs: 0 disables the deadline; the read is still racy because
    // the declared-length body is not yet buffered (a genuinely pending read).
    const read = readBodyWithLimit(r, 1024, true, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()

    let caught: unknown
    try {
      await read
    } catch (err) {
      caught = err
    }
    expect(isAbortError(caught)).toBe(true)
    expect((caught as { code?: string })?.code).toBe(ABORT_CODE)
  })

  test('rejects promptly when aborted during a streamed body read', async () => {
    const ac = new AbortController()
    const r = req('/', {
      method: 'POST',
      body: pendingBodyStream(),
      duplex: 'half',
      signal: ac.signal,
    } as RequestInit)

    const read = readBodyWithLimit(r, 1024, true, 30_000)
    // Let the streaming reader attach, then abort mid-read.
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()

    let caught: unknown
    try {
      await read
    } catch (err) {
      caught = err
    }
    expect(isAbortError(caught)).toBe(true)
    expect((caught as { code?: string })?.code).toBe(ABORT_CODE)
  })

  test('aborting does not disturb an already-completed read', async () => {
    const ac = new AbortController()
    const r = req('/', {
      method: 'POST',
      body: 'hello',
      headers: { 'content-length': '5' },
      signal: ac.signal,
    })
    const out = await readBodyWithLimit(r, 1024, true)
    expect(decoder.decode(out)).toBe('hello')
    // Detached listener: aborting after settle must not produce an unhandled
    // rejection / mutate the resolved value.
    ac.abort()
    expect(decoder.decode(out)).toBe('hello')
  })
})

describe('route cancellation', () => {
  test('readHandler with an already-aborted signal returns 499 without running the pipeline', async () => {
    const handler = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    const spy = spyRun(handler)
    try {
      const ac = new AbortController()
      ac.abort()
      const res = await readHandler(handler, { copyBody: true })(
        req('/api/users', { signal: ac.signal }),
      )

      expect(res.status).toBe(499)
      expect(spy.state.ran).toBe(false)
    } finally {
      spy.restore()
    }
  })

  test('optionsHandler with an already-aborted signal returns 499 without running the pipeline', async () => {
    const handler = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    const spy = spyRun(handler)
    try {
      const ac = new AbortController()
      ac.abort()
      const res = optionsHandler(handler)(
        req('/api/users', { method: 'OPTIONS', signal: ac.signal }),
      )

      expect(res.status).toBe(499)
      expect(spy.state.ran).toBe(false)
    } finally {
      spy.restore()
    }
  })

  test('jsonWriteHandler aborted mid-body-read returns 499 (not 400/408/500) without running the pipeline', async () => {
    const handler = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    const spy = spyRun(handler)
    try {
      const ac = new AbortController()
      const write = jsonWriteHandler(handler, { maxBodyBytes: 1024 })
      const pending = write(
        req('/api/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: pendingBodyStream(),
          duplex: 'half',
          signal: ac.signal,
        } as RequestInit),
      )

      await new Promise((resolve) => setTimeout(resolve, 0))
      ac.abort()
      const res = await pending

      expect(res.status).toBe(499)
      expect(spy.state.ran).toBe(false)
    } finally {
      spy.restore()
    }
  })

  test('jsonWriteHandler with bodyTimeoutMs: 0 and an already-aborted signal returns 499', async () => {
    const handler = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    const spy = spyRun(handler)
    try {
      const ac = new AbortController()
      ac.abort()
      const write = jsonWriteHandler(handler, { maxBodyBytes: 1024, bodyTimeoutMs: 0 })
      const res = await write(
        req('/api/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '5' },
          body: 'hello',
          signal: ac.signal,
        }),
      )

      expect(res.status).toBe(499)
      expect(spy.state.ran).toBe(false)
    } finally {
      spy.restore()
    }
  })

  test('nativeResponderRoute with an already-aborted signal returns 499 without running the pipeline', async () => {
    const handler = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    const spy = spyRun(handler)
    try {
      const route = nativeResponderRoute(handler, () => new Response('ok', { status: 200 }))
      const ac = new AbortController()
      ac.abort()
      const res = await route(req('/api/users', { signal: ac.signal }))

      expect(res.status).toBe(499)
      expect(spy.state.ran).toBe(false)
    } finally {
      spy.restore()
    }
  })

  test('createPipeline maps an aborted body read to 499 (not 400/408)', async () => {
    const pipeline = createPipeline({ options: { ...baseOptions }, maxBodyBytes: 1024 })
    const ac = new AbortController()
    const pending = pipeline.preprocess(
      req('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: pendingBodyStream(),
        duplex: 'half',
        signal: ac.signal,
      } as RequestInit),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()
    const outcome = await pending

    expect(outcome.terminal).toBe(true)
    expect(outcome.response?.status).toBe(499)
  })

  test('the abort path does not leak a pooled buffer', async () => {
    // maxInFlight=1: if the abort path acquired and failed to release a pooled
    // buffer, the next request would fail pool acquisition (500).
    const handler = createIngressHandler(
      { ...baseOptions },
      { outputBufferSize: 131072, maxInFlight: 1 },
    )
    const read = readHandler(handler, { copyBody: true })

    const ac = new AbortController()
    ac.abort()
    const aborted = await read(req('/api/users', { signal: ac.signal }))
    expect(aborted.status).toBe(499)

    const ok = await read(req('/api/users'))
    expect(ok.status).toBe(200)
    await ok.text()
  })
})

describe('Node adapter signal bridge', () => {
  function mockNodeRequest(init: { complete?: boolean } = {}): IncomingMessage {
    const req = new Readable({ read() {} }) as unknown as {
      headers: Record<string, string>
      url: string
      method: string
      complete: boolean
    }
    req.headers = { host: 'localhost' }
    req.url = '/'
    req.method = 'GET'
    req.complete = init.complete ?? false
    return req as unknown as IncomingMessage
  }

  test('aborts the Request signal on the aborted event', () => {
    const nodeReq = mockNodeRequest({ complete: false })
    const webReq = nodeRequestToWebRequest(nodeReq)
    expect(webReq.signal.aborted).toBe(false)
    nodeReq.emit('aborted')
    expect(webReq.signal.aborted).toBe(true)
  })

  test('aborts on close while the request is incomplete (client disconnect mid-body)', () => {
    const nodeReq = mockNodeRequest({ complete: false })
    const webReq = nodeRequestToWebRequest(nodeReq)
    nodeReq.emit('close')
    expect(webReq.signal.aborted).toBe(true)
  })

  test('does not abort on close after a complete request', () => {
    const nodeReq = mockNodeRequest({ complete: true })
    const webReq = nodeRequestToWebRequest(nodeReq)
    nodeReq.emit('close')
    expect(webReq.signal.aborted).toBe(false)
  })
})
