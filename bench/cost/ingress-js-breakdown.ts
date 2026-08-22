// bench/cost/ingress-js-breakdown.ts — decompose the JS-side cost of
// `createIngressHandler().run()` into its individual pieces, so the "run −
// native" residue (~320ns on this machine) can be attributed precisely before
// optimizing. Mirrors the exact options of bench/cost/ingress-cost.ts.
//
// Run: `bun bench/cost/ingress-js-breakdown.ts`
import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { BufferPool } from '../../src/shared/buffer-pool'
import { viewForArrayBuffer } from '../../src/shared/bytes'
import { generateRequestId } from '../../src/shared/request-id'
import { createIngressHandler } from '../../src/ingress/handlers'
import { BakedIngressResult } from '../../src/ingress/decode/baked-result'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../../src/ingress/shared'
import { IngressInputPacker } from '../../src/ingress/packing/input-packer'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { measureNs as measure } from '../measure'

const OPTIONS: Parameters<typeof createIngressHandler>[0] = {
  trustProxy: false,
  https: true,
  maxBodyBytes: 8 * 1024 * 1024,
  enableBodySizeGuard: true,
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true,
  cors: {
    allowOrigin: ['https://app.example.com', 'https://admin.example.com'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'X-Trace-Id'],
    allowCredentials: true,
    maxAge: 86400,
  },
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}

const handler = createIngressHandler(OPTIONS, { outputBufferSize: 262144 })
const headerPlan = buildHeaderPlan(OPTIONS)
const methodKind = METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN

const req = new Request('http://localhost:9122/api/users?q=testquery&page=1', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com' },
})

// Pre-warm the origin cache (steady state: same origin every request).
gatherRawHeadersPacked(req, headerPlan, methodKind, req.headers.get('origin'))

const inputPacker = new IngressInputPacker()
const pool = new BufferPool({ initialSize: 262144 })
const result = new BakedIngressResult()
const handle = pool.acquire(262144)

const NativeIngress = getAddon().Ingress as new (o: unknown) => {
  ingressInnerPtr(): bigint
}
const ingressPtr = Number(new NativeIngress(OPTIONS).ingressInnerPtr())
const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, 'https://app.example.com')
const prePacked = inputPacker.packParts(methodKind, req.url, undefined, generateRequestId(), packedHeaders)
const BODY: Uint8Array | null = null

// ── Individual pieces ──
const tRun = measure(() => handler.run(req, undefined, BODY, (r) => r.status), 20_000)

const tNative = measure(
  () => bunFFI.ingressHandleComponents
    ? bunFFI.ingressHandleComponents(ingressPtr, methodKind, req.url, '', generateRequestId(), packedHeaders, BODY, handle.buffer)
    : bunFFI.ingressHandlePacked(ingressPtr, prePacked, BODY, handle.buffer),
  20_000,
)

const tMethodKind = measure(() => METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN, 20_000)
const tRid = measure(() => generateRequestId(), 20_000)
const tOriginGet = measure(() => req.headers.get('origin'), 20_000)
const tGatherCached = measure(
  () => gatherRawHeadersPacked(req, headerPlan, methodKind, 'https://app.example.com'),
  20_000,
)
const tAcquire = measure(() => pool.acquire(262144), 20_000)
const tRefresh = measure(
  () => {
    const w = bunFFI.ingressHandlePacked!(ingressPtr, prePacked, BODY, handle.buffer)
    result.refresh(handle.buffer.subarray(0, w), BODY ?? new Uint8Array(0), viewForArrayBuffer(handle.buffer.buffer, handle.buffer.byteOffset))
  },
  20_000,
)

const written = bunFFI.ingressHandlePacked!(ingressPtr, prePacked, BODY, handle.buffer)
const used = handle.buffer.subarray(0, written)
const tRefreshOnly = measure(
  () => result.refresh(used, BODY ?? new Uint8Array(0), viewForArrayBuffer(used.buffer, used.byteOffset)),
  20_000,
)

console.log('═══ Ingress GET run() JS-side breakdown (ns/op, min-of-5) ═══')
console.log(`  run (full)          : ${tRun.toFixed(0).padStart(7)}`)
console.log(`  native (FFI+pipe)   : ${tNative.toFixed(0).padStart(7)}`)
console.log(`  JS-side (run−native): ${(tRun - tNative).toFixed(0).padStart(7)}`)
console.log('')
console.log(`  METHOD_KIND lookup  : ${tMethodKind.toFixed(0).padStart(7)}`)
console.log(`  generateRequestId   : ${tRid.toFixed(0).padStart(7)}`)
console.log(`  headers.get(origin) : ${tOriginGet.toFixed(0).padStart(7)}`)
console.log(`  gatherHeaders(cache) : ${tGatherCached.toFixed(0).padStart(7)}`)
console.log(`  pool.acquire        : ${tAcquire.toFixed(0).padStart(7)}`)
console.log(`  refresh (incl nat)  : ${tRefresh.toFixed(0).padStart(7)}`)
console.log(`  refresh (decode only): ${tRefreshOnly.toFixed(0).padStart(7)}`)
