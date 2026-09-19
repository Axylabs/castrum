// test/unit/ingress/native-route-program.test.ts — route-wire v5 op program
// (`castrum_route_*` / napi `Route`).
//
// v5 lowers the framework layer into an OPEN op program: parse → IP trust →
// CORS → rate limit → body validation → security → response projection. The
// program's class templates are built by `buildProgramPlan`, which reuses the
// pre-baked JS header/body builders, so the native output is byte-parity with
// the JS path. This suite pins the OK / preflight (204, 403) / rate-limited
// (429) decisions, the op-program wire rejects, and the public
// `createNativeRoute({ program })` surface.

import { describe, expect, test } from 'bun:test'
import {
  buildProgramPlan,
  createNativeRoute,
  encodeProgram,
  encodeRouteDescriptor,
  METHOD_KIND,
  ROUTE_FLAG,
  ROUTE_OP,
  ROUTE_PART,
  ROUTE_PROGRAM_VERSION,
  type RouteWireResponse,
} from '../../../src/ingress'
import { getAddon } from '../../../src/native'
import { getBunFFI } from '../../../src/native/ffi'
import { encoder } from '../../../src/shared/bytes'

const RID = '0193f2c4-0000-7000-8000-000000000000'

function nativeAvailable(): boolean {
  if (getBunFFI() !== null) return true
  const addon = getAddon() as { Route?: unknown }
  return typeof addon.Route === 'function'
}

function okResponse(): RouteWireResponse {
  return {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: encoder.encode(`{"ok":true,"requestId":"{requestId}"}`),
  }
}

/** A GET route with wildcard CORS + security headers + an optional rate limit. */
function programRoute(rateLimit?: { limit: number; windowMs?: number; maxEntries?: number }) {
  return createNativeRoute({
    response: okResponse(),
    program: {
      parseQuery: true,
      cors: { allowOrigin: ['*'] },
      security: {},
      ...(rateLimit ? { rateLimit } : {}),
      requestIdHeader: false,
    },
  })
}

const GET_PROGRAM = {
  methodKind: METHOD_KIND.GET,
  ip: '203.0.113.5',
  headers: [['origin', 'https://app.example.com']] as Array<[string, string]>,
}

describe('route-wire v5 op program', () => {
  test('OK with a simple CORS origin echoes the origin + security headers', async () => {
    if (!nativeAvailable()) return
    const route = programRoute()
    const r = route.run('a=1', '', null, GET_PROGRAM, RID)
    expect(r.flags & ROUTE_FLAG.HAS_RESPONSE).toBe(ROUTE_FLAG.HAS_RESPONSE)
    expect(r.flags & ROUTE_FLAG.OK).toBe(ROUTE_FLAG.OK)
    const resp = route.assembleResponse(r)
    expect(resp).not.toBeNull()
    expect(resp!.status).toBe(200)
    // `Headers` iteration is sorted; compare as a map.
    const got = Object.fromEntries([...resp!.headers]) as Record<string, string>
    expect(got).toEqual({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-type': 'application/json',
      vary: 'Origin',
      'access-control-allow-origin': 'https://app.example.com',
    })
    expect(await resp!.text()).toBe(`{"ok":true,"requestId":"${RID}"}`)
  })

  test('OK without an Origin omits CORS headers', () => {
    if (!nativeAvailable()) return
    const route = programRoute()
    const r = route.run('', '', null, { methodKind: METHOD_KIND.GET, ip: '203.0.113.6' }, RID)
    const resp = route.assembleResponse(r)
    expect(resp).not.toBeNull()
    expect(Object.fromEntries([...resp!.headers])).toEqual({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-type': 'application/json',
    })
  })

  test('CORS preflight: allowed -> 204, disallowed -> 403', () => {
    if (!nativeAvailable()) return
    const route = programRoute()
    const base = { methodKind: METHOD_KIND.OPTIONS, ip: '203.0.113.7' }

    const allowed = route.run(
      '',
      '',
      null,
      {
        ...base,
        headers: [
          ['origin', 'https://app.example.com'],
          ['access-control-request-method', 'POST'],
        ],
      },
      RID,
    )
    expect(allowed.errorCode).toBe(0)
    const allowedResp = route.assembleResponse(allowed)
    expect(allowedResp!.status).toBe(204)
    expect(allowedResp!.headers.get('access-control-allow-methods')).toBe('GET, HEAD, POST')

    const denied = route.run(
      '',
      '',
      null,
      {
        ...base,
        headers: [
          ['origin', 'https://app.example.com'],
          ['access-control-request-method', 'DELETE'],
        ],
      },
      RID,
    )
    expect(denied.errorCode).toBe(403)
    expect(denied.flags & ROUTE_FLAG.OK).toBe(0)
    const deniedResp = route.assembleResponse(denied)
    expect(deniedResp!.status).toBe(403)
    expect(deniedResp!.headers.get('cache-control')).toBe('no-store')
  })

  test('rate limit: second request from the same IP -> 429 with substituted values', async () => {
    if (!nativeAvailable()) return
    const route = programRoute({ limit: 1, windowMs: 60_000, maxEntries: 1024 })
    const pre = { methodKind: METHOD_KIND.GET, ip: '198.51.100.9' }
    route.run('', '', null, pre, RID)
    const denied = route.run('', '', null, pre, RID)
    expect(denied.errorCode).toBe(429)
    const resp = route.assembleResponse(denied)
    expect(resp!.status).toBe(429)
    expect(resp!.headers.get('ratelimit-remaining')).toBe('0')
    const json = await resp!.text()
    expect(json).toStartWith('{"ok":false,"error":{"code":"rate_limited"')
    expect(json).not.toContain('{retryAfterMs}')
  })

  test('program wire: unknown op tag is a hard reject', () => {
    const addon = getAddon() as { Route?: new (d: Uint8Array) => unknown }
    if (typeof addon.Route !== 'function') return
    const built = buildProgramPlan({ cors: { allowOrigin: ['*'] } }, okResponse())
    const ops = [...built.ops, { tag: 200 as never, a: 0, b: 0, c: 0 }]
    const unsafe = encodeProgram(built.consts, ops)
    const desc = encodeRouteDescriptor(
      [],
      [],
      { maxBodyBytes: 2 * 1024 * 1024, maxQueryBytes: 8192, maxCookieBytes: 8192, maxPairs: 0 },
      unsafe,
    )
    expect(() => new addon.Route!(desc)).toThrow()
  })

  test('program wire: a callout op is a hard reject (JS fallback)', () => {
    const addon = getAddon() as { Route?: new (d: Uint8Array) => unknown }
    if (typeof addon.Route !== 'function') return
    const built = buildProgramPlan({}, okResponse())
    const ops = [{ tag: ROUTE_OP.callout, a: 1, b: 0, c: 0 }, ...built.ops]
    const desc = encodeRouteDescriptor(
      [],
      [],
      { maxBodyBytes: 2 * 1024 * 1024, maxQueryBytes: 8192, maxCookieBytes: 8192, maxPairs: 0 },
      encodeProgram(built.consts, ops),
    )
    expect(() => new addon.Route!(desc)).toThrow()
  })

  test('program part tag + version are the v5 contract', () => {
    const built = buildProgramPlan({}, okResponse())
    const prog = encodeProgram(built.consts, built.ops)
    expect(prog[0]).toBe(ROUTE_PROGRAM_VERSION)
    const desc = encodeRouteDescriptor(
      [],
      [],
      { maxBodyBytes: 2 * 1024 * 1024, maxQueryBytes: 8192, maxCookieBytes: 8192, maxPairs: 0 },
      prog,
    )
    // Layout: 0 magic, 4 version, 8..24 limits, 24 stageCount(0),
    // 28 partCount(1), 32 part tag.
    expect(new DataView(desc.buffer).getUint32(28, true)).toBe(1)
    expect(desc[32]).toBe(ROUTE_PART.program)
    const addon = getAddon() as { Route?: new (d: Uint8Array) => unknown }
    if (typeof addon.Route === 'function') {
      expect(() => new addon.Route!(desc)).not.toThrow()
    }
  })

  test('a v4 descriptor is a hard reject against a v5 addon', () => {
    const addon = getAddon() as { Route?: new (d: Uint8Array) => unknown }
    if (typeof addon.Route !== 'function') return
    const built = buildProgramPlan({ cors: { allowOrigin: ['*'] }, security: {} }, okResponse())
    const desc = encodeRouteDescriptor(
      [],
      [],
      { maxBodyBytes: 2 * 1024 * 1024, maxQueryBytes: 8192, maxCookieBytes: 8192, maxPairs: 0 },
      encodeProgram(built.consts, built.ops),
    )
    expect(() => new addon.Route!(desc)).not.toThrow()
    new DataView(desc.buffer).setUint32(4, 4, true)
    expect(() => new addon.Route!(desc)).toThrow()
  })
})
