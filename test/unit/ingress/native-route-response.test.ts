// test/unit/ingress/native-route-response.test.ts — route-wire v4 native
// response projection (`castrum_route_*` / napi `Route`).
//
// v4 lets an OK plan build the 2xx natively: a descriptor may carry a
// `response` part (status + static headers + a constant pre-encoded body with
// one `{requestId}` placeholder). On OK the native result payload is the framed
// response instead of the query/cookie pair sections. This suite pins the
// encode/decode round-trip, the placeholder substitution, the needed-size
// convention, and the v3 hard-reject against BOTH the `bun:ffi` route surface
// and the napi `Route` class.

import { describe, expect, test } from 'bun:test'
import {
  decodeRouteResponse,
  encodeResponseProjection,
  encodeRouteDescriptor,
  packRouteFrame,
  ROUTE_FLAG,
  ROUTE_PART,
  ROUTE_REQUEST_ID_PLACEHOLDER,
  ROUTE_STAGE,
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

/** A v4 descriptor carrying a parseQuery stage + a response projection. */
function responsePlan(
  status = 200,
  headers: Array<{ name: string; value: string }> = [
    { name: 'content-type', value: 'application/json; charset=utf-8' },
  ],
  body = `{"ok":true,"requestId":"${ROUTE_REQUEST_ID_PLACEHOLDER}","path":"/api/users"}`,
): Uint8Array {
  const response = encodeResponseProjection({
    status,
    headers,
    body: encoder.encode(body),
  })
  return encodeRouteDescriptor(
    [ROUTE_STAGE.parseQuery],
    [{ part: ROUTE_PART.response, bytes: response }],
    LIMITS,
  )
}

describe('route-wire v4 response projection (napi Route)', () => {
  test('OK: framed response replaces pair sections', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return // pre-rebuild addon — skip
    const route = new addon.Route(responsePlan(201))
    const out = new Uint8Array(512)
    const w = route.run(packRouteFrame('page=1', '', null, RID), out)
    expect(w).toBeGreaterThan(8)

    const view = new DataView(out.buffer)
    expect(view.getUint32(0, true) & ROUTE_FLAG.OK).toBe(ROUTE_FLAG.OK)
    expect(view.getUint32(0, true) & ROUTE_FLAG.HAS_RESPONSE).toBe(ROUTE_FLAG.HAS_RESPONSE)

    const resp = decodeRouteResponse(out.subarray(0, w))
    expect(resp.status).toBe(201)
    expect(resp.headers).toEqual([['content-type', 'application/json; charset=utf-8']])
    expect(new TextDecoder().decode(resp.body)).toBe(
      `{"ok":true,"requestId":"${RID}","path":"/api/users"}`,
    )
    // No query pair section leaked into a response-mode result.
    expect(
      new TextDecoder().decode(out.subarray(0, w)).includes(ROUTE_REQUEST_ID_PLACEHOLDER),
    ).toBe(false)
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

  test('v3 descriptor is a hard reject on a v4 addon', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') return
    const desc = responsePlan()
    new DataView(desc.buffer).setUint32(4, 3, true) // force version 3
    expect(() => new addon.Route(desc)).toThrow()
  })

  test('non-OK verdict keeps the v3 result shape (no response frame)', () => {
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

describe('route-wire v4 response projection (bun:ffi)', () => {
  test('ffi result matches napi: status + headers + substituted body', () => {
    const ffi = getBunFFI()
    if (!isBun() || ffi === null) return
    const handle = ffi.routeCompile(
      responsePlan(200, [
        { name: 'content-type', value: 'application/json' },
        { name: 'x-request-id', value: RID },
      ]),
    )
    expect(handle).not.toBe(0)
    const frame = packRouteFrame('a=1', 's=v', null, RID)
    const out = new Uint8Array(512)
    const w = ffi.routeRun(handle, frame, out)
    expect(w).toBeGreaterThan(8)
    const resp = decodeRouteResponse(out.subarray(0, w))
    expect(resp.status).toBe(200)
    expect(resp.headers).toEqual([
      ['content-type', 'application/json'],
      ['x-request-id', RID],
    ])
    expect(new TextDecoder().decode(resp.body)).toBe(
      `{"ok":true,"requestId":"${RID}","path":"/api/users"}`,
    )
    // A too-small buffer reports the exact required size.
    const small = new Uint8Array(8)
    expect(ffi.routeRun(handle, frame, small)).toBe(w)
    ffi.routeDestroy(handle)
  })
})
