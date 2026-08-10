/**
 * Tests for src/ingress/shared.ts `buildHeaderPlan`.
 *
 * The `HeaderPlan` decides which request headers (cookie / cors / proxy /
 * proto) each ingress path extracts into the packed input. It is shared by
 * BOTH paths (`createIngressFast` and `createIngressHandler`). These tests pin
 * the full matrix so the two paths can never silently diverge again.
 *
 * Regression: handlers.ts previously only forwarded proxy headers (XFF /
 * x-real-ip) when rate limiting was ALSO enabled, and ignored
 * `trustedProxies`. Proxy extraction is now driven by the trust configuration
 * alone, matching the fast path.
 */

import { describe, test, expect } from 'bun:test'
import { buildHeaderPlan } from '../../../src/ingress/shared'

describe('buildHeaderPlan', () => {
  test('no trust config → no header extraction', () => {
    expect(buildHeaderPlan({})).toEqual({
      cookie: false,
      cors: false,
      proxy: false,
      proto: false,
    })
  })

  test('parseCookies and cors enable their fields', () => {
    const plan = buildHeaderPlan({
      parseCookies: true,
      cors: { allowOrigin: ['*'] },
    })
    expect(plan.cookie).toBe(true)
    expect(plan.cors).toBe(true)
    expect(plan.proxy).toBe(false)
    expect(plan.proto).toBe(false)
  })

  test('trustProxy: true enables proxy and proto (https unpinned)', () => {
    const plan = buildHeaderPlan({ trustProxy: true })
    expect(plan.proxy).toBe(true)
    expect(plan.proto).toBe(true)
  })

  test('trustedProxies.enabled: true enables proxy without trustProxy', () => {
    const plan = buildHeaderPlan({ trustedProxies: { enabled: true } })
    expect(plan.proxy).toBe(true)
    expect(plan.proto).toBe(true)
  })

  test('trustedProxies.enabled: false does not enable proxy', () => {
    const plan = buildHeaderPlan({ trustedProxies: { enabled: false } })
    expect(plan.proxy).toBe(false)
    expect(plan.proto).toBe(false)
  })

  test('explicit https pin disables proto detection even when trusted', () => {
    const plan = buildHeaderPlan({ trustProxy: true, https: true })
    expect(plan.proxy).toBe(true)
    expect(plan.proto).toBe(false)
  })

  test('proxy extraction is independent of rate limiting (regression)', () => {
    // The old handlers.ts headerPlan only forwarded proxy headers when rate
    // limiting was enabled. Proxy forwarding must be driven by trust alone.
    const plan = buildHeaderPlan({ trustProxy: true })
    expect(plan.proxy).toBe(true)
  })
})
