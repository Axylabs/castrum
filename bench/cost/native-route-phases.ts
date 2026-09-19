// bench/cost/native-route-phases.ts — phase decomposition of the PUBLIC
// native-route lane (route-wire v6 substitution + JS-assembled template).
//
// v5 returned a fully framed HTTP response that JS decoded back into strings
// (pack 948ns + FFI 294ns + decode 655ns + Response(pairs) 852ns). v6 instead
// returns only the selected class tag + dynamic substitution slots; JS
// assembles against a compile-time template (memoized `Headers`, pre-encoded
// body segments). This bench attributes the v6 public lane to named phases so
// the remaining cost is visible:
//
//   compile*  — buildProgramPlan / encodeProgram / encodeRouteDescriptor /
//               createNativeRoute + template compile (ONCE per route)
//   pack*     — the per-request JS frame build
//   ffi       — castrum_route_run into a reusable output buffer
//   slice     — out.subarray(0, written)
//   decode*   — decodeRouteResult / decodeRouteSubstitutions (no per-field
//               string decode; substitution bytes stay zero-copy)
//   assemble  — assembleRouteResponse (static Headers reuse / body splice)
//   response  — new Response(body, { headers })
//
// Run: `bun bench/cost/native-route-phases.ts` (Bun only — bun:ffi).

import { METHOD_KIND, ROUTE_CLASS } from '../../src/ingress'
import { createNativeRoute } from '../../src/ingress/native-route'
import { buildProgramPlan } from '../../src/ingress/pre-effects'
import {
  assembleRouteResponse,
  compileResponseTemplates,
  decodeRouteResult,
  decodeRouteSubstitutions,
  encodeProgram,
  encodeRouteDescriptor,
  packRawHeadersPacked,
  packRouteFrame,
} from '../../src/ingress/packing/route-wire'
import { getBunFFI } from '../../src/native/ffi'
import { encoder } from '../../src/shared/bytes'
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
const LIMITS = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
}

const ffi = getBunFFI()
if (ffi === null) throw new Error('bun:ffi not active')

// ── Compile ONCE (measured absolute; amortized in the report) ────────
const tCompilePlan = measure(() => buildProgramPlan(PROGRAM_OPTIONS, OK_RESPONSE), 2_000)
const built = buildProgramPlan(PROGRAM_OPTIONS, OK_RESPONSE)
const tCompileTemplates = measure(() => compileResponseTemplates(built.classes), 5_000)
const tEncodeProgram = measure(() => encodeProgram(built.consts, built.ops), 20_000)
const programBytes = encodeProgram(built.consts, built.ops)
const tEncodeDescriptor = measure(
  () => encodeRouteDescriptor([], [], LIMITS, programBytes),
  20_000,
)
const tCreateRoute = measure(
  () => createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS }),
  2_000,
)

const route = createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS })
const templates = compileResponseTemplates(built.classes)
const tmplWithOrigin = templates.get(ROUTE_CLASS.okWithOrigin)
const tmplNoOrigin = templates.get(ROUTE_CLASS.okNoOrigin)
if (tmplWithOrigin === undefined || tmplNoOrigin === undefined) {
  throw new Error('response templates not compiled')
}
const descriptor = encodeRouteDescriptor([], [], LIMITS, programBytes)
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

// Pre-pack one frame for the decode/ffi/assemble phases (fixed input).
const fixedFrame = packRouteFrame(QUERIES[0] ?? '', 'session=abc', null, RID, pre)
const fixedWritten = ffi.routeRun(handle, fixedFrame, out)
const fixedSlice = out.subarray(0, fixedWritten)
const fixedResult = decodeRouteResult(fixedSlice, { query: false, cookie: false })

// ── Phase measurements ──────────────────────────────────────────────

// Frame packing, whole + sub-parts.
const tPackFrame = measure(
  () => packRouteFrame(nextQuery(), 'session=abc', null, RID, pre),
  ITER,
)
const tPackQuery = measure(() => encoder.encode(nextQuery()), ITER)
const tPackHeaders = measure(() => packRawHeadersPacked(HEADERS), ITER)
const cachedOriginBlock = packRawHeadersPacked(HEADERS)
const tPackHeadersCached = measure(() => cachedOriginBlock, ITER)
const preCached = { methodKind: METHOD_KIND.GET, ip: IP, packedHeaders: cachedOriginBlock }
const tPackFrameCached = measure(
  () => packRouteFrame(nextQuery(), 'session=abc', null, RID, preCached),
  ITER,
)
const ridBytes = generateRequestId()
const tRidRoundTrip = measure(() => encoder.encode(new TextDecoder().decode(generateRequestId())), ITER)

// FFI + slice.
const tFfi = measure(() => ffi.routeRun(handle, fixedFrame, out), ITER)
const tSlice = measure(() => out.subarray(0, fixedWritten), ITER)

// Decode: v6 reads the verdict + class tag + substitution slots only.
const tDecodeResult = measure(
  () => decodeRouteResult(out.subarray(0, fixedWritten), { query: false, cookie: false }),
  ITER,
)
const tDecodeSubs = measure(() => decodeRouteSubstitutions(fixedSlice), ITER)

// Assemble + Response: the with-origin class has one dynamic header
// (access-control-allow-origin); the no-origin class is all-static.
const tAssembleDynamic = measure(
  () => assembleRouteResponse(tmplWithOrigin, fixedResult.slots),
  ITER,
)
const tAssembleStatic = measure(() => assembleRouteResponse(tmplNoOrigin, fixedResult.slots), ITER)
const tResponseDynamic = measure(() => {
  const a = assembleRouteResponse(tmplWithOrigin, fixedResult.slots)
  return new Response(a.body, { status: a.status, headers: a.headers })
}, ITER)
const tResponseStatic = measure(() => {
  const a = assembleRouteResponse(tmplNoOrigin, fixedResult.slots)
  return new Response(a.body, { status: a.status, headers: a.headers })
}, ITER)

// ── Whole-lane variants ─────────────────────────────────────────────
const laneFrame = packRouteFrame(QUERIES[0] ?? '', 'session=abc', null, RID, pre)
const tLaneRunFrame = measure(() => route.runFrame(laneFrame), ITER)
const tLaneRunFrameServe = measure(() => {
  const r = route.runFrame(laneFrame)
  const resp = route.assembleResponse(r)
  if (resp === null) throw new Error('no response')
  return resp
}, ITER)
// Whole lane including a per-request frame pack (varied query).
const tLaneRun = measure(() => {
  const r = route.run(nextQuery(), 'session=abc', null, pre, ridBytes)
  return route.assembleResponse(r)
}, ITER)

// ── JS baselines (the equivalents the native lane claims to replace) ──
function jsHeaders(origin: string): Headers {
  const headers = new Headers()
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('content-type', 'application/json')
  headers.set('vary', 'Origin')
  headers.set('access-control-allow-origin', origin)
  return headers
}
const jsBody = `{"ok":true,"requestId":"${RID}"}`
const tJsHeaders = measure(() => jsHeaders(ORIGIN), ITER)
const tJsResponseHeaders = measure(
  () => new Response(encoder.encode(jsBody), { status: 200, headers: jsHeaders(ORIGIN) }),
  ITER,
)

ffi.routeDestroy(handle)

const pad = (n: number): string => n.toFixed(0).padStart(7)
const perReq = (once: number, reqs = 1_000_000): string => (once / reqs).toFixed(3)

// v5 reference numbers from /tmp/opencode/castrum-native-bottleneck-report.md
// (ns/op, same host class) — used to show the v5→v6 movement.
const V5 = {
  packFrame: 948,
  ffi: 294,
  slice: 35,
  decodeRouteResult: 760,
  responsePairs: 852,
  laneRunFrame: 1166,
  laneRunFrameResponse: 2324,
}

console.log('═══ native-route PUBLIC lane v6 — phase decomposition (ns/op, min-of-5) ═══')
console.log(`  input: query varies per op (${ITER.toLocaleString()} ops, 1 header frame)`)
console.log('')
console.log('  ── compile (ONCE per route) ──────────────────────────────────')
console.log(`  buildProgramPlan                        : ${pad(tCompilePlan)}`)
console.log(`  compileResponseTemplates                : ${pad(tCompileTemplates)}`)
console.log(`  encodeProgram                           : ${pad(tEncodeProgram)}`)
console.log(`  encodeRouteDescriptor                   : ${pad(tEncodeDescriptor)}`)
console.log(`  createNativeRoute (all of the above+FFI): ${pad(tCreateRoute)}`)
console.log(`  amortized @1e6 requests                 : ${perReq(tCreateRoute)} ns/req`)
console.log('')
console.log('  ── per-request phases ────────────────────────────────────────')
console.log(`  pack frame (whole)                      : ${pad(tPackFrame)}   (v5 ${V5.packFrame})`)
console.log(`  pack frame (memoized origin block)      : ${pad(tPackFrameCached)}`)
console.log(`    encoder.encode(query)                 : ${pad(tPackQuery)}`)
console.log(`    packRawHeadersPacked(origin)          : ${pad(tPackHeaders)}`)
console.log(`    packRawHeadersPacked cached block     : ${pad(tPackHeadersCached)}`)
console.log(`  request-id bytes (generateRequestId)    : pass-through (no decode/re-encode)`)
console.log(`  request-id round trip (v5 cost)         : ${pad(tRidRoundTrip)}`)
console.log(`  FFI castrum_route_run                   : ${pad(tFfi)}   (v5 ${V5.ffi})`)
console.log(`  out.subarray(0, written)                : ${pad(tSlice)}   (v5 ${V5.slice})`)
console.log('')
console.log('  ── result decode (v6: substitutions only) ────────────────────')
console.log(`  decodeRouteResult (incl. subarray)      : ${pad(tDecodeResult)}   (v5 ${V5.decodeRouteResult})`)
console.log(`  decodeRouteSubstitutions (pre-sliced)   : ${pad(tDecodeSubs)}`)
console.log('')
console.log('  ── template assembly + Response ──────────────────────────────')
console.log(`  assembleRouteResponse (dynamic origin)  : ${pad(tAssembleDynamic)}`)
console.log(`  assembleRouteResponse (static only)     : ${pad(tAssembleStatic)}`)
console.log(`  assemble + Response (dynamic)           : ${pad(tResponseDynamic)}`)
console.log(`  assemble + Response (static)            : ${pad(tResponseStatic)}`)
console.log(`  v5: new Response(body, {headers: pairs}): ${pad(V5.responsePairs)}`)
console.log('')
console.log('  ── whole-lane variants ───────────────────────────────────────')
console.log(`  raw FFI only                            : ${pad(tFfi)}`)
console.log(`  route.runFrame(frame)  [public]         : ${pad(tLaneRunFrame)}   (v5 ${V5.laneRunFrame})`)
console.log(`  runFrame + assembleResponse (server)    : ${pad(tLaneRunFrameServe)}   (v5 ${V5.laneRunFrameResponse})`)
console.log(`  run(query...) frame pack + lane + serve : ${pad(tLaneRun)}`)
console.log('')
console.log('  ── JS equivalents ────────────────────────────────────────────')
console.log(`  JS decisions + Headers writes           : ${pad(tJsHeaders)}`)
console.log(`  JS Headers -> Response                  : ${pad(tJsResponseHeaders)}`)
console.log('')
console.log(
  `  attribution: v6 lane = FFI ${tFfi.toFixed(0)} + slice ${tSlice.toFixed(0)} + ` +
    `decode ${tDecodeResult.toFixed(0)} + assemble+Response ${tResponseDynamic.toFixed(0)} ` +
    `≈ ${(tFfi + tSlice + tDecodeResult + tResponseDynamic).toFixed(0)}ns`,
)
