// bench/cost/ingress-native-decompose.ts — attribute the POST-path NATIVE
// pipeline cost (the ~578ns `ingressHandleComponents` on /api/users with a JSON
// body) by removing ONE feature at a time from the full config. Each delta
// isolates that stage's marginal cost on the same request:
//   full - noSchema     → the body scan (json_valid gate + fast_schema walk)
//   full - noEmitMeta   → the body/metadata echo into the response
//   full - noQuery      → query-string parse
//   full - noCookies    → cookie parse
//
// Run: `bun bench/cost/ingress-native-decompose.ts`
import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { generateRequestId } from '../../src/shared/request-id'
import { buildHeaderPlan, METHOD_KIND, METHOD_KIND_UNKNOWN } from '../../src/ingress/shared'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { USER_SCHEMA_BYTES } from '../http/servers/shared'
import { measureNs as measure } from '../measure'

type Opts = Record<string, unknown>
const CORS = {
  allowOrigin: ['https://app.example.com', 'https://admin.example.com'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id', 'X-Trace-Id'],
  allowCredentials: true,
  maxAge: 86400,
}

const base: Opts = {
  trustProxy: false,
  https: true,
  maxBodyBytes: 8 * 1024 * 1024,
  enableBodySizeGuard: true,
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true,
  schema: USER_SCHEMA_BYTES,
  cors: CORS,
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}

const variants: Record<string, Opts> = {
  full: { ...base },
  noSchema: { ...base, schema: undefined },
  noEmitMeta: { ...base, emitMetadataJson: false },
  noQuery: { ...base, parseQuery: false },
  noCookies: { ...base, parseCookies: false },
  noSchemaNoEmit: { ...base, schema: undefined, emitMetadataJson: false },
}

const NativeIngress = getAddon().Ingress as new (o: unknown) => { ingressInnerPtr(): bigint }
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
const headerPlan = buildHeaderPlan(base)
const methodKind = METHOD_KIND['POST'] ?? METHOD_KIND_UNKNOWN
const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, null)
const BODY = new TextEncoder().encode('{"id":1,"name":"stress_test"}')
const out = new Uint8Array(262144)

const results: Record<string, number> = {}
for (const [name, opts] of Object.entries(variants)) {
  const ptr = Number(new NativeIngress(opts).ingressInnerPtr())
  const t = measure(
    () => bunFFI.ingressHandleComponents(ptr, methodKind, req.url, '', generateRequestId(), packedHeaders, BODY, out),
    30_000,
  )
  results[name] = t
}

console.log('═══ POST native pipeline decomposition (ns/op, min-of-5) ═══')
for (const [name, t] of Object.entries(results)) {
  console.log(`  ${name.padEnd(16)}: ${t.toFixed(0).padStart(7)}`)
}
const full = results.full ?? 0
console.log('')
console.log('  marginal costs:')
console.log(`    body scan (full − noSchema)     : ${((full - (results.noSchema ?? 0))).toFixed(0).padStart(7)}`)
console.log(`    body echo (full − noEmitMeta)   : ${((full - (results.noEmitMeta ?? 0))).toFixed(0).padStart(7)}`)
console.log(`    query parse (full − noQuery)    : ${((full - (results.noQuery ?? 0))).toFixed(0).padStart(7)}`)
console.log(`    cookie parse (full − noCookies) : ${((full - (results.noCookies ?? 0))).toFixed(0).padStart(7)}`)
console.log(`    base pipeline (noSchemaNoEmit)  : ${(results.noSchemaNoEmit ?? 0).toFixed(0).padStart(7)}`)
