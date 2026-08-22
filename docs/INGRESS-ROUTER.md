# `createIngressRouter` — per-route compiled ingress

`createIngressRouter` (`src/ingress/router.ts`) compiles a **route table into
dedicated native ingress instances** — one `IngressInner` per route, pruned to
exactly that route's stages. It is the "one super solution" over the existing
ingress core for servers with heterogeneous routes.

## Why per-route compilation

The plain `createIngressHandler` (see [`INGRESS.md`](./INGRESS.md)) serves every
path from ONE global `IngressInner` configured with a **superset** of options. A
router compiles each route's `options` into its OWN handler:

- The native pipeline prunes to that route's stages (`parseCookies`,
  `parseQuery`, `schema`, `cors`, `rateLimit`, `limits`, `requireJsonBody`…).
- `buildHeaderPlan` produces a **per-route header plan** — routes that need no
  headers gather ZERO headers.
- All routes share the SAME wire format (the existing packed
  `handle_request_packed`), the shared process-wide rate-limiter budgets, and
  optional `warmOnCreate` pre-warming.

The per-route native-compile idea is ALSO exposed standalone as the native route
stack (`rust/ingress/native_route.rs` + the `castrum_route_*` / napi `Route`
surface consumed by `@ignex/native`) — see [`NATIVE-ROUTE.md`](./NATIVE-ROUTE.md).

## API

### `RouterRouteSpec`

Per-route spec: `options` (per-route `IngressHandlerOptions`), plus flags that
wire route factories over that route's compiled handler:

| Flag | Routes wired |
|------|--------------|
| `read` | GET + HEAD read handler |
| `write` | POST/PUT/PATCH JSON-write handler |
| `echo` | POST echo handler |
| `cookies` | GET read (cookies-style) handler |
| `delete` | DELETE read-style handler |
| `responder` | JS responder route (`methods`, `readBody`, `terminalStyle`) |
| `native` | LEAN native-stack responder route: the route-wire v3 per-route stack (`createNativeRoute`) runs ONLY the plan's stages (parseQuery/parseCookies/requireJsonBody/validateBody) in ONE native call — no CORS/rate-limit/security/IP/metadata envelope. The responder builds the 2xx from the decoded snapshot. Measured ~580ns cheaper per request than the full-pipeline responder on a parseQuery+parseCookies route, and **+34% RPS at the HTTP level** on the bench server's `/api/native` vs `/api/users` (server-bound config). |
| `raw` | Raw `Request → Response` handler served OUTSIDE the pipeline (health/metrics probes) |
| `maxBodyBytes` / `bodyTimeoutMs` | Per-route write/echo overrides |

### `createIngressRouter(options)` → `IngressRouter`

- `routes: Record<string, RouterRouteSpec>` — the route table (required).
- `runtime?: BakedIngressRuntime` — shared hooks applied to every compiled route.
- `getIp`, `copyBody`, `terminalStyle` — shared defaults.
- `warmOnCreate?: boolean` — pre-warm every compiled route at construction.

`IngressRouter` exposes:

- `routeHandlers` — per-path compiled handlers.
- `routes` — path → method → handler map (compatible with `Bun.serve({ routes })`
  and `createIngressServerNode`).
- `match(pathname)` — path matcher (`:param` / `*` dynamic routes).
- `fetch(req, srv?)` — fetch-style dispatcher.
- `prewarm()` — JIT-warm all compiled routes.

## Example

```ts
const router = createIngressRouter({
  warmOnCreate: true,
  runtime: ingressMetrics?.runtime,
  routes: {
    '/health': { read: true, options: { parseCookies: false, parseQuery: false } },
    '/api/users': {
      read: true,
      write: true,
      options: { parseCookies: true, parseQuery: true, schema: USER_SCHEMA_BYTES },
    },
    '/metrics': { raw: metricsHandler(ingressMetrics) },
  },
})
const server = Bun.serve({ routes: router.routes }) // or router.fetch
```

The benchmark server `bench/http/servers/router-server.ts` uses this API (same route
surface as `ingress-server.ts` but per-route compiled). Cost breakdown:
`bun bench/cost/router-cost.ts` (`bun run bench:router`).
