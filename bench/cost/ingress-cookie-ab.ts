// bench/cost/ingress-cookie-ab.ts — in-process A/B proving the cookie+cors
// gather fast path: with NO cookie header, a parseCookies:true handler must now
// cost the same as a parseCookies:false handler (previously ~190ns more, the
// per-request origin re-encode). Also shows the cookie-present general path is
// unchanged (still packs the cookie).
//
// Run: `bun bench/cost/ingress-cookie-ab.ts`
import { createIngressHandler } from '../../src/ingress/handlers'
import { measureNs as measure } from '../measure'

const base: Parameters<typeof createIngressHandler>[0] = {
  https: true,
  parseQuery: true,
  emitMetadataJson: true,
  cors: { allowOrigin: ['https://app.example.com'] },
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}
const WITH_COOKIE_PLAN: Parameters<typeof createIngressHandler>[0] = { ...base, parseCookies: true }
const WITHOUT_COOKIE_PLAN: Parameters<typeof createIngressHandler>[0] = { ...base, parseCookies: false }

const hWithCookies = createIngressHandler(WITH_COOKIE_PLAN, { outputBufferSize: 262144 })
const hNoCookies = createIngressHandler(WITHOUT_COOKIE_PLAN, { outputBufferSize: 262144 })

const noCookieReq = new Request('http://localhost:9122/api/users', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com' },
})
const withCookieReq = new Request('http://localhost:9122/api/users', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com', cookie: 'a=b' },
})

// warm both paths + caches
for (let i = 0; i < 2000; i++) {
  hWithCookies.run(noCookieReq, undefined, null, (r) => r.status)
  hNoCookies.run(noCookieReq, undefined, null, (r) => r.status)
  hWithCookies.run(withCookieReq, undefined, null, (r) => r.status)
}

const tWithCookiesNoCookie = measure(() => hWithCookies.run(noCookieReq, undefined, null, (r) => r.status), 30_000)
const tNoCookiesNoCookie = measure(() => hNoCookies.run(noCookieReq, undefined, null, (r) => r.status), 30_000)
const tWithCookiesWithCookie = measure(() => hWithCookies.run(withCookieReq, undefined, null, (r) => r.status), 30_000)

console.log('═══ cookie+cors A/B (ns/op, min-of-5) ═══')
console.log(`  parseCookies=true,  req no cookie  : ${tWithCookiesNoCookie.toFixed(0).padStart(7)}`)
console.log(`  parseCookies=false, req no cookie  : ${tNoCookiesNoCookie.toFixed(0).padStart(7)}`)
console.log(`  delta (should be ~0 now)           : ${(tWithCookiesNoCookie - tNoCookiesNoCookie).toFixed(0).padStart(7)}`)
console.log(`  parseCookies=true,  req WITH cookie: ${tWithCookiesWithCookie.toFixed(0).padStart(7)}`)
