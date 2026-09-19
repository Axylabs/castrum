// bench/cost/native-route-program.ts — route-wire v6 zero-callout OP PROGRAM vs
// the JS-equivalent framework work (the decisive native-lane spike).
//
// Headline (task shape): a declarative GET route lowered to a zero-callout
// program of parse_query → CORS → security headers (baked) →
// response_projection, run in ONE `castrum_route_run`. The run returns the
// verdict + selected class + substitution slots; JS assembles the `Response`
// against the compile-time template. The JS baselines do the same decisions and
// assemble the same wire bytes:
//   1. `jsArray`   — decisions + `[name, value][]` (castrum's pre-baked path;
//                    the LEANEST possible JS).
//   2. `jsHeaders` — decisions + `new Headers()` + `.set(...)` per header (the
//                    plugin path: cors/security plugins write into Headers).
// A secondary block adds `rate_limit` to the program and to the JS baselines to
// show the stateful-op cost separately.
//
// Run: `bun bench/cost/native-route-program.ts` (Bun only — bun:ffi).

import { METHOD_KIND } from '../../src/ingress'
import { createNativeRoute } from '../../src/ingress/native-route'
import { buildProgramPlan } from '../../src/ingress/pre-effects'
import {
  decodeRouteResult,
  encodeProgram,
  encodeRouteDescriptor,
  packRouteFrame,
} from '../../src/ingress/packing/route-wire'
import { getBunFFI } from '../../src/native/ffi'
import { encoder } from '../../src/shared/bytes'
import { measureNs as measure } from '../measure'

const RID = '0193f2c4-0000-7000-8000-000000000000'
const ORIGIN = 'https://app.example.com'
const IP = '203.0.113.5'
const ITER = 100_000
const LIMIT = 1_000_000_000 // huge: the rate variant never exhausts the budget
const WINDOW_MS = 60_000

const OK_RESPONSE = {
  status: 200,
  headers: [{ name: 'content-type', value: 'application/json' }],
  body: encoder.encode(`{"ok":true,"requestId":"{requestId}"}`),
}
const BASE_OPTIONS = {
  parseQuery: true,
  cors: { allowOrigin: ['*'] },
  security: {},
}
const RATE_OPTIONS = {
  ...BASE_OPTIONS,
  rateLimit: { limit: LIMIT, windowMs: WINDOW_MS, maxEntries: 4096 },
}

const ffi = getBunFFI()
if (ffi === null) throw new Error('bun:ffi not active')
const ffiActive = ffi

function makeNative(options: typeof BASE_OPTIONS) {
  const built = buildProgramPlan(options, OK_RESPONSE)
  const descriptor = encodeRouteDescriptor(
    [],
    [],
    {
      maxBodyBytes: 2 * 1024 * 1024,
      maxQueryBytes: 8192,
      maxCookieBytes: 8192,
      maxPairs: 0,
    },
    encodeProgram(built.consts, built.ops),
  )
  const handle = ffiActive.routeCompile(descriptor)
  if (handle === 0) throw new Error('routeCompile failed')
  const route = createNativeRoute({ response: OK_RESPONSE, program: options })
  return { built, handle, route }
}

const frame = packRouteFrame('a=1&b=2', '', null, RID, {
  methodKind: METHOD_KIND.GET,
  ip: IP,
  headers: [['origin', ORIGIN]],
})

// ── Shared JS decision inputs ───────────────────────────────────────
const SECURITY: Array<[string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
]
const requestHeaders = new Headers({ origin: ORIGIN })

function jsArray(withRate: boolean): Array<[string, string]> {
  const origin = requestHeaders.get('origin')
  const headers: Array<[string, string]> = []
  for (const pair of SECURITY) headers.push(pair)
  headers.push(['content-type', 'application/json'])
  if (origin !== null) headers.push(['vary', 'Origin'])
  if (withRate) {
    const now = Date.now()
    headers.push(['ratelimit-limit', String(LIMIT)])
    headers.push(['ratelimit-remaining', String(LIMIT)])
    headers.push(['ratelimit-reset', String(Math.ceil(now / 1000) + 60)])
  }
  if (origin !== null) headers.push(['access-control-allow-origin', origin])
  return headers
}

function jsHeaders(withRate: boolean): Headers {
  const origin = requestHeaders.get('origin')
  const headers = new Headers()
  for (const [n, v] of SECURITY) headers.set(n, v)
  headers.set('content-type', 'application/json')
  if (origin !== null) headers.set('vary', 'Origin')
  if (withRate) {
    const now = Date.now()
    headers.set('ratelimit-limit', String(LIMIT))
    headers.set('ratelimit-remaining', String(LIMIT))
    headers.set('ratelimit-reset', String(Math.ceil(now / 1000) + 60))
  }
  if (origin !== null) headers.set('access-control-allow-origin', origin)
  return headers
}

const pct = (a: number, b: number): string => `${(((a - b) / a) * 100).toFixed(0)}%`
const verdict = (a: number, b: number): string =>
  a < b ? `CHEAPER by ${pct(b, a)}` : `NOT cheaper (${pct(a, b)} slower)`

async function runBlock(label: string, options: typeof BASE_OPTIONS, withRate: boolean) {
  const { built, handle, route } = makeNative(options)
  const nativeOut = new Uint8Array(4096)

  // Parity: the assembled native response must equal the JS-assembled one.
  const w = ffiActive.routeRun(handle, frame, nativeOut)
  const r = decodeRouteResult(nativeOut.subarray(0, w), { query: true, cookie: false })
  const assembled = route.assembleResponse(r)
  if (assembled === null) throw new Error('no assembled native response')
  const nativePairs = [...assembled.headers] as Array<[string, string]>
  const dynamic = new Set(['ratelimit-remaining', 'ratelimit-reset'])
  // `Headers` iteration is sorted; normalize both sides before comparing.
  const key = (pairs: ReadonlyArray<[string, string]>): string =>
    JSON.stringify(
      pairs
        .filter(([n]) => !dynamic.has(n))
        .slice()
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    )
  if (key(nativePairs) !== key(jsArray(withRate))) {
    throw new Error(
      `${label} native/JS header mismatch:\n  native=${key(nativePairs)}\n  js=${key(jsArray(withRate))}`,
    )
  }
  const body = await assembled.text()
  if (body !== `{"ok":true,"requestId":"${RID}"}`) {
    throw new Error(`${label} native body mismatch: ${body}`)
  }

  const tNative = measure(() => ffiActive.routeRun(handle, frame, nativeOut), ITER)
  const tNativeDecode = measure(() => route.runFrame(frame), ITER)
  const tNativeServe = measure(() => {
    const rr = route.runFrame(frame)
    const resp = route.assembleResponse(rr)
    if (resp === null) throw new Error('no response')
    return resp
  }, ITER)
  const tArray = measure(() => jsArray(withRate), ITER)
  const tHeaders = measure(() => jsHeaders(withRate), ITER)

  console.log(`═══ ${label} (ns/op, min-of-5) ═══`)
  console.log(`  ops: ${built.ops.length} (${built.consts.length} consts)`)
  console.log(`  native raw call: program + substitution  : ${tNative.toFixed(0).padStart(7)}`)
  console.log(`  native lane: raw call + JS decode        : ${tNativeDecode.toFixed(0).padStart(7)}`)
  console.log(`  native lane: decode + assemble Response  : ${tNativeServe.toFixed(0).padStart(7)}`)
  console.log(`  JS lean: decisions + pair array          : ${tArray.toFixed(0).padStart(7)}`)
  console.log(`  JS plugin: decisions + Headers writes    : ${tHeaders.toFixed(0).padStart(7)}`)
  console.log('  ──────────────────────────────────────────────────────────')
  console.log(`  native raw call vs JS lean array        : ${verdict(tNative, tArray)}`)
  console.log(`  native raw call vs JS Headers writes    : ${verdict(tNative, tHeaders)}`)
  console.log(`  native full lane vs JS Headers writes   : ${verdict(tNativeServe, tHeaders)}`)
  console.log('')
}

await runBlock('zero-callout program: parse + CORS + security + response', BASE_OPTIONS, false)
await runBlock('with rate_limit (stateful op)', RATE_OPTIONS, true)
