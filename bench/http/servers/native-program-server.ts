// bench/http/servers/native-program-server.ts — route-wire v6 zero-callout op
// program served END-TO-END (Bun.serve): one `castrum_route_run` per request
// makes the parse + CORS + security decisions and returns the selected class +
// substitution values; JS assembles the `Response` against the compile-time
// template (memoized `Headers`, pre-encoded body segments).
//
// This is the "native declarative lane" participant for the server-bound
// ceiling measurement (bench/cost/native-route-server-bound.mjs). The route
// shape is parse_query + CORS(wildcard) + security headers + response
// projection — the zero-callout shape the executor supports today.
//
// Run: `bun bench/http/servers/native-program-server.ts`

import { METHOD_KIND } from '../../../src/ingress'
import { createNativeRoute } from '../../../src/ingress/native-route'
import { encoder } from '../../../src/shared/bytes'
import { generateRequestId } from '../../../src/shared/request-id'
import { envNumber } from './shared'

const PORT = envNumber('NATIVE_PROGRAM_PORT', 9130, 1)

const OK_RESPONSE = {
  status: 200,
  headers: [{ name: 'content-type', value: 'application/json' }],
  body: encoder.encode(`{"ok":true,"requestId":"{requestId}"}`),
}
const PROGRAM_OPTIONS = {
  parseQuery: true,
  cors: { allowOrigin: ['*'] },
  security: {},
  requestIdHeader: false,
}

const route = createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS })

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  routes: {
    '/health': {
      GET: () => new Response('ok', { headers: { 'content-type': 'text/plain' } }),
    },
    '/api/users': {
      GET: (req, srv) => {
        const url = req.url
        const qIndex = url.indexOf('?')
        const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : ''
        const cookieStr = req.headers.get('cookie') ?? ''
        const origin = req.headers.get('origin')
        const ip = (srv as { requestIP?: (r: Request) => { address?: string } | null })
          ?.requestIP?.(req)?.address
        const pre = {
          methodKind: METHOD_KIND.GET,
          ip: ip ?? '',
          headers: origin === null ? [] : ([['origin', origin]] as Array<[string, string]>),
          https: true,
        }
        const r = route.run(queryStr, cookieStr, null, pre, generateRequestId())
        const resp = route.assembleResponse(r)
        if (resp === null) {
          return Response.json(
            { ok: false, error: { code: 'internal', message: 'native route failed' } },
            { status: 500 },
          )
        }
        return resp
      },
    },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
})

console.log(`[native-program] listening on :${server.port}`)
