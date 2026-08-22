// bench/cost/router-minimal-breakdown.ts — decompose the router's MINIMAL-route
// run() (~303ns) into its pieces: rid gen, header gather, pool acquire, the
// native components call, refresh decode, the response callback, invalidate.
// Targets the biggest remaining JS chunk for the per-route precompiled design.
//
// Run: `bun bench/cost/router-minimal-breakdown.ts`
import { createIngressRouter, type RouterRouteSpec } from '../../src/ingress/router'
import { getBunFFI } from '../../src/native/ffi'
import { getAddon } from '../../src/native'
import { BufferPool } from '../../src/shared/buffer-pool'
import { viewForArrayBuffer } from '../../src/shared/bytes'
import { generateRequestId } from '../../src/shared/request-id'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../../src/ingress/shared'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { BakedIngressResult } from '../../src/ingress/decode/baked-result'
import { measureNs as measure } from '../measure'

if (getBunFFI() === null) throw new Error('bun:ffi not active')

const minimalSpec: RouterRouteSpec = {
  read: true,
  options: { parseCookies: false, parseQuery: false },
}
const router = createIngressRouter({ warmOnCreate: true, routes: { '/health': minimalSpec } })
const h = router.routeHandlers['/health']!
const req = new Request('http://localhost:0/health', { method: 'GET' })
const bunFFI = getBunFFI()!

const tRun = measure(() => h.run<number>(req, '127.0.0.1', null, (r) => r.status), 50_000)

// Pieces (mirroring run()'s order for the minimal route):
const tRid = measure(() => generateRequestId(), 50_000)
const headerPlan = buildHeaderPlan({ parseCookies: false })
const methodKind = METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN
const tGather = measure(() => gatherRawHeadersPacked(req, headerPlan, methodKind, undefined), 50_000)
const pool = new BufferPool({ initialSize: 131072 })
const tAcquire = measure(() => pool.acquire(131072), 50_000)

// Native components call on a pre-built minimal frame (same as run() does).
const NativeIngress = getAddon().Ingress as new (o: unknown) => { ingressInnerPtr(): bigint }
const ptr = Number(new NativeIngress({ parseCookies: false, parseQuery: false }).ingressInnerPtr())
const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, undefined)
const out = new Uint8Array(131072)
const tNative = measure(
  () => bunFFI.ingressHandleComponents(ptr, methodKind, req.url, '', generateRequestId(), packedHeaders, null, out),
  50_000,
)

const result = new BakedIngressResult()
const written = bunFFI.ingressHandleComponents(ptr, methodKind, req.url, '', generateRequestId(), packedHeaders, null, out)
const used = out.subarray(0, written)
const view = viewForArrayBuffer(used.buffer, used.byteOffset)
const tRefresh = measure(() => result.refresh(used, new Uint8Array(0), view), 50_000)
const tInvalidate = measure(() => result.invalidate(), 50_000)

console.log('═══ router minimal-route run() breakdown (ns/op, min-of-5) ═══')
console.log(`  run (full minimal route)   : ${tRun.toFixed(0).padStart(7)}`)
console.log(`  rid gen                    : ${tRid.toFixed(0).padStart(7)}`)
console.log(`  header gather (EMPTY)      : ${tGather.toFixed(0).padStart(7)}`)
console.log(`  pool.acquire               : ${tAcquire.toFixed(0).padStart(7)}`)
console.log(`  native components (incl FFI): ${tNative.toFixed(0).padStart(7)}`)
console.log(`  refresh (decode)           : ${tRefresh.toFixed(0).padStart(7)}`)
console.log(`  invalidate (reset)         : ${tInvalidate.toFixed(0).padStart(7)}`)
