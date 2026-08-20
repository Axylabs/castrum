/**
 * Tests for the zero-dep metrics registry (src/shared/metrics.ts).
 */

import { describe, expect, test } from 'bun:test'
import { createMetrics } from '../../../src/shared/metrics'

describe('createMetrics', () => {
  test('counter increments and renders Prometheus text', () => {
    const m = createMetrics()
    const c = m.counter('castrum_requests_total', 'Total requests.', ['method'])
    c.inc({ method: 'GET' })
    c.inc({ method: 'GET' })
    c.inc({ method: 'POST' })
    const out = m.render()
    expect(out).toContain('# HELP castrum_requests_total Total requests.')
    expect(out).toContain('# TYPE castrum_requests_total counter')
    expect(out).toContain('castrum_requests_total{method="GET"} 2')
    expect(out).toContain('castrum_requests_total{method="POST"} 1')
  })

  test('unlabelled counter renders without braces', () => {
    const m = createMetrics()
    m.counter('plain_total', 'plain').inc()
    expect(m.render()).toContain('plain_total 1')
  })

  test('gauge inc/dec/set', () => {
    const m = createMetrics()
    const g = m.gauge('inflight', 'in-flight')
    g.inc()
    g.inc()
    g.dec()
    expect(m.render()).toContain('inflight 1')
    g.set(undefined, 7)
    expect(m.render()).toContain('inflight 7')
  })

  test('histogram accumulates buckets, sum and count', () => {
    const m = createMetrics()
    const h = m.histogram('latency_seconds', 'latency', [0.01, 0.1])
    h.observe(0.005)
    h.observe(0.05)
    h.observe(0.5)
    const out = m.render()
    expect(out).toContain('latency_seconds_bucket{le="0.01"} 1')
    expect(out).toContain('latency_seconds_bucket{le="0.1"} 2')
    expect(out).toContain('latency_seconds_bucket{le="+Inf"} 3')
    expect(out).toContain('latency_seconds_sum 0.555')
    expect(out).toContain('latency_seconds_count 3')
  })

  test('labelled histogram keeps label sets separate', () => {
    const m = createMetrics()
    const h = m.histogram('h_seconds', 'h', undefined, ['status'])
    h.observe(0.02, { status: '200' })
    h.observe(0.2, { status: '500' })
    const out = m.render()
    expect(out).toContain('h_seconds_bucket{status="200",le="0.025"} 1')
    expect(out).toContain('h_seconds_bucket{status="500",le="+Inf"} 1')
  })

  test('reset clears all metrics', () => {
    const m = createMetrics()
    m.counter('a_total', 'a').inc()
    m.gauge('b', 'b').set(undefined, 3)
    m.histogram('c_seconds', 'c').observe(0.1)
    m.reset()
    expect(m.render().trim()).toBe('')
  })

  test('escapes label values with quotes and backslashes', () => {
    const m = createMetrics()
    const c = m.counter('x_total', 'x', ['method'])
    c.inc({ method: 'we"ird\\path' })
    expect(m.render()).toContain('x_total{method="we\\"ird\\\\path"} 1')
  })
})
