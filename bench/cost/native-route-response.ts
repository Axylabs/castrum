// bench/cost/native-route-response.ts — route-wire v4 native response
// projection vs the JS-equivalent response assembly (the decisive Phase-1
// spike).
//
// Question: for the ignex `ApiOk` shape, is building the 2xx response natively
// (status + static headers + pre-encoded body + requestId substitution) cheaper
// than the JS work it replaces — `JSON.stringify` + `new Headers` + encoding the
// body to bytes?
//
// Three numbers (ns/op, min-of-5):
//   1. native bare   — a no-stage route whose descriptor carries ONLY a response
//                      projection: isolates native assembly.
//   2. native full   — parseQuery+parseCookies + the response projection: the
//                      end-to-end native path (verdict + assembly).
//   3. JS equivalent — an object + JSON.stringify + new Headers + encode.
//
// Run: `bun bench/cost/native-route-response.ts` (Bun only — bun:ffi).
// If a stale v3 `.node` is present, point the loader at the fresh baseline:
//   CASTRUM_NATIVE_LIBRARY_PATH=$PWD/castrum.linux-x64-gnu.node \
//     bun bench/cost/native-route-response.ts

import {
  decodeRouteResponse,
  encodeResponseProjection,
  encodeRouteDescriptor,
  packRouteFrame,
  ROUTE_FLAG,
  ROUTE_PART,
  ROUTE_STAGE,
} from '../../src/ingress/packing/route-wire'
import { getBunFFI } from '../../src/native/ffi'
import { encoder } from '../../src/shared/bytes'
import { measureNs as measure } from '../measure'

const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

// The request id is generated per request in a real server; a fixed value keeps
// the loop honest (both sides do the same substitution/stringify work).
const RID = '0193f2c4-0000-7000-8000-000000000000'
const CONTENT_TYPE = 'application/json; charset=utf-8'
const ITER = 100_000

// The exact JSON the JS path would produce for the constant ApiOk, with the
// requestId value swapped for the native placeholder. Byte-parity is asserted
// below, so the benchmark compares identical output.
const jsBody = JSON.stringify({
  ok: true,
  requestId: RID,
  path: '/api/users',
  query: {},
  cookies: {},
})
const template = encoder.encode(jsBody.replace(`"${RID}"`, '"{requestId}"'))
const expectedBody = encoder.encode(jsBody)

const responsePart = encodeResponseProjection({
  status: 200,
  headers: [{ name: 'content-type', value: CONTENT_TYPE }],
  body: template,
})
const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
}

const bareDesc = encodeRouteDescriptor(
  [],
  [{ part: ROUTE_PART.response, bytes: responsePart }],
  limits,
)
const fullDesc = encodeRouteDescriptor(
  [ROUTE_STAGE.parseQuery, ROUTE_STAGE.parseCookies],
  [{ part: ROUTE_PART.response, bytes: responsePart }],
  limits,
)

const bareHandle = bunFFI.routeCompile(bareDesc)
const fullHandle = bunFFI.routeCompile(fullDesc)
if (bareHandle === 0 || fullHandle === 0) throw new Error('routeCompile failed')

const out = new Uint8Array(512)
const frame = packRouteFrame('page=1&limit=20', 'session=abc', null, RID)

// ── Parity check: native bytes must equal the JS-built bytes ─────────
{
  const w = bunFFI.routeRun(bareHandle, frame, out)
  const flags = new DataView(out.buffer).getUint32(0, true)
  if ((flags & ROUTE_FLAG.HAS_RESPONSE) === 0) throw new Error('no HAS_RESPONSE flag')
  const resp = decodeRouteResponse(out.subarray(0, w))
  if (resp.status !== 200) throw new Error(`status ${resp.status}`)
  if (resp.headers[0]?.[0] !== 'content-type' || resp.headers[0]?.[1] !== CONTENT_TYPE) {
    throw new Error(`headers mismatch: ${JSON.stringify(resp.headers)}`)
  }
  if (encoder.encode(resp.body).toString() !== expectedBody.toString()) {
    throw new Error('native body does not byte-match the JS body')
  }
}

// ── Native: assemble only (no stages) ────────────────────────────────
const tNativeBare = measure(() => {
  const w = bunFFI.routeRun(bareHandle, frame, out)
  return out.subarray(0, w)
}, ITER)

// ── Native: parseQuery+parseCookies verdict + assembly ───────────────
const tNativeFull = measure(() => {
  const w = bunFFI.routeRun(fullHandle, frame, out)
  return out.subarray(0, w)
}, ITER)

// ── JS equivalent: object → JSON.stringify → Headers → bytes ─────────
const tJs = measure(() => {
  const body = JSON.stringify({
    ok: true,
    requestId: RID,
    path: '/api/users',
    query: {},
    cookies: {},
  })
  const headers = new Headers({ 'content-type': CONTENT_TYPE })
  void headers
  return encoder.encode(body)
}, ITER)

bunFFI.routeDestroy(bareHandle)
bunFFI.routeDestroy(fullHandle)

const pct = (a: number, b: number): string => `${(((a - b) / a) * 100).toFixed(0)}%`

console.log('═══ native response projection vs JS assembly (ns/op, min-of-5) ═══')
console.log(`  native assembly (no stages)            : ${tNativeBare.toFixed(0).padStart(7)}`)
console.log(
  `  native full (parseQuery+cookies+resp)  : ${tNativeFull.toFixed(0).padStart(7)}`,
)
console.log(`  JS: JSON.stringify + Headers + encode  : ${tJs.toFixed(0).padStart(7)}`)
console.log('  ────────────────────────────────────────────────────────────────')
console.log(
  `  native assembly vs JS                  : ${tNativeBare < tJs ? 'CHEAPER' : 'NOT cheaper'} by ${pct(Math.max(tNativeBare, tJs), Math.min(tNativeBare, tJs))}`,
)
console.log(
  `  native full vs JS                      : ${tNativeFull < tJs ? 'CHEAPER' : 'NOT cheaper'} by ${pct(Math.max(tNativeFull, tJs), Math.min(tNativeFull, tJs))}`,
)
