// test/unit/ingress/native-route-response.test.ts — route-wire v6 native
// response projection (`castrum_route_*` / napi `Route`).
//
// v6 lets an OK plan select a response class natively, but the native side
// returns only the class tag + substitution slots; JS assembles against a
// compile-time template (`compileResponseTemplate` / `assembleRouteResponse`).
// A descriptor still carries a `response` part (status + static headers + a
// body template). This suite pins the encode/decode round-trip, the request-id
// substitution, the needed-size convention, and the v5 hard-reject against
// BOTH the `bun:ffi` route surface and the napi `Route` class.

import { describe, expect, test } from 'bun:test'
import {
  assembleRouteResponse,
  compileResponseTemplate,
  decodeRouteResult,
  decodeRouteSubstitutions,
  encodeResponseProjection,
  encodeRouteDescriptor,
  packRouteFrame,
  ROUTE_FLAG,
  ROUTE_PART,
  ROUTE_SLOT,
  ROUTE_STAGE,
  type RouteWireResponse,
} from '../../../src/ingress'
import { getAddon } from '../../../src/native'
import { getBunFFI } from '../../../src/native/ffi'
import { encoder } from '../../../src/shared/bytes'
import { isBun } from '../../../src/shared/runtime'

const LIMITS = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
}
const RID = '0193f2c4-0000-7000-8000-000000000000'

const PROJECTION: RouteWireResponse = {
  status: 201,
  headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
  body: encoder.encode(`{"ok":true,"requestId":"{requestId}","path":"/api/users"}`),
}

/** A v6 descriptor carrying a parseQuery stage + a response template. */
function responsePlan(response: RouteWireResponse = PROJECTION): Uint8Array {
  return encodeRouteDescriptor(
    [ROUTE_STAGE.parseQuery],
    [{ part: ROUTE_PART.response, bytes: encodeResponseProjection(response) }],
    LIMITS,
  )
}

describe('route-wire v6 response projection (napi Route)', () => {
  test('OK: the substitution section replaces pair sections', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return // pre-rebuild addon — skip
    const route = new addon.Route(responsePlan())
    const out = new Uint8Array(512)
    const w = route.run(packRouteFrame('page=1', '', null, RID), out)
    expect(w).toBeGreaterThan(8)

    const view = new DataView(out.buffer)
    expect(view.getUint32(0, true) & ROUTE_FLAG.OK).toBe(ROUTE_FLAG.OK)
    expect(view.getUint32(0, true) & ROUTE_FLAG.HAS_RESPONSE).toBe(ROUTE_FLAG.HAS_RESPONSE)
    const classTag = (view.getUint32(0, true) >>> ROUTE_FLAG.CLASS_SHIFT) & 0xff
    expect(classTag).toBe(0)

    const { slots } = decodeRouteSubstitutions(out.subarray(0, w))
    expect(slots[ROUTE_SLOT.requestId]).toEqual(encoder.encode(RID))

    // JS assembles the response against the compile-time template.
    const assembled = assembleRouteResponse(compileResponseTemplate(PROJECTION), slots)
    expect(assembled.status).toBe(201)
    expect(assembled.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(new TextDecoder().decode(assembled.body)).toBe(
      `{"ok":true,"requestId":"${RID}","path":"/api/users"}`,
    )
  })

  test('needed-size convention: exact required size, nothing written to a small buffer', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return
    const route = new addon.Route(responsePlan())
    const frame = packRouteFrame('', '', null, RID)
    const small = new Uint8Array(8)
    const needed = route.run(frame, small)
    expect(needed).toBeGreaterThan(8)
    expect(small).toEqual(new Uint8Array(8))
    const exact = new Uint8Array(needed)
    expect(route.run(frame, exact)).toBe(needed)
  })

  test('v5 descriptor is a hard reject on a v6 addon', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return
    const desc = responsePlan()
    new DataView(desc.buffer).setUint32(4, 5, true) // force version 5
    expect(() => new addon.Route(desc)).toThrow()
  })

  test('non-OK verdict keeps the verdict shape (no response)', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return
    // requireJsonBody + a response projection: a bad body must yield 400 with
    // no HAS_RESPONSE bit so the caller can reject.
    const response = encodeResponseProjection({
      status: 200,
      headers: [],
      body: encoder.encode('{}'),
    })
    const desc = encodeRouteDescriptor(
      [ROUTE_STAGE.requireJsonBody],
      [{ part: ROUTE_PART.response, bytes: response }],
      LIMITS,
    )
    const route = new addon.Route(desc)
    const out = new Uint8Array(64)
    const w = route.run(packRouteFrame('', '', encoder.encode('not json')), out)
    const view = new DataView(out.buffer)
    expect(view.getUint32(4, true)).toBe(400)
    expect(view.getUint32(0, true) & ROUTE_FLAG.OK).toBe(0)
    expect(view.getUint32(0, true) & ROUTE_FLAG.HAS_RESPONSE).toBe(0)
    expect(w).toBe(8) // verdict header only
  })
})

describe('route-wire v6 response projection (bun:ffi)', () => {
  test('ffi result matches napi: class + request-id substitution', () => {
    const ffi = getBunFFI()
    if (!isBun() || ffi === null) return
    const handle = ffi.routeCompile(responsePlan())
    expect(handle).not.toBe(0)
    const frame = packRouteFrame('a=1', 's=v', null, RID)
    const out = new Uint8Array(512)
    const w = ffi.routeRun(handle, frame, out)
    expect(w).toBeGreaterThan(8)
    const r = decodeRouteResult(out.subarray(0, w), { query: false, cookie: false })
    expect(r.flags & ROUTE_FLAG.HAS_RESPONSE).toBe(ROUTE_FLAG.HAS_RESPONSE)
    expect(r.slots[ROUTE_SLOT.requestId]).toEqual(encoder.encode(RID))
    const assembled = assembleRouteResponse(compileResponseTemplate(PROJECTION), r.slots)
    expect(assembled.status).toBe(201)
    expect(new TextDecoder().decode(assembled.body)).toBe(
      `{"ok":true,"requestId":"${RID}","path":"/api/users"}`,
    )
    // A too-small buffer reports the exact required size.
    const small = new Uint8Array(8)
    expect(ffi.routeRun(handle, frame, small)).toBe(w)
    ffi.routeDestroy(handle)
  })
})
