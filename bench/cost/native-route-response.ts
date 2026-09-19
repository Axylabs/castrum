// bench/cost/native-route-response.ts — route-wire v6 standalone response
// projection (native substitutions) + JS template assembly vs the JS-equivalent
// response work.
//
// Question: for the ignex `ApiOk` shape, is running the program natively
// (verdict + class + requestId substitution) and assembling the `Response` in
// JS against a compile-time template cheaper than `JSON.stringify` + `new
// Headers` + encoding the body?
//
// Numbers (ns/op, min-of-5):
//   1. native bare   — a no-stage route whose descriptor carries ONLY a response
//                      projection: isolates the native substitution path.
//   2. native full   — parseQuery+parseCookies + the response projection.
//   3. native assemble — decode substitutions + template assembly + Response.
//   4. JS equivalent — an object + JSON.stringify + new Headers + encode.
//
// Run: `bun bench/cost/native-route-response.ts` (Bun only — bun:ffi).

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
  ROUTE_STAGE,
  type RouteWireResponse,
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

const jsBody = JSON.stringify({
  ok: true,
  requestId: RID,
  path: '/api/users',
  query: {},
  cookies: {},
})
const template = encoder.encode(jsBody.replace(`"${RID}"`, '"{requestId}"'))
const expectedBody = encoder.encode(jsBody)

const projection: RouteWireResponse = {
  status: 200,
  headers: [{ name: 'content-type', value: CONTENT_TYPE }],
  body: template,
}
const compiled = compileResponseTemplate(projection)

const responsePart = encodeResponseProjection(projection)
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

// ── Parity check: assembled bytes must equal the JS-built bytes ──────
let fixedResult: ReturnType<typeof decodeRouteResult>
{
  const w = bunFFI.routeRun(bareHandle, frame, out)
  const flags = new DataView(out.buffer).getUint32(0, true)
  if ((flags & ROUTE_FLAG.HAS_RESPONSE) === 0) throw new Error('no HAS_RESPONSE flag')
  fixedResult = decodeRouteResult(out.subarray(0, w), { query: false, cookie: false })
  const assembled = assembleRouteResponse(compiled, fixedResult.slots)
  if (assembled.status !== 200) throw new Error(`status ${assembled.status}`)
  if (assembled.headers.get('content-type') !== CONTENT_TYPE) {
    throw new Error(`content-type mismatch: ${assembled.headers.get('content-type')}`)
  }
  if (encoder.encode(assembled.body).toString() !== expectedBody.toString()) {
    throw new Error('assembled body does not byte-match the JS body')
  }
}

// ── Native: run only (no stages) ─────────────────────────────────────
const tNativeBare = measure(() => {
  const w = bunFFI.routeRun(bareHandle, frame, out)
  return out.subarray(0, w)
}, ITER)

// ── Native: parseQuery+parseCookies verdict + substitution ───────────
const tNativeFull = measure(() => {
  const w = bunFFI.routeRun(fullHandle, frame, out)
  return out.subarray(0, w)
}, ITER)

// ── Decode substitutions only ────────────────────────────────────────
const tDecode = measure(() => {
  const w = bunFFI.routeRun(bareHandle, frame, out)
  return decodeRouteSubstitutions(out.subarray(0, w))
}, ITER)

// ── Assemble the Response against the template ───────────────────────
const tAssemble = measure(() => {
  const assembled = assembleRouteResponse(compiled, fixedResult.slots)
  return new Response(assembled.body, { status: assembled.status, headers: assembled.headers })
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
const verdict = (a: number, b: number): string =>
  a < b ? `CHEAPER by ${pct(b, a)}` : `NOT cheaper (${pct(a, b)} slower)`

console.log('═══ native response projection v6 vs JS assembly (ns/op, min-of-5) ═══')
console.log(`  native raw (no stages)                 : ${tNativeBare.toFixed(0).padStart(7)}`)
console.log(
  `  native full (parseQuery+cookies+resp)  : ${tNativeFull.toFixed(0).padStart(7)}`,
)
console.log(`  decode substitutions                   : ${tDecode.toFixed(0).padStart(7)}`)
console.log(`  assemble template + Response           : ${tAssemble.toFixed(0).padStart(7)}`)
console.log(`  JS: JSON.stringify + Headers + encode  : ${tJs.toFixed(0).padStart(7)}`)
console.log('  ────────────────────────────────────────────────────────────────')
console.log(`  native raw vs JS                       : ${verdict(tNativeBare, tJs)}`)
console.log(`  native full vs JS                      : ${verdict(tNativeFull, tJs)}`)
console.log(`  native decode+assemble vs JS           : ${verdict(tDecode + tAssemble, tJs)}`)
