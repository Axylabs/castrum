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
import { ABORT_CODE, abortResponse, isAbortError } from '../../../src/ingress/abort'
import { readBodyWithLimit } from '../../../src/ingress/body'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { jsonWriteHandler } from '../../../src/ingress/routes/json-write'
import { readHandler } from '../../../src/ingress/routes/read'
import { nativeResponderRoute } from '../../../src/ingress/routes/responder'

const decoder = new TextDecoder()

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
    const h = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    let ran = false
    const original = h.run
    h.run = ((...args: Parameters<typeof original>) => {
      ran = true
      return original(...args)
    }) as typeof original

    const ac = new AbortController()
    ac.abort()
    const res = await readHandler(h, { copyBody: true })(req('/api/users', { signal: ac.signal }))

    expect(res.status).toBe(499)
    expect(ran).toBe(false)
  })

  test('jsonWriteHandler aborted mid-body-read returns 499 (not 400/408/500) without running the pipeline', async () => {
    const h = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    let ran = false
    const original = h.run
    h.run = ((...args: Parameters<typeof original>) => {
      ran = true
      return original(...args)
    }) as typeof original

    const ac = new AbortController()
    const write = jsonWriteHandler(h, { maxBodyBytes: 1024 })
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
    expect(ran).toBe(false)
  })

  test('nativeResponderRoute with an already-aborted signal returns 499 without running the pipeline', async () => {
    const h = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072 })
    let ran = false
    const original = h.run
    h.run = ((...args: Parameters<typeof original>) => {
      ran = true
      return original(...args)
    }) as typeof original

    const route = nativeResponderRoute(h, () => new Response('ok', { status: 200 }))
    const ac = new AbortController()
    ac.abort()
    const res = await route(req('/api/users', { signal: ac.signal }))

    expect(res.status).toBe(499)
    expect(ran).toBe(false)
  })

  test('the abort path does not leak a pooled buffer', async () => {
    // maxInFlight=1: if the abort path acquired and failed to release a pooled
    // buffer, the next request would fail pool acquisition (500).
    const h = createIngressHandler({ ...baseOptions }, { outputBufferSize: 131072, maxInFlight: 1 })
    const read = readHandler(h, { copyBody: true })

    const ac = new AbortController()
    ac.abort()
    const aborted = await read(req('/api/users', { signal: ac.signal }))
    expect(aborted.status).toBe(499)

    const ok = await read(req('/api/users'))
    expect(ok.status).toBe(200)
    await ok.text()
  })
})
