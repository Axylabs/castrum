// bench/cost/native-route-smoke.ts — functional smoke of the public
// `createNativeRoute` surface + the router `native` route kind (route-wire v3).
import { createNativeRoute, createIngressRouter, ROUTE_FLAG } from '../../src/ingress'

const route = createNativeRoute({ parseQuery: true, parseCookies: true })
const r = route.run('page=1&limit=20&q=hello%20world', 'session=abc; theme=dark', null)
console.log('flags OK:', (r.flags & ROUTE_FLAG.OK) !== 0)
console.log('query:', JSON.stringify(r.query))
console.log('cookies:', JSON.stringify(r.cookie))
console.log('errorCode:', r.errorCode)

const r2 = route.run('m=%ZZ&n=abc%', '', null)
console.log('lenient query:', JSON.stringify(r2.query))

const routeBody = createNativeRoute({ requireJsonBody: true })
const bad = routeBody.run('', '', new TextEncoder().encode('not json'))
console.log('non-json errorCode (expect 400):', bad.errorCode)
const ok = routeBody.run('', '', new TextEncoder().encode('{"x":1}'))
console.log('json ok errorCode (expect 0):', ok.errorCode)

const schema = new TextEncoder().encode(JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'number' } } }))
const routeSchema = createNativeRoute({ validateBody: true, schema })
const badSchema = routeSchema.run('', '', new TextEncoder().encode('{"x":"str"}'))
console.log('schema-fail errorCode (expect 422):', badSchema.errorCode)
const goodSchema = routeSchema.run('', '', new TextEncoder().encode('{"x":1}'))
console.log('schema-ok errorCode (expect 0):', goodSchema.errorCode)

const router = createIngressRouter({
  routes: {
    '/api/native': {
      native: {
        plan: { parseQuery: true, parseCookies: true },
        handler: (snap) => Response.json({ ok: true, requestId: snap.requestId, query: snap.query, cookies: snap.cookies }),
      },
    },
  },
})
const res = await router.fetch(new Request('http://localhost:0/api/native?page=2', { headers: { cookie: 'sid=v' } }))
console.log('router native status:', res.status)
console.log('router native body:', await res.text())

route.destroy()
routeBody.destroy()
routeSchema.destroy()
