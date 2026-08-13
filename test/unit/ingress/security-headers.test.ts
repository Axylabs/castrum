/**
 * Tests for security-header handling on the pre-baked handler path
 * (src/ingress/handlers.ts + src/ingress/headers/hsts.ts).
 *
 * Covers the "security-preheat gotcha" regression: `options.security`
 * (structured SecurityHeadersOptions) must be honored by `createIngressHandler`
 * — it was previously SILENTLY IGNORED (only raw `runtime.securityHeaders`
 * were baked). Also pins the baked path's default of NO security headers when
 * neither source is provided, and the raw-wins merge rule.
 */

import { describe, test, expect } from 'bun:test'
import { createIngressHandler, readHandler } from '../../../src/ingress/handlers'
import { buildSecurityPairs } from '../../../src/ingress/headers/hsts'

const baseOptions = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init)
}

async function responseHeadersFor(
  options: Parameters<typeof createIngressHandler>[0],
  runtime: Parameters<typeof createIngressHandler>[1] = {},
): Promise<Record<string, string>> {
  const h = createIngressHandler(options, runtime)
  const res = await readHandler(h)(req('/health'))
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

describe('pre-baked security headers', () => {
  test('options.security is honored (structured → header pairs)', async () => {
    const headers = await responseHeadersFor({
      ...baseOptions,
      security: { xssProtection: '1; mode=block' },
    })
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-xss-protection']).toBe('1; mode=block')
  })

  test('baked default stays: no security headers without options.security', async () => {
    const headers = await responseHeadersFor({ ...baseOptions })
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers['referrer-policy']).toBeUndefined()
    expect(headers['x-content-type-options']).toBeUndefined()
  })

  test('raw runtime.securityHeaders still work (legacy path)', async () => {
    const headers = await responseHeadersFor(
      { ...baseOptions },
      { securityHeaders: [['x-custom', '1']] },
    )
    expect(headers['x-custom']).toBe('1')
  })

  test('raw runtime.securityHeaders override structured on name conflict', async () => {
    const headers = await responseHeadersFor(
      { ...baseOptions, security: { frameOptions: 'SAMEORIGIN' } },
      { securityHeaders: [['x-frame-options', 'DENY']] },
    )
    expect(headers['x-frame-options']).toBe('DENY')
  })

  test('runtime.enableSecurityHeaders=false disables all security', async () => {
    const headers = await responseHeadersFor(
      { ...baseOptions, security: { xssProtection: '1' } },
      { enableSecurityHeaders: false },
    )
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers['x-xss-protection']).toBeUndefined()
  })

  test('buildSecurityPairs: disabled yields no pairs; https gates HSTS', () => {
    expect(buildSecurityPairs({}, true, false)).toEqual([])
    expect(buildSecurityPairs({ hsts: true }, true, true)).toContainEqual([
      'strict-transport-security',
      'max-age=31536000',
    ])
    // HSTS is only emitted statically when https === true (dynamic HSTS is a
    // per-request fast-path concern).
    const noHttps = buildSecurityPairs({ hsts: true }, undefined, true)
    expect(noHttps.some(([key]) => key === 'strict-transport-security')).toBe(false)
  })
})
