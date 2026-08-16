// bench/ingress-cost-post.ts — per-request cost decomposition for the PRE-BAKED
// ingress POST path (jsonWriteHandler + createIngressHandler with a schema).
//
// Mirrors bench/ingress-cost.ts but drives a POST /api/users with a JSON body
// through the SAME route the bench server uses (parseCookies+parseQuery+cors+
// schema+emitMetadataJson), so we can see where the POST path's time goes
// relative to the GET path:
//   body     : readBodyWithLimit on a small content-length body (async)
//   run      : full handler.run(req, ip, body, cb) — ground truth for POST
//   native   : bunFFI.ingressHandleComponents(…, body) on a pre-packed frame —
//              the pure FFI + Rust pipeline (incl. json_valid_bytes + schema)
//   refresh  : BakedIngressResult.refresh on a pre-written output (decode)
//
// Run: `bun bench/ingress-cost-post.ts`
import { getAddon } from '../src/native'
import { getBunFFI } from '../src/native/ffi'
import { BufferPool } from '../src/shared/buffer-pool'
import { viewForArrayBuffer } from '../src/shared/bytes'
import { generateRequestId } from '../src/shared/request-id'
import { createIngressHandler } from '../src/ingress/handlers'
import { BakedIngressResult } from '../src/ingress/decode/baked-result'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../src/ingress/shared'
import { IngressInputPacker } from '../src/ingress/packing/input-packer'
import { gatherRawHeadersPacked } from '../src/ingress/packing/gather-raw-headers'
import { readBodyWithLimit } from '../src/ingress/body'
import { USER_SCHEMA_BYTES } from '../bench/servers/shared'
import { measureNs as measure, measureNsAsync as measureAsync } from './measure'

const OPTIONS: Parameters<typeof createIngressHandler>[0] = {
  trustProxy: false,
  https: true,
  maxBodyBytes: 8 * 1024 * 1024,
  enableBodySizeGuard: true,
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true,
  schema: USER_SCHEMA_BYTES,
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

const handler = createIngressHandler(OPTIONS, {
  outputBufferSize: 262144,
  emitRequestIdHeader: false,
})
const NativeIngress = getAddon().Ingress as new (o: unknown) => {
  ingressInnerPtr(): bigint
  handleRequestPacked(input: Uint8Array, body: Uint8Array | null, output: Uint8Array): number
}
const ingressPtr = Number(new NativeIngress(OPTIONS).ingressInnerPtr())
const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

const req = new Request('http://localhost:9122/api/users?q=testquery&page=1', {
  method: 'POST',
  headers: {
    host: 'localhost:9122',
    'content-type': 'application/json',
    'content-length': '24',
  },
})
const headerPlan = buildHeaderPlan(OPTIONS)
const methodKind = METHOD_KIND['POST'] ?? METHOD_KIND_UNKNOWN
const inputPacker = new IngressInputPacker()
const pool = new BufferPool({ initialSize: 262144 })
const result = new BakedIngressResult()
const BODY = new TextEncoder().encode('{"id":1,"name":"stress_test"}')

// Pre-build the frame once (the per-request JS work is what `pack` measures).
const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, null)
const prePacked = inputPacker.packParts(methodKind, req.url, undefined, generateRequestId(), packedHeaders)
const handle = pool.acquire(262144)

// The bench server's POST route sets a non-zero bodyTimeoutMs, so the body
// read races `req.arrayBuffer()` against a timer. A Request body is one-shot,
// so a fresh Request is built per iteration. Isolate the pieces:
//   req only        : construct a Request (no body read) — server Requests come
//                     from Bun.serve, so this is NOT part of the real path
//   read deadline>0 : readBodyWithLimit with the timer+race (current bench path)
//   read deadline=0 : readBodyWithLimit fast path, NO timer+race
//   arrayBuffer     : raw req.arrayBuffer() with no wrapper
const makeBodyReq = () =>
  new Request('http://localhost:9122/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '24' },
    body: '{"id":1,"name":"stress_test"}',
  })

const tReqOnly = await measureAsync(async () => {
  makeBodyReq()
}, 30_000)

const tReadRace = await measureAsync(async () => {
  await readBodyWithLimit(makeBodyReq(), 8 * 1024 * 1024, true, 30_000)
}, 30_000)

const tReadNoRace = await measureAsync(async () => {
  await readBodyWithLimit(makeBodyReq(), 8 * 1024 * 1024, true, 0)
}, 30_000)

const tArrayBuffer = await measureAsync(async () => {
  await makeBodyReq().arrayBuffer()
}, 30_000)

const tBytes = await measureAsync(async () => {
  const r = makeBodyReq()
  if (typeof r.bytes === 'function') await r.bytes()
  else await r.arrayBuffer()
}, 30_000)

const tGetCL = await measureAsync(async () => {
  makeBodyReq().headers.get('content-length')
}, 30_000)

const tGetCLAndBuffer = await measureAsync(async () => {
  const r = makeBodyReq()
  r.headers.get('content-length')
  await r.arrayBuffer()
}, 30_000)

// ── Phase measurements ──
const tRun = measure(
  () => handler.run(req, undefined, BODY, (r) => r.status),
  30_000,
)

const tNative = measure(
  () => bunFFI.ingressHandleComponents
    ? bunFFI.ingressHandleComponents(ingressPtr, methodKind, req.url, '', generateRequestId(), packedHeaders, BODY, handle.buffer)
    : bunFFI.ingressHandlePacked(ingressPtr, prePacked, BODY, handle.buffer),
  30_000,
)

// Isolate the components (cstring url/ip, 12 args) vs packed (URL already in
// the frame, 7 args) native paths — if the cstring URL transcode is the cost,
// the run() hot path should prefer packed when urlNeeded/ipNeeded are true.
const hasComponents = typeof bunFFI.ingressHandleComponents === 'function'
const tNativeComponents = hasComponents
  ? measure(
      () => bunFFI.ingressHandleComponents(ingressPtr, methodKind, req.url, '', generateRequestId(), packedHeaders, BODY, handle.buffer),
      30_000,
    )
  : -1
const tNativePacked = measure(
  () => bunFFI.ingressHandlePacked(ingressPtr, prePacked, BODY, handle.buffer),
  30_000,
)

const written = bunFFI.ingressHandleComponents
  ? bunFFI.ingressHandleComponents(ingressPtr, methodKind, req.url, '', generateRequestId(), packedHeaders, BODY, handle.buffer)
  : bunFFI.ingressHandlePacked(ingressPtr, prePacked, BODY, handle.buffer)
const used = handle.buffer.subarray(0, written)
const tRefresh = measure(
  () => result.refresh(used, BODY, viewForArrayBuffer(used.buffer, used.byteOffset)),
  30_000,
)

console.log('═══ Ingress POST /api/users cost (ns/op, min-of-5) ═══')
console.log(`  run     (full POST request) : ${tRun.toFixed(0).padStart(7)}`)
console.log(`  native  (FFI + pipeline)    : ${tNative.toFixed(0).padStart(7)}`)
console.log(`  refresh (result decode)     : ${tRefresh.toFixed(0).padStart(7)}`)
console.log(`  JS-side est (run−native)    : ${(tRun - tNative).toFixed(0).padStart(7)}`)
console.log('')
console.log('═══ Native path comparison (components vs packed) ═══')
console.log(`  native components (cstring) : ${tNativeComponents.toFixed(0).padStart(7)}`)
console.log(`  native packed (frame)       : ${tNativePacked.toFixed(0).padStart(7)}`)
console.log(`  delta (packed−components)   : ${(tNativePacked - tNativeComponents).toFixed(0).padStart(7)}`)
console.log('')
console.log('═══ Body-read decomposition (incl. Request construction) ═══')
console.log(`  req only (construct)        : ${tReqOnly.toFixed(0).padStart(7)}`)
console.log(`  read  deadline>0 (timer+race): ${tReadRace.toFixed(0).padStart(7)}`)
console.log(`  read  deadline=0 (no race)  : ${tReadNoRace.toFixed(0).padStart(7)}`)
console.log(`  raw arrayBuffer             : ${tArrayBuffer.toFixed(0).padStart(7)}`)
console.log(`  raw req.bytes()             : ${tBytes.toFixed(0).padStart(7)}`)
console.log(`  headers.get(content-length) : ${tGetCL.toFixed(0).padStart(7)}`)
console.log(`  getCL + arrayBuffer         : ${tGetCLAndBuffer.toFixed(0).padStart(7)}`)
console.log(`  race+timer est (readRace−noRace): ${(tReadRace - tReadNoRace).toFixed(0).padStart(7)}`)
