// bench/cost/native-route-vs-router.ts — A/B: the native per-route stack
// (route-wire v3, castrum_route_*) vs the router's pruned-IngressInner run().
//
// Full-path comparison INCLUDING response construction (the load generator
// requires the castrum envelope `{"ok":true,"requestId":...,"path":...,"query":
// {...},"cookies":{...}}`): the router path gets the envelope built natively
// (emitMetadataJson) and slices it; the native path decodes the pair sections
// and builds the envelope in JS. This measures whether the native stack's
// leaner pipeline survives the response build.
//
// Run: `bun bench/cost/native-route-vs-router.ts` (Bun only — bun:ffi).

import { createIngressRouter, type RouterRouteSpec } from '../../src/ingress/router'
import { getBunFFI } from '../../src/native/ffi'
import { encoder, decoder } from '../../src/shared/bytes'
import { generateRequestId } from '../../src/shared/request-id'
import { measureNs as measure } from '../measure'

const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

// ── Router path: per-route compiled IngressInner (current design) ──
const spec: RouterRouteSpec = {
  read: true,
  options: {
    parseCookies: true,
    parseQuery: true,
    https: true,
    emitMetadataJson: true,
  },
}
const router = createIngressRouter({ warmOnCreate: true, routes: { '/api/users': spec } })
const handler = router.routeHandlers['/api/users']!
const req = new Request('http://localhost:0/api/users?page=1&limit=20', {
  method: 'GET',
  headers: { host: 'localhost:0', cookie: 'session=abc' },
})

// Full router path: run() + the readHandler respond callback (envelope bodyJson
// slice + new Response), as the bench server serves it.
const tRouter = measure(() => {
  handler.run<Response>(req, '127.0.0.1', null, (result, ctx) => {
    const terminal = handler.terminalResponse(undefined, result, ctx)
    if (terminal) return terminal
    const init = {
      status: 200,
      headers: handler.responseHeaders(result.headerVariant, ctx.requestIdHeader, ctx.origin),
    }
    return new Response(result.bodyJson(true), init)
  })
}, 50_000)

// ── Native route stack path (route-wire v3) + JS envelope build ────
const desc = new Uint8Array(34)
const dv = new DataView(desc.buffer)
dv.setUint32(0, 0x524f5554, true) // ROUTE_DESC_MAGIC
dv.setUint32(4, 3, true) // ROUTE_DESC_VERSION
dv.setUint32(8, 2 * 1024 * 1024, true) // maxBodyBytes
dv.setUint32(12, 8192, true) // maxQueryBytes
dv.setUint32(16, 8192, true) // maxCookieBytes
dv.setUint32(20, 0, true) // maxPairs
dv.setUint32(24, 2, true) // stageCount
desc[28] = 0 // parseQuery
desc[29] = 1 // parseCookies
dv.setUint32(30, 0, true) // schemaCount

const handle = bunFFI.routeCompile(desc)
if (handle === 0) throw new Error('routeCompile failed')

const out = new Uint8Array(512)
const q = encoder.encode('page=1&limit=20')
const c = encoder.encode('session=abc')
const frame = new Uint8Array(4 + 4 + q.byteLength + 4 + c.byteLength)
const fv = new DataView(frame.buffer)
let p = 0
fv.setUint32(p, 0, true)
p += 4
fv.setUint32(p, q.byteLength, true)
p += 4
frame.set(q, p)
p += q.byteLength
fv.setUint32(p, c.byteLength, true)
p += 4
frame.set(c, p)

const tNative = measure(() => {
  const w = bunFFI.routeRun(handle, frame, out)
  const view = new DataView(out.buffer, out.byteOffset, w)
  const flags = view.getUint32(0, true)
  void flags
  // Build the castrum envelope from the decoded pair sections.
  let pos = 8
  const readPairs = (): Array<[string, string]> => {
    const count = view.getUint32(pos, true)
    pos += 4
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < count; i++) {
      const nl = view.getUint32(pos, true)
      pos += 4
      const name = decoder.decode(out.subarray(pos, pos + nl))
      pos += nl
      const vl = view.getUint32(pos, true)
      pos += 4
      const value = decoder.decode(out.subarray(pos, pos + vl))
      pos += vl
      pairs.push([name, value])
    }
    return pairs
  }
  const queryPairs = readPairs()
  const cookiePairs = readPairs()
  const query: Record<string, string> = {}
  for (const [k, v] of queryPairs) query[k] = v
  const cookies: Record<string, string> = {}
  for (const [k, v] of cookiePairs) cookies[k] = v
  const body = JSON.stringify({
    ok: true,
    requestId: decoder.decode(generateRequestId()),
    path: '/api/users',
    query,
    cookies,
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}, 50_000)

bunFFI.routeDestroy(handle)

console.log('═══ native route stack vs router — FULL path incl. response (ns/op, min-of-5) ═══')
console.log(`  router run() (native envelope + slice + Response) : ${tRouter.toFixed(0).padStart(7)}`)
console.log(`  native route (JS envelope from pairs + Response)   : ${tNative.toFixed(0).padStart(7)}`)
console.log(`  delta                                             : ${(tRouter - tNative).toFixed(0).padStart(7)}`)
