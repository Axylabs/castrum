/**
 * Tests for the metrics registry: `rust.createMetricsRegistry()` — counters,
 * gauges, histograms, the deterministic Prometheus render, and ffi↔napi
 * parity (the addon's `MetricsRegistry` class is constructed directly so both
 * transports are exercised in one process).
 */

import { describe, expect, test } from 'bun:test'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'

describe('createMetricsRegistry (public surface)', () => {
  test('counters accumulate per label set', () => {
    const m = rust.createMetricsRegistry()
    const hits = m.counter('test_hits_total', ['route', 'status'])
    expect(hits).toBe(0)
    m.record(hits, ['/a', '200'], 2)
    m.record(hits, ['/a', '200'], 1)
    m.record(hits, ['/b', '500'], 1)
    const text = m.render()
    expect(text).toContain('test_hits_total{route="/a",status="200"} 3\n')
    expect(text).toContain('test_hits_total{route="/b",status="500"} 1\n')
    expect(text).toContain('# TYPE test_hits_total counter')
    m.destroy?.()
  })

  test('declare is idempotent per shape', () => {
    const m = rust.createMetricsRegistry()
    const a = m.counter('test_idem_total', ['x'])
    const b = m.counter('test_idem_total', ['x'])
    expect(b).toBe(a)
    expect(() => m.gauge('test_idem_total', ['x'])).toThrow()
    expect(() => m.counter('test_idem_total', ['x', 'y'])).toThrow()
    m.destroy?.()
  })

  test('gauges support add and set; set rejects counters', () => {
    const m = rust.createMetricsRegistry()
    const g = m.gauge('test_depth', [])
    m.record(g, [], 10)
    m.gaugeSet(g, [], 4.5)
    expect(m.render()).toContain('test_depth 4.5\n')
    const c = m.counter('test_c', [])
    expect(() => m.gaugeSet(c, [], 1)).toThrow()
    m.destroy?.()
  })

  test('histograms render cumulative buckets + sum + count', () => {
    const m = rust.createMetricsRegistry()
    const h = m.histogram('test_latency_seconds', ['op'], [0.1, 0.5])
    for (const v of [0.05, 0.2, 0.7]) m.record(h, ['get'], v)
    const t = m.render()
    expect(t).toContain('test_latency_seconds_bucket{op="get",le="0.1"} 1\n')
    expect(t).toContain('test_latency_seconds_bucket{op="get",le="0.5"} 2\n')
    expect(t).toContain('test_latency_seconds_bucket{op="get",le="+Inf"} 3\n')
    expect(t).toContain('test_latency_seconds_sum{op="get"} 0.95\n')
    expect(t).toContain('test_latency_seconds_count{op="get"} 3\n')
    m.destroy?.()
  })

  test('default buckets apply when omitted', () => {
    const m = rust.createMetricsRegistry()
    const h = m.histogram('test_defaults')
    expect(h).toBeGreaterThanOrEqual(0)
    m.record(h, undefined, 100)
    const t = m.render()
    expect(t).toContain('test_defaults_bucket{le="+Inf"} 1\n')
    // default top bucket is 10 — 100 must NOT land there
    expect(t).not.toContain('test_defaults_bucket{le="10"} 1\n')
    m.destroy?.()
  })

  test('label values with quotes/backslashes/newlines are escaped at render', () => {
    const m = rust.createMetricsRegistry()
    const c = m.counter('test_esc', ['path'])
    m.record(c, ['/a"b\\c'], 1)
    expect(m.render()).toContain('test_esc{path="/a\\"b\\\\c"} 1\n')
    m.destroy?.()
  })

  test('render is byte-deterministic across calls', () => {
    const m = rust.createMetricsRegistry()
    const c = m.counter('test_det', ['k'])
    for (let i = 0; i < 50; i++) m.record(c, [`k${i}`], 1)
    expect(m.render()).toBe(m.render())
    m.destroy?.()
  })

  test('invalid declarations throw', () => {
    const m = rust.createMetricsRegistry()
    expect(() => m.counter('9bad-name')).toThrow()
    expect(() => m.counter('ok', ['bad-label'])).toThrow()
    expect(() => m.histogram('h', [], [0])).toThrow()
    m.destroy?.()
  })
})

describe('metrics ffi ↔ napi parity', () => {
  test('the napi MetricsRegistry class produces the same render as the public wrapper', () => {
    const addon = getAddon()
    if (typeof addon.MetricsRegistry !== 'function') {
      throw new Error('addon.MetricsRegistry missing — rebuild the addon (bun run build)')
    }
    const napi = new addon.MetricsRegistry()
    const c = napi.counter('parity_total', ['k'])
    napi.record(c, ['v'], 5)
    const h = napi.histogram('parity_hist', [], [1])
    napi.record(h, [], 0.5)

    const m = rust.createMetricsRegistry()
    const c2 = m.counter('parity_total', ['k'])
    m.record(c2, ['v'], 5)
    const h2 = m.histogram('parity_hist', [], [1])
    m.record(h2, [], 0.5)

    expect(m.render()).toBe(napi.render())
    // seriesCount is napi-only (the ffi wrapper omits it — introspection is
    // not worth a dedicated C-ABI symbol); under CASTRUM_FFI_MODE=napi the
    // public wrapper IS the napi class, so it may exist there too.
    expect(napi.seriesCount?.()).toBe(2)
    if (m.seriesCount) expect(m.seriesCount()).toBe(2)
  })

  test('record arity mismatch fails on BOTH transports', () => {
    const addon = getAddon()
    const napi = new addon.MetricsRegistry()
    const nc = napi.counter('arity_total', ['a'])
    expect(() => napi.record(nc, [], 1)).toThrow()

    const m = rust.createMetricsRegistry()
    const mc = m.counter('arity_total', ['a'])
    expect(() => m.record(mc, [], 1)).toThrow()
  })
})
