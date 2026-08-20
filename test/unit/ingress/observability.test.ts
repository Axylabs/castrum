/**
 * Integration tests for ingress observability: metrics wiring + route factories
 * (src/ingress/metrics.ts, src/ingress/health.ts).
 */

import { describe, expect, test } from 'bun:test'
import type { BakedIngressResult } from '../../../src/ingress/decode/baked-result'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { healthHandler, livenessHandler, readinessHandler } from '../../../src/ingress/health'
import { createIngressMetrics, metricsHandler } from '../../../src/ingress/metrics'

const baseOptions = {
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

describe('createIngressMetrics', () => {
  test('counts requests + records latency through the runtime hooks', () => {
    const m = createIngressMetrics()
    const h = createIngressHandler({ ...baseOptions }, { ...m.runtime })

    const res = h.run<Response>(req('/health'), undefined, null, (result) => {
      const init: ResponseInit = { status: 200 }
      return new Response(result.bodyJson(true), init)
    })
    expect(res.status).toBe(200)

    const out = m.render()
    expect(out).toContain('castrum_http_requests_total{method="GET",status="200"} 1')
    expect(out).toContain('castrum_http_request_duration_seconds_count')
    expect(out).toContain('castrum_http_in_flight_requests 0') // inc + dec balanced
  })

  test('counts rate-limited requests when the pipeline rejects', () => {
    const m = createIngressMetrics()
    const h = createIngressHandler(
      { ...baseOptions, rateLimit: { limit: 1, windowMs: 60_000 } },
      { ...m.runtime },
    )
    const hit = () =>
      h.run<Response>(req('/health'), '1.2.3.4', null, (result) => {
        const init: ResponseInit = { status: result.status ?? 200 }
        return new Response('', init)
      })
    expect(hit().status).toBe(200) // first request allowed
    expect(hit().status).toBe(429) // second request over the limit of 1
    const out = m.render()
    expect(out).toContain('castrum_http_rate_limited_total 1')
  })

  test('exactly-once gauge across onError + onResponse (native failure)', () => {
    // A native pipeline failure fires onError AND onResponse for the SAME
    // request id. The gauge must return to 0 exactly (the old code
    // double-decremented to -1), and the 500 must still be counted.
    const m = createIngressMetrics()
    const { onRequest, onResponse, onError } = m.runtime
    if (onRequest === undefined || onResponse === undefined || onError === undefined) {
      throw new Error('expected metrics runtime hooks')
    }
    const id = 'rid-native-failure'

    onRequest(req('/health'), id, '1.2.3.4')
    onError(req('/health'), id, new Error('native boom'))
    onResponse(req('/health'), { rateLimited: false } as unknown as BakedIngressResult, 500, id)

    const out = m.render()
    expect(out).toContain('castrum_http_in_flight_requests 0')
    expect(out).toContain('castrum_http_requests_total{method="GET",status="500"} 1')
    expect(out).toContain('castrum_http_errors_total{code="Error"} 1')
  })

  test('a throwing route callback ends accounting exactly once (onError only)', () => {
    const m = createIngressMetrics()
    const h = createIngressHandler({ ...baseOptions }, { ...m.runtime })

    // The route callback throws AFTER onRequest — only onError fires. The
    // gauge must not leak (old code fired neither hook).
    expect(() =>
      h.run<Response>(req('/health'), undefined, null, () => {
        throw new Error('route boom')
      }),
    ).toThrow('route boom')

    const out = m.render()
    expect(out).toContain('castrum_http_in_flight_requests 0')
    expect(out).toContain('castrum_http_errors_total{code="Error"} 1')
  })
})

describe('metricsHandler', () => {
  test('serves the registry as Prometheus text/plain', () => {
    const m = createIngressMetrics()
    m.registry.counter('app_total', 'app counter').inc()
    const res = metricsHandler(m)(req('/metrics'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('cache-control')).toBe('no-store')
    return res.text().then((body) => {
      expect(body).toContain('# TYPE app_total counter')
      expect(body).toContain('app_total 1')
    })
  })
})

describe('health probes', () => {
  test('liveness always 200', () => {
    const res = livenessHandler()(req('/healthz'))
    expect(res instanceof Response).toBe(true)
    expect((res as Response).status).toBe(200)
    return (res as Response).json().then((b) => expect((b as { status: string }).status).toBe('ok'))
  })

  test('readiness 200 when no check', async () => {
    const res = await readinessHandler()(req('/readyz'))
    expect(res.status).toBe(200)
  })

  test('readiness 200 when check passes, 503 when it fails/throws', async () => {
    const ok = await readinessHandler(() => true)(req('/readyz'))
    expect(ok.status).toBe(200)

    const fail = await readinessHandler(() => false)(req('/readyz'))
    expect(fail.status).toBe(503)

    const boom = await readinessHandler(() => {
      throw new Error('db down')
    })(req('/readyz'))
    expect(boom.status).toBe(503)
  })

  test('health aliases liveness without a check, readiness with one', async () => {
    const plain = healthHandler()(req('/livez'))
    expect(plain instanceof Response).toBe(true)
    expect((plain as Response).status).toBe(200)
    const withCheck = await healthHandler(() => true)(req('/livez'))
    expect(withCheck.status).toBe(200)
    const down = await healthHandler(() => false)(req('/livez'))
    expect(down.status).toBe(503)
  })
})
