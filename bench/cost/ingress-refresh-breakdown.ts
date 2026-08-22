// bench/cost/ingress-refresh-breakdown.ts — attribute `BakedIngressResult.refresh`
// (the ~50-70ns result decode) into its pieces so the micro-opt targets the real
// cost: the fixed-header DataView reads, the `sectionLayout` object allocation,
// `setRateWindow`'s getBigUint64 reads, and the flag-field sets.
//
// Run: `bun bench/cost/ingress-refresh-breakdown.ts`
import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { viewForArrayBuffer } from '../../src/shared/bytes'
import { generateRequestId } from '../../src/shared/request-id'
import { BakedIngressResult } from '../../src/ingress/decode/baked-result'
import { sectionLayout } from '../../src/ingress/decode/packed-sections'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../../src/ingress/shared'
import { IngressInputPacker } from '../../src/ingress/packing/input-packer'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { OUT_RATE_RESET, OUT_RETRY_AFTER } from '../../src/ingress/constants'
import { measureNs as measure } from '../measure'

// Minimal ingress options for a valid native run (GET, no body).
const opts = {
  trustProxy: false,
  https: true,
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true,
  cors: { allowOrigin: ['https://app.example.com'] },
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}
const NativeIngress = getAddon().Ingress as new (o: unknown) => {
  ingressInnerPtr(): bigint
}
const ingressPtr = Number(new NativeIngress(opts).ingressInnerPtr())
const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

const req = new Request('http://localhost:9122/api/users?q=testquery&page=1', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com' },
})
const headerPlan = buildHeaderPlan(opts)
const methodKind = METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN
const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, 'https://app.example.com')
const inputPacker = new IngressInputPacker()
const prePacked = inputPacker.packParts(methodKind, req.url, undefined, generateRequestId(), packedHeaders)
const out = new Uint8Array(262144)
const written = bunFFI.ingressHandlePacked(ingressPtr, prePacked, null, out)
const used = out.subarray(0, written)
const view = viewForArrayBuffer(used.buffer, used.byteOffset)

const result = new BakedIngressResult()
const body = new Uint8Array(0)

// ── pieces ──
const tRefresh = measure(() => result.refresh(used, body, view), 50_000)

// The 8 fixed-header reads + sectionLayout allocation, no field writes.
const tReadsAndLayout = measure(() => {
  const h0 = view.getUint32(0, true)
  const h1 = view.getUint32(4, true)
  view.getUint32(8, true)
  view.getUint32(12, true)
  const cookiesLenRaw = view.getUint32(16, true)
  const queryLenRaw = view.getUint32(20, true)
  view.getUint8(24)
  const bodyJsonLenRaw = view.getUint32(28, true)
  const layout = sectionLayout(used.byteLength, cookiesLenRaw, queryLenRaw, bodyJsonLenRaw)
  return h0 + h1 + layout.safeBodyJsonLen
}, 50_000)

// Reads only (no sectionLayout object).
const tReadsOnly = measure(() => {
  const h0 = view.getUint32(0, true)
  const h1 = view.getUint32(4, true)
  view.getUint32(8, true)
  view.getUint32(12, true)
  view.getUint32(16, true)
  view.getUint32(20, true)
  view.getUint8(24)
  view.getUint32(28, true)
  return h0 + h1
}, 50_000)

// sectionLayout allocation alone.
const tLayoutOnly = measure(
  () => sectionLayout(used.byteLength, 0, 0, 0),
  50_000,
)

// setRateWindow: OLD (2 getBigUint64) vs NEW (2× u32-halves) — direct A/B.
const tRateWindowOld = measure(() => {
  Number(view.getBigUint64(OUT_RATE_RESET, true))
  Number(view.getBigUint64(OUT_RETRY_AFTER, true))
}, 50_000)
const tRateWindowNew = measure(() => {
  const rLo = view.getUint32(OUT_RATE_RESET, true)
  const rHi = view.getUint32(OUT_RATE_RESET + 4, true)
  rLo + rHi * 4294967296
  const yLo = view.getUint32(OUT_RETRY_AFTER, true)
  const yHi = view.getUint32(OUT_RETRY_AFTER + 4, true)
  yLo + yHi * 4294967296
}, 50_000)

console.log('═══ refresh breakdown (ns/op, min-of-5) ═══')
console.log(`  refresh (full decode)        : ${tRefresh.toFixed(0).padStart(7)}`)
console.log(`  reads + sectionLayout        : ${tReadsAndLayout.toFixed(0).padStart(7)}`)
console.log(`  reads only (8 header)        : ${tReadsOnly.toFixed(0).padStart(7)}`)
console.log(`  sectionLayout alloc alone    : ${tLayoutOnly.toFixed(0).padStart(7)}`)
console.log(`  rateWindow OLD (getBigUint64): ${tRateWindowOld.toFixed(0).padStart(7)}`)
console.log(`  rateWindow NEW (u32 halves)  : ${tRateWindowNew.toFixed(0).padStart(7)}`)
