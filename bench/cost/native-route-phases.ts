// bench/cost/native-route-phases.ts — phase decomposition of the PUBLIC
// native-route lane (route-wire v5 op program).
//
// The existing `native-route-program.ts` reports only two numbers for the
// public lane: the raw FFI call (~285ns) and `route.runFrame()` (~1512ns). The
// ~1.2µs gap is "result decode" but not WHERE inside it. This bench attributes
// the public lane to named phases so a fix targets the real cost:
//
//   compile       — buildProgramPlan + encodeProgram + encodeRouteDescriptor +
//                   createNativeRoute (ONCE per route → amortized)
//   pack*         — the per-request JS frame build (query/cookie/rid/ip encode,
//                   packed headers, frame assembly)
//   ffi           — castrum_route_run into a reusable output buffer
//   slice         — out.subarray(0, written)
//   decode*       — decodeRouteResult / decodeRouteResponse (DataViews,
//                   per-field TextDecoder/CString decode, tuple arrays)
//   headers       — new Headers() + set() per decoded pair
//   response      — new Response(body, init) (array-of-pairs vs Headers)
//
// Run: `bun bench/cost/native-route-phases.ts` (Bun only — bun:ffi).

import { METHOD_KIND } from '../../src/ingress'
import { createNativeRoute } from '../../src/ingress/native-route'
import { buildProgramPlan } from '../../src/ingress/pre-effects'
import {
  decodeRouteResponse,
  decodeRouteResult,
  encodeProgram,
  encodeRouteDescriptor,
  packRawHeadersPacked,
  packRouteFrame,
} from '../../src/ingress/packing/route-wire'
import { getBunFFI } from '../../src/native/ffi'
import { encoder, decoder, viewForArrayBuffer } from '../../src/shared/bytes'
import { decodeUtf8RangeView } from '../../src/shared/codec'
import { generateRequestId } from '../../src/shared/request-id'
import { measureNs as measure } from '../measure'

const RID = '0193f2c4-0000-7000-8000-000000000000'
const ORIGIN = 'https://app.example.com'
const IP = '203.0.113.5'
const ITER = 100_000

const OK_RESPONSE = {
  status: 200,
  headers: [{ name: 'content-type', value: 'application/json' }],
  body: encoder.encode(`{"ok":true,"requestId":"{requestId}"}`),
}
const PROGRAM_OPTIONS = {
  parseQuery: true,
  cors: { allowOrigin: ['*'] },
  security: {},
  requestIdHeader: false,
}
const LIMITS = { maxBodyBytes: 2 * 1024 * 1024, maxQueryBytes: 8192, maxCookieBytes: 8192, maxPairs: 0 }

const ffi = getBunFFI()
if (ffi === null) throw new Error('bun:ffi not active')

// ── Compile ONCE (measured absolute; amortized in the report) ────────
const tCompilePlan = measure(() => buildProgramPlan(PROGRAM_OPTIONS, OK_RESPONSE), 2_000)

const built = buildProgramPlan(PROGRAM_OPTIONS, OK_RESPONSE)
const tEncodeProgram = measure(() => encodeProgram(built.consts, built.ops), 20_000)
const programBytes = encodeProgram(built.consts, built.ops)
const tEncodeDescriptor = measure(
  () => encodeRouteDescriptor([], [], LIMITS, programBytes),
  20_000,
)
const descriptor = encodeRouteDescriptor([], [], LIMITS, programBytes)
const tCreateRoute = measure(
  () => createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS }),
  2_000,
)

const route = createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS })
const handle = ffi.routeCompile(descriptor)
if (handle === 0) throw new Error('routeCompile failed')

const out = new Uint8Array(4096)

// Varied input per the measurement rules: a ring of distinct query strings so
// the query encode is never measuring a constant-folded value.
const QUERIES: string[] = []
for (let i = 0; i < 256; i++) QUERIES.push(`q=term${i}&page=${i & 0x3f}&filter=active`)
let qi = 0
const nextQuery = (): string => {
  const q = QUERIES[qi & 0xff] ?? ''
  qi++
  return q
}

const HEADERS: Array<[string, string]> = [['origin', ORIGIN]]
const pre = { methodKind: METHOD_KIND.GET, ip: IP, headers: HEADERS }

// Pre-pack one frame for the decode/ffi phases (fixed input, isolated phase).
const fixedFrame = packRouteFrame(QUERIES[0] ?? '', 'session=abc', null, RID, pre)
const fixedWritten = ffi.routeRun(handle, fixedFrame, out)
const fixedSlice = out.subarray(0, fixedWritten)

// ── Phase measurements ──────────────────────────────────────────────

// Frame packing, whole + sub-parts.
const tPackFrame = measure(
  () => packRouteFrame(nextQuery(), 'session=abc', null, RID, pre),
  ITER,
)
const tPackQuery = measure(() => encoder.encode(nextQuery()), ITER)
const tPackHeaders = measure(() => packRawHeadersPacked(HEADERS), ITER)
const tPackHeadersCached = (() => {
  const cached = packRawHeadersPacked(HEADERS)
  return measure(() => cached, ITER)
})()

// Request-id string round-trip the real handler pays: generateRequestId() gives
// bytes; the responder decodes to a string; packRouteFrame re-encodes it.
const tRidDecode = measure(() => decoder.decode(generateRequestId()), ITER)
const tRidEncode = measure(() => encoder.encode(RID), ITER)
const tRidRoundTrip = measure(() => encoder.encode(decoder.decode(generateRequestId())), ITER)

// FFI + slice.
const tFfi = measure(() => ffi.routeRun(handle, fixedFrame, out), ITER)
const tSlice = measure(() => out.subarray(0, fixedWritten), ITER)

// Decode: the public path (decodeRouteResult includes the runFrame subarray).
const tDecodeResult = measure(
  () => decodeRouteResult(out.subarray(0, fixedWritten), { query: true, cookie: false }),
  ITER,
)
const tDecodeResponse = measure(() => decodeRouteResponse(fixedSlice), ITER)
const tDecodeResultOnSlice = measure(
  () => decodeRouteResult(fixedSlice, { query: true, cookie: false }),
  ITER,
)

// A minimal decoder: verdict + status + header count + body slice, ZERO
// per-field string decode (what a caller that only needs body+status would pay).
const tDecodeNoStrings = measure(() => {
  const view = viewForArrayBuffer(fixedSlice.buffer, fixedSlice.byteOffset)
  const status = view.getUint16(8, true)
  const count = view.getUint32(10, true)
  let pos = 14
  for (let i = 0; i < count; i++) {
    const nl = view.getUint32(pos, true)
    pos += 4 + nl
    const vl = view.getUint32(pos, true)
    pos += 4 + vl
  }
  const bodyLen = view.getUint32(pos, true)
  pos += 4
  return { status, body: fixedSlice.subarray(pos, pos + bodyLen) }
}, ITER)

// Candidate fast decoder: cached DataView + one cached Buffer + ranged decode
// (the ingress decoder's approach) instead of per-field `decoder.decode`.
const cachedBuf = Buffer.from(fixedSlice.buffer, fixedSlice.byteOffset, fixedSlice.byteLength)
const tDecodeFast = measure(() => {
  const view = viewForArrayBuffer(fixedSlice.buffer, fixedSlice.byteOffset)
  let pos = 8
  const status = view.getUint16(pos, true)
  pos += 2
  const count = view.getUint32(pos, true)
  pos += 4
  const headers: Array<[string, string]> = []
  for (let i = 0; i < count; i++) {
    const nl = view.getUint32(pos, true)
    pos += 4
    const name = decodeUtf8RangeView(cachedBuf, pos, pos + nl)
    pos += nl
    const vl = view.getUint32(pos, true)
    pos += 4
    const value = decodeUtf8RangeView(cachedBuf, pos, pos + vl)
    pos += vl
    headers.push([name, value])
  }
  const bodyLen = view.getUint32(pos, true)
  pos += 4
  return { status, headers, body: fixedSlice.subarray(pos, pos + bodyLen) }
}, ITER)

// Candidate 2: ranged decode of VALUES only. The header NAMES come from the
// compiled class template (compile-time static) — decoding them per request is
// pure waste for a caller that owns the template.
const tDecodeValuesOnly = measure(() => {
  const view = viewForArrayBuffer(fixedSlice.buffer, fixedSlice.byteOffset)
  let pos = 8
  const status = view.getUint16(pos, true)
  pos += 2
  const count = view.getUint32(pos, true)
  pos += 4
  const values: string[] = []
  for (let i = 0; i < count; i++) {
    const nl = view.getUint32(pos, true)
    pos += 4 + nl
    const vl = view.getUint32(pos, true)
    pos += 4
    values.push(decodeUtf8RangeView(cachedBuf, pos, pos + vl))
    pos += vl
  }
  const bodyLen = view.getUint32(pos, true)
  pos += 4
  return { status, values, body: fixedSlice.subarray(pos, pos + bodyLen) }
}, ITER)

// ── Response construction variants ──────────────────────────────────
const decoded = decodeRouteResponse(fixedSlice)
const pairHeaders = decoded.headers
const memoHeaders = new Headers()
for (const [n, v] of pairHeaders) memoHeaders.set(n, v)
const bodyBytes = decoded.body
const bodyCopy = bodyBytes.slice()

const tHeadersBuild = measure(() => {
  const h = new Headers()
  for (const [n, v] of pairHeaders) h.set(n, v)
  return h
}, ITER)
const tResponsePairsNoCopy = measure(
  () => new Response(bodyBytes, { status: decoded.status, headers: pairHeaders }),
  ITER,
)
const tResponsePairsCopy = measure(
  () => new Response(bodyCopy, { status: decoded.status, headers: pairHeaders }),
  ITER,
)
const tResponseMemoHeaders = measure(
  () => new Response(bodyBytes, { status: decoded.status, headers: memoHeaders }),
  ITER,
)

// ── Whole-lane variants ─────────────────────────────────────────────
const laneFrame = packRouteFrame(QUERIES[0] ?? '', 'session=abc', null, RID, pre)
const tLaneRunFrame = measure(() => route.runFrame(laneFrame), ITER)
const tLaneRunFrameResponse = measure(() => {
  const r = route.runFrame(laneFrame)
  const resp = r.response
  if (resp === undefined) throw new Error('no response')
  return new Response(resp.body.slice(), {
    status: resp.status,
    headers: resp.headers,
  })
}, ITER)
// Whole lane including a per-request frame pack (varied query).
const tLaneRun = measure(

  () => route.run(nextQuery(), 'session=abc', null, pre, RID),
  ITER,
)

// ── JS baselines (the equivalents the native lane claims to replace) ──
function jsArray(): Array<[string, string]> {
  const headers: Array<[string, string]> = []
  headers.push(['x-content-type-options', 'nosniff'])
  headers.push(['x-frame-options', 'DENY'])
  headers.push(['referrer-policy', 'no-referrer'])
  headers.push(['content-type', 'application/json'])
  headers.push(['vary', 'Origin'])
  headers.push(['access-control-allow-origin', ORIGIN])
  return headers
}
function jsHeaders(): Headers {
  const headers = new Headers()
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('content-type', 'application/json')
  headers.set('vary', 'Origin')
  headers.set('access-control-allow-origin', ORIGIN)
  return headers
}
const jsBody = `{"ok":true,"requestId":"${RID}"}`
const tJsArray = measure(() => jsArray(), ITER)
const tJsHeaders = measure(() => jsHeaders(), ITER)
const tJsResponseArray = measure(
  () => new Response(encoder.encode(jsBody), { status: 200, headers: jsArray() }),
  ITER,
)
const tJsResponseHeaders = measure(
  () => new Response(encoder.encode(jsBody), { status: 200, headers: jsHeaders() }),
  ITER,
)

ffi.routeDestroy(handle)

const pad = (n: number): string => n.toFixed(0).padStart(7)
const perReq = (once: number, reqs = 1_000_000): string => (once / reqs).toFixed(3)

console.log('═══ native-route PUBLIC lane — phase decomposition (ns/op, min-of-5) ═══')
console.log(`  input: query varies per op (${ITER.toLocaleString()} ops, 6 header frame)`)
console.log('')
console.log('  ── compile (ONCE per route) ──────────────────────────────────')
console.log(`  buildProgramPlan                        : ${pad(tCompilePlan)}`)
console.log(`  encodeProgram                           : ${pad(tEncodeProgram)}`)
console.log(`  encodeRouteDescriptor                   : ${pad(tEncodeDescriptor)}`)
console.log(`  createNativeRoute (all of the above+FFI): ${pad(tCreateRoute)}`)
console.log(`  amortized @1e6 requests                 : ${perReq(tCreateRoute)} ns/req`)
console.log('')
console.log('  ── per-request phases ────────────────────────────────────────')
console.log(`  pack frame (whole)                      : ${pad(tPackFrame)}`)
console.log(`    encoder.encode(query)                 : ${pad(tPackQuery)}`)
console.log(`    packRawHeadersPacked(origin)          : ${pad(tPackHeaders)}`)
console.log(`    packRawHeadersPacked cached block     : ${pad(tPackHeadersCached)}`)
console.log(`  request-id decode(generateRequestId)    : ${pad(tRidDecode)}`)
console.log(`  request-id encode(RID)                  : ${pad(tRidEncode)}`)
console.log(`  request-id round trip (decode+encode)   : ${pad(tRidRoundTrip)}`)
console.log(`  FFI castrum_route_run                   : ${pad(tFfi)}`)
console.log(`  out.subarray(0, written)                : ${pad(tSlice)}`)
console.log('')
console.log('  ── result decode ─────────────────────────────────────────────')
console.log(`  decodeRouteResult (incl. subarray)      : ${pad(tDecodeResult)}`)
console.log(`  decodeRouteResult (pre-sliced)          : ${pad(tDecodeResultOnSlice)}`)
console.log(`  decodeRouteResponse (pre-sliced)        : ${pad(tDecodeResponse)}`)
console.log(`  minimal read (no per-field strings)     : ${pad(tDecodeNoStrings)}`)
console.log(`  candidate: cached view + ranged decode  : ${pad(tDecodeFast)}`)
console.log(`  candidate: ranged decode, VALUES only   : ${pad(tDecodeValuesOnly)}`)
console.log('')
console.log('  ── response construction ─────────────────────────────────────')
console.log(`  new Headers + set(6 pairs)              : ${pad(tHeadersBuild)}`)
console.log(`  new Response(body, {headers: pairs})    : ${pad(tResponsePairsNoCopy)}`)
console.log(`  new Response(body.slice(), pairs)       : ${pad(tResponsePairsCopy)}`)
console.log(`  new Response(body, {memo Headers})      : ${pad(tResponseMemoHeaders)}`)
console.log('')
console.log('  ── whole-lane variants ───────────────────────────────────────')
console.log(`  raw FFI only                            : ${pad(tFfi)}`)
console.log(`  route.runFrame(frame)  [public]         : ${pad(tLaneRunFrame)}`)
console.log(`  route.runFrame + Response (server work) : ${pad(tLaneRunFrameResponse)}`)
console.log(`  route.run(query...) frame pack + lane   : ${pad(tLaneRun)}`)
console.log('')
console.log('  ── JS equivalents ────────────────────────────────────────────')
console.log(`  JS decisions + pair array               : ${pad(tJsArray)}`)
console.log(`  JS decisions + Headers writes           : ${pad(tJsHeaders)}`)
console.log(`  JS array -> Response                    : ${pad(tJsResponseArray)}`)
console.log(`  JS Headers -> Response                  : ${pad(tJsResponseHeaders)}`)
console.log('')
console.log(
  `  attribution: decode = ${(tDecodeResult - tFfi - tSlice).toFixed(0)}ns  ` +
    `(public lane ${tLaneRunFrame.toFixed(0)} = FFI ${tFfi.toFixed(0)} + slice ${tSlice.toFixed(0)} + decode ${(tDecodeResult - tDecodeResultOnSlice).toFixed(0)} + decodeResponse ${tDecodeResponse.toFixed(0)})`,
)
