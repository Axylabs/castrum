/**
 * Tests for src/ingress/body.ts — streaming request-body reads with size
 * enforcement and an overall deadline.
 */

import { describe, test, expect } from 'bun:test'
import { readBodyWithLimit } from '../../../src/ingress/body'

const decoder = new TextDecoder()

describe('readBodyWithLimit', () => {
  test('reads a small body', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: 'hello',
    })
    const out = await readBodyWithLimit(req, 1024, true)
    expect(decoder.decode(out)).toBe('hello')
  })

  test('fast path: a declared Content-Length body reads in one shot', async () => {
    const payload = JSON.stringify({ a: 1 })
    // A constructed `Request` does not auto-derive Content-Length (real
    // socket-backed requests always carry it), so set it explicitly to force
    // the known-length fast path (single arrayBuffer read, no
    // reader/timer/race churn).
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
    })
    expect(req.headers.get('content-length')).toBe(String(payload.length))
    const out = await readBodyWithLimit(req, 1024, true)
    expect(decoder.decode(out)).toBe(payload)
  })

  test('fast path: declared length over maxBytes short-circuits before reading', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: '12345',
      headers: { 'content-length': '5' },
    })
    let caught: unknown
    try {
      await readBodyWithLimit(req, 4, true)
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string })?.code).toBe('BODY_TOO_LARGE')
  })

  test('throws BODY_TOO_LARGE as soon as the stream crosses maxBytes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
        controller.enqueue(new Uint8Array([6, 7, 8, 9, 10]))
        controller.close()
      },
    })
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })

    let caught: unknown
    try {
      await readBodyWithLimit(req, 4, true)
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string })?.code).toBe('BODY_TOO_LARGE')
  })

  test('completes within the timeout without error', async () => {
    // Bun's `Request` constructor eagerly drains a constructed ReadableStream
    // body, so a genuinely-hanging stream can't be built through `Request`
    // (the timeout path fires on real socket-backed request bodies, e.g.
    // slowloris). Here we assert the deadline does not interfere with a body
    // that completes before it.
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: 'fast body',
    })
    const out = await readBodyWithLimit(req, 1024, true, 200)
    expect(decoder.decode(out)).toBe('fast body')
  })

  test('guard disabled allows an oversized body', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: 'hello world',
    })
    const out = await readBodyWithLimit(req, 4, false)
    expect(out.byteLength).toBe(11)
  })

  test('no body resolves to empty', async () => {
    const req = new Request('http://localhost/', { method: 'GET' })
    const out = await readBodyWithLimit(req, 1024, true)
    expect(out.byteLength).toBe(0)
  })
})
