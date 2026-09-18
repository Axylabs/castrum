/**
 * Tests for src/shared/memory.ts — the public `flushMemory()` escape hatch.
 *
 * Covers: clearing the MIME caches, clearing the loader LRU, idempotence,
 * safety before any native call, and the hard rule that the metrics registry
 * is NOT a cache (flushMemory must never clear it).
 */

import { describe, expect, test } from 'bun:test'
import { loader } from '../../../src/loader'
import { encoder } from '../../../src/shared/bytes'
import { flushMemory } from '../../../src/shared/memory'
import { createMetrics } from '../../../src/shared/metrics'
import { rust } from '../../../src/rust-ffi'
import { clearMimeCaches, mimeByText, mimeStrCache } from '../../../src/rust-ffi/context'

describe('flushMemory', () => {
  test('is safe and idempotent before any native call (addon never loaded)', () => {
    expect(() => flushMemory({ gc: false })).not.toThrow()
    expect(() => flushMemory({ gc: false })).not.toThrow()
  })

  test('clears the MIME caches', () => {
    // Populate the string cache through the public text API.
    rust.text.mimeFromExtension('json')
    expect(mimeStrCache.size).toBeGreaterThan(0)
    // Populate the byte cache directly (blob is arbitrary — eviction is keyed).
    mimeByText.set('__flush_probe__', new Uint8Array([1, 2, 3]))
    expect(mimeByText.size).toBeGreaterThan(0)

    flushMemory({ gc: false })

    expect(mimeStrCache.size).toBe(0)
    expect(mimeByText.size).toBe(0)
  })

  test('clearMimeCaches clears both caches directly', () => {
    mimeStrCache.set('__probe__', 'application/x-probe')
    mimeByText.set('__probe__', new Uint8Array([9]))
    clearMimeCaches()
    expect(mimeStrCache.size).toBe(0)
    expect(mimeByText.size).toBe(0)
  })

  test('clears the loader LRU cache', async () => {
    await loader.load('validateEmail', encoder.encode('flush-memory@example.com'), {
      key: 'flush-memory-key',
    })
    expect(loader.stats.cacheSize).toBeGreaterThan(0)

    flushMemory({ gc: false })

    expect(loader.stats.cacheSize).toBe(0)
  })

  test('bounds the process-wide MIME caches', () => {
    clearMimeCaches()
    for (let i = 0; i < 1100; i++) rust.text.mimeFromExtension(`x${i}`)
    expect(mimeStrCache.size).toBeLessThanOrEqual(1024)
  })

  test('calls the native schema-cache clear', () => {
    const original = rust.clearSchemaCache
    let calls = 0
    rust.clearSchemaCache = () => {
      calls++
    }
    try {
      flushMemory({ gc: false })
    } finally {
      rust.clearSchemaCache = original
    }
    expect(calls).toBe(1)
  })

  test('never clears the metrics registry', () => {
    const metrics = createMetrics()
    metrics.counter('flush_keep_total', 'kept across flush').inc()
    flushMemory({ gc: false })
    expect(metrics.render()).toContain('flush_keep_total 1')
  })

  test('requests GC by default without throwing', () => {
    expect(() => flushMemory()).not.toThrow()
  })
})
