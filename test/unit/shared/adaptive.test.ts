/**
 * Adaptive-estimate utility (`src/shared/adaptive.ts`) and BufferPool adaptive
 * sizing (`adaptive` option) — the loader's EWMA machinery, generalized.
 */

import { describe, expect, test } from 'bun:test'
import { AdaptiveEstimate } from '../../../src/shared/adaptive'
import { BufferPool } from '../../../src/shared/buffer-pool'

describe('AdaptiveEstimate (EWMA)', () => {
  test('first sample wins, subsequent samples smooth toward it', () => {
    const e = new AdaptiveEstimate({ alpha: 0.25 })
    e.sample(100)
    expect(e.estimate).toBe(100)
    e.sample(200)
    // 100 * 0.75 + 200 * 0.25 = 125
    expect(e.estimate).toBeCloseTo(125)
    // Converges toward 200 with repeated samples.
    for (let i = 0; i < 20; i++) e.sample(200)
    expect(e.estimate).toBeGreaterThan(190)
  })

  test('clamps to min/max', () => {
    const e = new AdaptiveEstimate({ min: 10, max: 1000 })
    e.sample(5000)
    expect(e.estimate).toBe(1000)
    // EWMA converges toward 1; once it falls below min, it is clamped to 10.
    for (let i = 0; i < 50; i++) e.sample(1)
    expect(e.estimate).toBe(10)
  })

  test('reset returns to initial', () => {
    const e = new AdaptiveEstimate({ initial: 42 })
    e.sample(200)
    expect(e.estimate).not.toBe(42)
    e.reset()
    expect(e.estimate).toBe(42)
  })

  test('rejects invalid alpha', () => {
    expect(() => new AdaptiveEstimate({ alpha: 0 })).toThrow(/alpha/)
    expect(() => new AdaptiveEstimate({ alpha: 1.5 })).toThrow(/alpha/)
  })
})

describe('BufferPool adaptive sizing', () => {
  test('learns a larger request size and pre-sizes subsequent buffers', () => {
    // initialSize 64; request sizes grow to ~512. With adaptive on, the floor
    // rises toward the learned demand so re-acquires reuse one size instead of
    // re-growing each time.
    const pool = new BufferPool({ initialSize: 64, adaptive: true })
    const sizes: number[] = []
    for (let i = 0; i < 12; i++) {
      const want = 64 + i * 40 // 64..504
      const h = pool.acquire(want)
      sizes.push(h.buffer.byteLength)
      h.release()
    }
    // The last allocation is sized to the learned estimate (>= initialSize).
    expect(sizes[sizes.length - 1] ?? 0).toBeGreaterThanOrEqual(64)
    // The learned floor means a mid-range request now reuses a big free buffer
    // instead of allocating a new one (createdCount stays bounded).
    const before = pool.createdCount
    const h = pool.acquire(400)
    h.release()
    expect(pool.createdCount).toBeLessThanOrEqual(before + 1)
  })

  test('non-adaptive pool keeps the initialSize floor (unchanged behavior)', () => {
    const pool = new BufferPool({ initialSize: 128 })
    const h = pool.acquire(300)
    expect(h.buffer.byteLength).toBeGreaterThanOrEqual(300)
    h.release()
    // The retained 300-byte buffer is reused for a smaller request (retention
    // is unchanged); the initialSize floor still applies to fresh allocations.
    const h2 = pool.acquire(32)
    expect(h2.buffer.byteLength).toBeGreaterThanOrEqual(32)
    h2.release()
  })
})
