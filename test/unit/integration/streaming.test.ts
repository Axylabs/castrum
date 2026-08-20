/**
 * Tests for src/integration/streaming.ts — the SSE response helper.
 */

import { describe, expect, test } from 'bun:test'
import { type SseEvent, sseResponse } from '../../../src/integration'
import { rust } from '../../../src/rust-ffi'

const encoder = new TextEncoder()

describe('sseResponse', () => {
  test('frames events with the native sseEncodeEvent byte-for-byte', async () => {
    const events: SseEvent[] = [
      { event: 'update', data: encoder.encode('hello') },
      { id: '42', data: 'world', retry: 3000 },
    ]
    const res = sseResponse(events)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const bytes = new Uint8Array(await res.arrayBuffer())
    const expected = new Uint8Array([
      ...rust.sseEncodeEvent('update', encoder.encode('hello'), null, null),
      ...rust.sseEncodeEvent(null, encoder.encode('world'), '42', 3000),
    ])
    expect(bytes).toEqual(expected)
  })

  test('supports async iterables', async () => {
    async function* gen(): AsyncGenerator<SseEvent> {
      yield { data: 'one' }
      yield { data: 'two' }
    }
    const res = sseResponse(gen())
    const text = new TextDecoder().decode(await res.arrayBuffer())
    expect(text).toContain('data: one')
    expect(text).toContain('data: two')
  })

  test('merges caller headers but always sets event-stream content-type', () => {
    const res = sseResponse([{ data: 'x' }], {
      headers: { 'x-request-id': 'rid-1' },
    })
    expect(res.headers.get('x-request-id')).toBe('rid-1')
    expect(res.headers.get('content-type')).toBe('text/event-stream')
  })
})
