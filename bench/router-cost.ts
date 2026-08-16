// bench/router-cost.ts — per-route compiled-router cost decomposition.
//
// Proves the core claim behind `createIngressRouter`: a route whose options
// need NO cookies/query/CORS/proxy compiles a native `IngressInner` + header
// plan that reads ZERO headers and runs a near-empty native pipeline, versus
// a full route that parses cookies + query. Both share the same wire format
// and the same per-request JS packing, so the difference is purely the
// per-route pruning.
//
// Run: `bun bench/router-cost.ts` (Bun only — measures the bun:ffi transport).

import { createIngressRouter } from '../src/ingress/router'
import type { RouterRouteSpec } from '../src/ingress/router'
import { getBunFFI } from '../src/native/ffi'
import { measureNs as measure } from './measure'

if (getBunFFI() === null) {
  throw new Error('bun:ffi not active — cannot measure the per-route FFI cost')
}

// Two routes with deliberately different per-route option sets.
const minimalSpec: RouterRouteSpec = {
  read: true,
  options: { parseCookies: false, parseQuery: false },
}
const fullSpec: RouterRouteSpec = {
  read: true,
  write: true,
  options: {
    parseCookies: true,
    parseQuery: true,
    requireJsonBody: true,
    cors: {
      allowOrigin: ['https://app.example.com'],
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['content-type'],
      allowCredentials: true,
    },
  },
}

const router = createIngressRouter({
  warmOnCreate: true,
  routes: {
    '/health': minimalSpec,
    '/api/full': fullSpec,
  },
})

const minimalHandler = router.routeHandlers['/health']!
const fullHandler = router.routeHandlers['/api/full']!

const minimalReq = new Request('http://localhost:0/health', { method: 'GET' })
const fullReq = new Request('http://localhost:0/api/full?page=1&limit=20', {
  method: 'GET',
  headers: { host: 'localhost:0', origin: 'https://app.example.com', cookie: 'session=abc' },
})

const tMinimal = measure(() => {
  minimalHandler.run<number>(minimalReq, '127.0.0.1', null, (r) => r.status)
}, 50_000)
const tFull = measure(() => {
  fullHandler.run<number>(fullReq, '127.0.0.1', null, (r) => r.status)
}, 50_000)

console.log('═══ Per-route compiled-ingress cost (ns/op, min-of-5) ═══')
console.log(`  minimal route (no cookies/query/cors) : ${tMinimal.toFixed(0).padStart(7)}`)
console.log(`  full route (cookies+query+cors)       : ${tFull.toFixed(0).padStart(7)}`)
console.log(`  pruning saves                        : ${(tFull - tMinimal).toFixed(0).padStart(7)}`)
