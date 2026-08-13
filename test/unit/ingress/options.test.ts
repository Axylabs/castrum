/**
 * Tests for ingress option validation (`assertKnownIngressOptions`) —
 * fail-fast typo protection for both the fast path and the pre-baked path.
 */

import { describe, test, expect } from 'bun:test'
import { assertKnownIngressOptions, assertIngressOptionValues } from '../../../src/ingress/options'

const VALID_OPTIONS: Record<string, unknown> = {
  trustProxy: false,
  trustedProxies: { enabled: true, networks: ['10.0.0.0/8'] },
  parseCookies: true,
  parseQuery: true,
  requireJsonBody: false,
  schema: new Uint8Array(),
  cors: { allowOrigin: ['*'] },
  rateLimit: { limit: 100, windowMs: 60_000 },
  security: {},
  https: true,
  maxBodyBytes: 1_048_576,
  enableSecurityHeaders: true,
  enableRequestIds: true,
  enableBodySizeGuard: true,
  emitMetadataJson: true,
  readBody: undefined,
  outputBufferSize: 131_072,
  bodyTimeoutMs: 30_000,
  onError: () => {},
  onRequest: () => {},
  onResponse: () => {},
  limits: { maxUrlBytes: 65536 },
}

describe('assertKnownIngressOptions', () => {
  test('accepts a full valid option set (createIngressFast label)', () => {
    expect(() =>
      assertKnownIngressOptions(VALID_OPTIONS as never, 'createIngressFast'),
    ).not.toThrow()
  })

  test('accepts a full valid option set (createIngressHandler label)', () => {
    expect(() =>
      assertKnownIngressOptions(VALID_OPTIONS as never, 'createIngressHandler'),
    ).not.toThrow()
  })

  test('rejects an unknown option and names the createIngressFast label', () => {
    expect(() => assertKnownIngressOptions({ bogus: 1 } as never, 'createIngressFast')).toThrow(
      /createIngressFast: unknown option 'bogus'/,
    )
  })

  test('rejects an unknown option and names the createIngressHandler label', () => {
    // Regression: the error must carry the pre-baked label so a typo in a
    // `createIngressHandler` call is traceable to the right factory.
    expect(() => assertKnownIngressOptions({ bogus: 1 } as never, 'createIngressHandler')).toThrow(
      /createIngressHandler: unknown option 'bogus'/,
    )
  })

  test("rejects a typo'd known-adjacent key (parseCookie missing s)", () => {
    expect(() => assertKnownIngressOptions({ parseCookie: true } as never)).toThrow(
      /unknown option 'parseCookie'/,
    )
  })
})

describe('assertIngressOptionValues', () => {
  test('accepts valid and zero values (0 is meaningful: rateLimit.limit=0 disables)', () => {
    expect(() =>
      assertIngressOptionValues({
        maxBodyBytes: 0,
        outputBufferSize: 0,
        rateLimit: { limit: 0, windowMs: 60_000 },
        limits: { maxHeadersBytes: 4096 },
      } as never),
    ).not.toThrow()
  })

  test('rejects a negative maxBodyBytes', () => {
    expect(() => assertIngressOptionValues({ maxBodyBytes: -1 } as never)).toThrow(/maxBodyBytes/)
  })

  test('rejects a negative nested limits value and names the path', () => {
    expect(() => assertIngressOptionValues({ limits: { maxHeadersBytes: -100 } } as never)).toThrow(
      /limits\.maxHeadersBytes/,
    )
  })

  test('rejects a NaN rateLimit.windowMs', () => {
    expect(() => assertIngressOptionValues({ rateLimit: { windowMs: NaN } } as never)).toThrow(
      /rateLimit\.windowMs/,
    )
  })
})
