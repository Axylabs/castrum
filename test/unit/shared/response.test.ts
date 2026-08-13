/**
 * Tests for src/shared/response.ts (pooledBodyResponse)
 *
 * Covers:
 * - serving a pooled byte slice and releasing the handle on consumption
 * - releasing immediately for an empty body
 * - keeping the handle in flight until the body is consumed
 */

import { describe, test, expect } from 'bun:test'
import { BufferPool } from '../../../src/shared/buffer-pool'
import { pooledBodyResponse } from '../../../src/shared/response'

describe('pooledBodyResponse', () => {
  test('serves the slice and releases the handle once the body is consumed', async () => {
    const pool = new BufferPool({ initialSize: 16 })
    const handle = pool.acquire()
    handle.buffer.set(new TextEncoder().encode('hi'))

    const res = pooledBodyResponse(handle, handle.buffer.subarray(0, 2), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })

    expect(res.status).toBe(200)
    expect(handle.released).toBe(false) // still in flight before consumption

    expect(await res.text()).toBe('hi')
    expect(handle.released).toBe(true) // released after consumption
  })

  test('releases immediately for an empty body', () => {
    const pool = new BufferPool({ initialSize: 16 })
    const handle = pool.acquire()
    const res = pooledBodyResponse(handle, new Uint8Array(0), { status: 204 })
    expect(res.status).toBe(204)
    expect(handle.released).toBe(true)
  })

  test('keeps the handle in flight until the body is consumed', async () => {
    const pool = new BufferPool({ initialSize: 16 })
    const handle = pool.acquire()
    const bytes = new Uint8Array([1, 2, 3])

    const res = pooledBodyResponse(handle, bytes)
    expect(handle.released).toBe(false)

    // Abort before reading: the stream's cancel path must still release.
    res.body?.cancel?.()
    // cancel() is async internally; give the microtask a chance to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(handle.released).toBe(true)
  })

  test('abandonment guard releases an unconsumed body after timeoutMs', async () => {
    const pool = new BufferPool({ initialSize: 16 })
    const handle = pool.acquire()
    pooledBodyResponse(handle, new Uint8Array([1, 2, 3]), { status: 200 }, 20)
    expect(handle.released).toBe(false)

    // Never pull or cancel the body — the 20ms guard must release the buffer
    // and close the stream so an abandoned response can't hold it forever.
    await new Promise((r) => setTimeout(r, 60))
    expect(handle.released).toBe(true)
  })

  test('preserves response init (status + headers)', async () => {
    const pool = new BufferPool({ initialSize: 16 })
    const handle = pool.acquire()
    const res = pooledBodyResponse(handle, new Uint8Array([97]), {
      status: 201,
      headers: { 'x-test': '1' },
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-test')).toBe('1')
    expect(await res.text()).toBe('a')
    handle.release()
  })
})
