// test/unit/ingress/native-route.test.ts — Per-route native stack
// (`castrum_route_*` / napi `Route`).
//
// The route stack compiles a descriptor (the `@ignex/native` route-wire v3
// contract: magic "ROUT", version 3, limits, stage tags, draft-07 body schema)
// ONCE and runs each request frame in ONE native call — lenient query/cookie
// parse + requireJsonBody/validateBody verdicts. This suite pins the wire
// round-trip and the lenient-parse parity vectors (mirroring ignex's
// `scripts/verify-native-route.ts`) against BOTH the napi `Route` class and
// the `bun:ffi` route surface, and the needed-size (growExact) convention.

import { describe, expect, test } from 'bun:test'
import { getAddon } from '../../../src/native'
import { getBunFFI } from '../../../src/native/ffi'
import { encoder } from '../../../src/shared/bytes'
import { isBun } from '../../../src/shared/runtime'

// ── Wire helpers (mirror @ignex/native route-wire.ts) ──────────────

const ROUTE_DESC_MAGIC = 0x524f5554
const ROUTE_DESC_VERSION = 3
const STAGE = {
  parseQuery: 0,
  parseCookies: 1,
  validateQuery: 2,
  validateCookies: 3,
  validateBody: 4,
  requireJsonBody: 5,
} as const
const PART = { body: 3 } as const
const FLAG = { OK: 1, BODY_VALID_JSON: 2, QUERY_VALID: 4, COOKIE_VALID: 8, BODY_VALID: 16 } as const

/** Encode a route plan into the descriptor wire. */
function encodeRouteDescriptor(
  pipeline: readonly number[],
  schemas: ReadonlyArray<{ part: number; bytes: Uint8Array }>,
  limits: { maxBodyBytes: number; maxQueryBytes: number; maxCookieBytes: number; maxPairs: number },
): Uint8Array {
  let total = 8 + 16 + 4 + pipeline.length + 4
  for (const s of schemas) total += 1 + 4 + s.bytes.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint32(pos, ROUTE_DESC_MAGIC, true)
  pos += 4
  view.setUint32(pos, ROUTE_DESC_VERSION, true)
  pos += 4
  for (const v of [
    limits.maxBodyBytes,
    limits.maxQueryBytes,
    limits.maxCookieBytes,
    limits.maxPairs,
  ]) {
    view.setUint32(pos, v, true)
    pos += 4
  }
  view.setUint32(pos, pipeline.length, true)
  pos += 4
  for (const stage of pipeline) {
    out[pos] = stage
    pos += 1
  }
  view.setUint32(pos, schemas.length, true)
  pos += 4
  for (const s of schemas) {
    out[pos] = s.part
    pos += 1
    view.setUint32(pos, s.bytes.byteLength, true)
    pos += 4
    out.set(s.bytes, pos)
    pos += s.bytes.byteLength
  }
  return out
}

/** Encode a request frame: `[flags u32][qLen][query][cLen][cookie]([bLen][body])`. */
function packRouteFrame(query: string, cookie: string, body: Uint8Array | null): Uint8Array {
  const q = encoder.encode(query)
  const c = encoder.encode(cookie)
  const hasBody = body !== null && body.byteLength > 0
  const total =
    4 + 4 + q.byteLength + 4 + c.byteLength + (hasBody ? 4 + (body?.byteLength ?? 0) : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint32(pos, hasBody ? 1 : 0, true)
  pos += 4
  view.setUint32(pos, q.byteLength, true)
  pos += 4
  out.set(q, pos)
  pos += q.byteLength
  view.setUint32(pos, c.byteLength, true)
  pos += 4
  out.set(c, pos)
  pos += c.byteLength
  if (hasBody && body) {
    view.setUint32(pos, body.byteLength, true)
    pos += 4
    out.set(body, pos)
  }
  return out
}

/** Decode the result wire: `[flags u32][errorCode u32]` + optional sections. */
function decodeRouteResult(
  buf: Uint8Array,
  opts: { query: boolean; cookie: boolean },
): {
  flags: number
  errorCode: number
  query: Array<[string, string]>
  cookie: Array<[string, string]>
} {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const flags = view.getUint32(0, true)
  const errorCode = view.getUint32(4, true)
  let pos = 8
  const readPairs = (): Array<[string, string]> => {
    const count = view.getUint32(pos, true)
    pos += 4
    const out: Array<[string, string]> = []
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint32(pos, true)
      pos += 4
      const name = decoder.decode(buf.subarray(pos, pos + nameLen))
      pos += nameLen
      const valueLen = view.getUint32(pos, true)
      pos += 4
      const value = decoder.decode(buf.subarray(pos, pos + valueLen))
      pos += valueLen
      out.push([name, value])
    }
    return out
  }
  return {
    flags,
    errorCode,
    query: opts.query ? readPairs() : [],
    cookie: opts.cookie ? readPairs() : [],
  }
}

const decoder = new TextDecoder()

// ── napi surface ───────────────────────────────────────────────────
const plan = (
  pipeline: readonly number[],
  schemas: ReadonlyArray<{ part: number; bytes: Uint8Array }> = [],
) =>
  encodeRouteDescriptor(pipeline, schemas, {
    maxBodyBytes: 2 * 1024 * 1024,
    maxQueryBytes: 8192,
    maxCookieBytes: 8192,
    maxPairs: 0,
  })

describe('native route stack', () => {
  test('napi Route: parseQuery+parseCookies round trip + lenient parity', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') {
      return // addon without the route stack (pre-rebuild) — skip
    }
    const route = new addon.Route(plan([STAGE.parseQuery, STAGE.parseCookies]))

    const out = new Uint8Array(512)
    // Lenient vectors (malformed %ZZ / invalid-UTF-8 %FF passthrough raw,
    // + → space, %2B → literal +, UTF-8 ✓).
    const cases: Array<{ query: string; expected: Array<[string, string]> }> = [
      {
        query: 'a=1&b=hello%20world&c=2',
        expected: [
          ['a', '1'],
          ['b', 'hello world'],
          ['c', '2'],
        ],
      },
      {
        query: 'm=%ZZ&n=abc%',
        expected: [
          ['m', '%ZZ'],
          ['n', 'abc%'],
        ],
      },
      { query: 'u=%E2%9C%93', expected: [['u', '\u2713']] },
      { query: 'p=a+b', expected: [['p', 'a b']] },
      { query: 'k=%2B', expected: [['k', '+']] },
      {
        query: 'k&k2=',
        expected: [
          ['k', ''],
          ['k2', ''],
        ],
      },
      { query: 'q=%FF', expected: [['q', '%FF']] },
    ]
    for (const c of cases) {
      const w = route.run(packRouteFrame(c.query, '', null), out)
      const r = decodeRouteResult(out.subarray(0, w), { query: true, cookie: true })
      expect(r.errorCode).toBe(0)
      expect(r.flags & FLAG.OK).toBe(FLAG.OK)
      expect(r.flags & FLAG.QUERY_VALID).toBe(FLAG.QUERY_VALID)
      expect(r.query).toEqual(c.expected)
    }

    // Cookie vectors (trim + DQUOTE-unwrap value, name keeps quotes, no decode).
    const cookie = 'a=1; "quoted"=val;  spaced = x '
    const w2 = route.run(packRouteFrame('', cookie, null), out)
    const r2 = decodeRouteResult(out.subarray(0, w2), { query: true, cookie: true })
    expect(r2.cookie).toEqual([
      ['a', '1'],
      ['"quoted"', 'val'],
      ['spaced', 'x'],
    ])
  })

  test('napi Route: requireJsonBody + validateBody verdicts', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') {
      return
    }
    const schema = encoder.encode(
      JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'number' } } }),
    )
    const route = new addon.Route(
      plan([STAGE.requireJsonBody, STAGE.validateBody], [{ part: PART.body, bytes: schema }]),
    )
    const out = new Uint8Array(512)
    const run = (body: Uint8Array | null) =>
      decodeRouteResult(out.subarray(0, route.run(packRouteFrame('', '', body), out)), {
        query: false,
        cookie: false,
      })

    // Valid body → ok + both flags.
    const ok = run(encoder.encode('{"x":1}'))
    expect(ok.errorCode).toBe(0)
    expect(ok.flags & FLAG.OK).toBe(FLAG.OK)
    expect(ok.flags & FLAG.BODY_VALID_JSON).toBe(FLAG.BODY_VALID_JSON)
    expect(ok.flags & FLAG.BODY_VALID).toBe(FLAG.BODY_VALID)

    // Non-JSON → 400, no valid flags.
    const badJson = run(encoder.encode('not json'))
    expect(badJson.errorCode).toBe(400)
    expect(badJson.flags & FLAG.OK).toBe(0)
    expect(badJson.flags & FLAG.BODY_VALID_JSON).toBe(0)

    // JSON but schema-invalid → 422 (json valid, body not).
    const schemaFail = run(encoder.encode('{"x":"str"}'))
    expect(schemaFail.errorCode).toBe(422)
    expect(schemaFail.flags & FLAG.OK).toBe(0)
    expect(schemaFail.flags & FLAG.BODY_VALID_JSON).toBe(FLAG.BODY_VALID_JSON)
    expect(schemaFail.flags & FLAG.BODY_VALID).toBe(0)

    // Absent body on requireJsonBody → 400.
    const noBody = run(null)
    expect(noBody.errorCode).toBe(400)
    expect(noBody.flags & FLAG.OK).toBe(0)
  })

  test('napi Route: needed-size (growExact) convention', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') {
      return
    }
    const route = new addon.Route(plan([STAGE.parseQuery]))
    const frame = packRouteFrame('a=1&bb=22&ccc=333', '', null)
    const small = new Uint8Array(8)
    const needed = route.run(frame, small)
    expect(needed).toBeGreaterThan(8)
    expect(small).toEqual(new Uint8Array(8)) // nothing written to a too-small buffer
    const exact = new Uint8Array(needed)
    const w = route.run(frame, exact)
    expect(w).toBe(needed)
  })

  test('napi Route: bad descriptor magic/version throws at construction', () => {
    const addon = getAddon()
    if (typeof addon.Route !== 'function') {
      return
    }
    const bad = plan([STAGE.parseQuery])
    bad[0] = 0
    expect(() => new addon.Route(bad)).toThrow()
    const badVersion = plan([STAGE.parseQuery])
    new DataView(badVersion.buffer).setUint32(4, 99, true)
    expect(() => new addon.Route(badVersion)).toThrow()
  })

  test('bun:ffi route surface matches the napi result wire', () => {
    const ffi = getBunFFI()
    if (!isBun() || ffi === null) {
      return // ffi unavailable — napi path covered above
    }
    const desc = plan([STAGE.parseQuery, STAGE.parseCookies])
    const handle = ffi.routeCompile(desc)
    expect(handle).not.toBe(0)
    const frame = packRouteFrame('a=1&b=hello%20world', 's=v', null)
    const out = new Uint8Array(256)
    const w = ffi.routeRun(handle, frame, out)
    expect(w).toBeGreaterThan(8)
    const r = decodeRouteResult(out.subarray(0, w), { query: true, cookie: true })
    expect(r.flags & FLAG.OK).toBe(FLAG.OK)
    expect(r.query).toEqual([
      ['a', '1'],
      ['b', 'hello world'],
    ])
    expect(r.cookie).toEqual([['s', 'v']])
    // Needed-size through ffi: a too-small buffer returns the exact size (not 0).
    const small = new Uint8Array(8)
    const needed = ffi.routeRun(handle, frame, small)
    expect(needed).toBe(w)
    ffi.routeDestroy(handle)
  })
})
