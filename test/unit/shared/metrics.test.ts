/**
 * Tests for the zero-dep metrics registry (src/shared/metrics.ts).
 */

import { describe, expect, test } from 'bun:test'
import { createMetrics, MAX_SERIES_PER_METRIC } from '../../../src/shared/metrics'

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

describe('createMetrics cardinality cap', () => {
  test('does not render the dropped counter below the cap', () => {
    const m = createMetrics()
    const c = m.counter('bounded_total', 'bounded', ['k'])
    for (let i = 0; i < 100; i++) c.inc({ k: String(i) })
    expect(m.render()).not.toContain('castrum_metrics_series_dropped_total')
  })

  test('evicts the oldest half and counts drops on overflow', () => {
    const m = createMetrics()
    const c = m.counter('capped_total', 'capped', ['k'])
    const total = MAX_SERIES_PER_METRIC + 1
    for (let i = 0; i < total; i++) c.inc({ k: String(i) })

    const out = m.render()
    // Observable drop counter is rendered with a non-zero value.
    expect(out).toContain('# TYPE castrum_metrics_series_dropped_total counter')
    expect(out).toMatch(/castrum_metrics_series_dropped_total ([1-9]\d*)/)
    // The oldest-half eviction keeps the family bounded (cap + 1 new - half).
    const renderedSeries = out.split('\n').filter((l) => l.startsWith('capped_total{')).length
    expect(renderedSeries).toBeLessThanOrEqual(MAX_SERIES_PER_METRIC)
    expect(renderedSeries).toBe(Math.ceil(MAX_SERIES_PER_METRIC / 2) + 1)
  })

  test('caps each family independently', () => {
    const m = createMetrics()
    const c = m.counter('fam_a_total', 'a', ['k'])
    const g = m.gauge('fam_b', 'b', ['k'])
    for (let i = 0; i < MAX_SERIES_PER_METRIC; i++) {
      c.inc({ k: String(i) })
      g.set({ k: String(i) }, i)
    }
    expect(m.render()).not.toContain('castrum_metrics_series_dropped_total')
  })

  test('reset clears the dropped counter too', () => {
    const m = createMetrics()
    const c = m.counter('reset_capped_total', 'capped', ['k'])
    for (let i = 0; i <= MAX_SERIES_PER_METRIC; i++) c.inc({ k: String(i) })
    expect(m.render()).toContain('castrum_metrics_series_dropped_total')
    m.reset()
    expect(m.render().trim()).toBe('')
  })

  test('does not emit a duplicate family for the reserved dropped counter name', () => {
    const m = createMetrics()
    // A caller (mis)registers the reserved name.
    m.counter('castrum_metrics_series_dropped_total', 'caller owned')
    const c = m.counter('dup_capped_total', 'capped', ['k'])
    for (let i = 0; i <= MAX_SERIES_PER_METRIC; i++) c.inc({ k: String(i) })

    const out = m.render()
    const helpLines = out
      .split('\n')
      .filter((l) => l.startsWith('# HELP castrum_metrics_series_dropped_total'))
    const typeLines = out
      .split('\n')
      .filter((l) => l.startsWith('# TYPE castrum_metrics_series_dropped_total'))
    // Exactly one HELP/TYPE pair — a duplicate family would invalidate the scrape.
    expect(helpLines).toHaveLength(1)
    expect(typeLines).toHaveLength(1)
  })
})

describe('createMetrics histogram cardinality cap', () => {
  test('keeps counts and sums in sync on overflow and bounds the family', () => {
    const m = createMetrics()
    const h = m.histogram('cap_hist_seconds', 'capped', [0.01, 0.1], ['k'])
    for (let i = 0; i <= MAX_SERIES_PER_METRIC; i++) h.observe(0.05, { k: String(i) })

    const out = m.render()
    const lines = out.split('\n')

    // (a) the drop is observable and counted exactly once.
    expect(out).toContain('castrum_metrics_series_dropped_total 5000')

    // (c) the family is bounded to the oldest-half policy.
    const bucketKeys = new Set(
      lines
        .map((l) => /^cap_hist_seconds_bucket\{k="([^"]+)",le=/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined),
    )
    expect(bucketKeys.size).toBe(Math.ceil(MAX_SERIES_PER_METRIC / 2) + 1)
    expect(bucketKeys.size).toBeLessThanOrEqual(MAX_SERIES_PER_METRIC)

    // (b) no orphan `sums`/`counts`: every rendered `_sum`/`_count` key must have
    // a matching `_bucket` series, and the rendered series counts must agree
    // exactly (a leak or double count fails here).
    const sumKeys = new Set(
      lines
        .map((l) => /^cap_hist_seconds_sum\{k="([^"]+)"\}/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined),
    )
    const countKeys = new Set(
      lines
        .map((l) => /^cap_hist_seconds_count\{k="([^"]+)"\}/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined),
    )
    const bucketSorted = [...bucketKeys].sort()
    expect([...sumKeys].sort()).toEqual(bucketSorted)
    expect([...countKeys].sort()).toEqual(bucketSorted)
    expect([...sumKeys]).toHaveLength(bucketKeys.size)

    // Render emits `_sum`/`_count` per surviving `counts` entry, so an orphan
    // `sums` entry is invisible to the structural check above. Re-observing an
    // EVICTED key is the real regression probe: if `sums` leaked, the stale sum
    // is added to the fresh series and this value doubles (0.05 → 0.10).
    h.observe(0.05, { k: '0' })
    expect(m.render()).toContain('cap_hist_seconds_sum{k="0"} 0.05')
  })
})
