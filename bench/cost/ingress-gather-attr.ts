// bench/cost/ingress-gather-attr.ts — attribute the general-path header-gather
// cost: compare parseCookies:true (general path) vs parseCookies:false
// (CORS-only cache) with an origin-present request. Confirms whether the
// general path's ~225ns is the origin re-encode + cookie get.
//
// Run: `bun bench/cost/ingress-gather-attr.ts`
import { createIngressHandler } from '../../src/ingress/handlers'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../../src/ingress/shared'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { measureNs as measure } from '../measure'

const base: Parameters<typeof createIngressHandler>[0] = {
  https: true,
  parseQuery: true,
  emitMetadataJson: true,
  cors: { allowOrigin: ['https://app.example.com'] },
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}

const OPTIONS_GENERAL: Parameters<typeof createIngressHandler>[0] = {
  ...base,
  parseCookies: true,
}
const OPTIONS_CORSONLY: Parameters<typeof createIngressHandler>[0] = {
  ...base,
  parseCookies: false,
}

createIngressHandler(OPTIONS_GENERAL, { outputBufferSize: 262144 })
createIngressHandler(OPTIONS_CORSONLY, { outputBufferSize: 262144 })
const planGeneral = buildHeaderPlan(OPTIONS_GENERAL)
const planCorsOnly = buildHeaderPlan(OPTIONS_CORSONLY)
const methodKind = METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN

const reqOrigin = new Request('http://localhost:9122/api/users', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com' },
})
const reqNoOrigin = new Request('http://localhost:9122/api/users', {
  method: 'GET',
  headers: { host: 'localhost:9122' },
})
const ORIGIN = 'https://app.example.com'
gatherRawHeadersPacked(reqOrigin, planGeneral, methodKind, ORIGIN)
gatherRawHeadersPacked(reqOrigin, planCorsOnly, methodKind, ORIGIN)

const tGeneralOrigin = measure(
  () => gatherRawHeadersPacked(reqOrigin, planGeneral, methodKind, ORIGIN),
  50_000,
)
const tCorsOnlyOrigin = measure(
  () => gatherRawHeadersPacked(reqOrigin, planCorsOnly, methodKind, ORIGIN),
  50_000,
)
const tGeneralNoOrigin = measure(
  () => gatherRawHeadersPacked(reqNoOrigin, planGeneral, methodKind, undefined),
  50_000,
)

console.log('═══ gather-attr (ns/op, min-of-5) ═══')
console.log(`  general path, origin present : ${tGeneralOrigin.toFixed(0).padStart(7)}`)
console.log(`  CORS-only cache, origin present: ${tCorsOnlyOrigin.toFixed(0).padStart(7)}`)
console.log(`  general path, no origin      : ${tGeneralNoOrigin.toFixed(0).padStart(7)}`)
