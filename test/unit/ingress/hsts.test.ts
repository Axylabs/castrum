/**
 * Tests for src/ingress/headers/hsts.ts — Strict-Transport-Security builder
 * (previously untested).
 */

import { describe, expect, test } from 'bun:test'
import { buildHstsValue } from '../../../src/ingress/headers/hsts'

describe('buildHstsValue', () => {
  test('returns null when HSTS is not configured', () => {
    expect(buildHstsValue({})).toBeNull()
    expect(buildHstsValue({ contentSecurityPolicy: "default-src 'none'" })).toBeNull()
  })

  test('hsts:true uses the default max-age', () => {
    expect(buildHstsValue({ hsts: true })).toBe('max-age=31536000')
  })

  test('honors hstsMaxAge', () => {
    expect(buildHstsValue({ hstsMaxAge: 60 })).toBe('max-age=60')
  })

  test('appends includeSubDomains and preload when set', () => {
    expect(buildHstsValue({ hsts: true, hstsIncludeSubdomains: true, hstsPreload: true })).toBe(
      'max-age=31536000; includeSubDomains; preload',
    )
  })

  test('any HSTS field turns the feature on', () => {
    expect(buildHstsValue({ hstsIncludeSubdomains: true })).toBe(
      'max-age=31536000; includeSubDomains',
    )
    expect(buildHstsValue({ hstsPreload: true })).toBe('max-age=31536000; preload')
  })
})
