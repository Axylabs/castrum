# castrum examples

Minimal, self-contained examples of the public API. Each file runs directly
with Bun — the package resolves the TypeScript entry (`index.ts`) at the repo
root via the `bun` export condition, so there is nothing to build first.

| File | What it shows |
|------|---------------|
| `basic-server.ts` | Pre-baked ingress server (`createIngressHandler` + `createIngressServer`): routes, CORS, rate limiting, the `ratelimit-*`/`{"ok":...}` wire format, plus a couple of `rust.*` primitives. |
| `loader-demo.ts` | Higher-order loader (`createLoader`): N same-tick items coalesced into ONE packed native batch call (scalar vs bulk dispatch, DataLoader-style `load()`). |
| `pipeline-demo.ts` | Framework-agnostic pipeline (`createPipeline`): `handleRequest` / `preprocess` middleware + W3C trace correlation for any Bun/Node framework. |

## Run

```bash
bun examples/basic-server.ts
```

Then exercise it:

```bash
# GET — returns {"ok":true,...,"requestId":...} with the request metadata
curl -i http://localhost:3000/health

# POST — validates + echoes the JSON body
curl -i -X POST http://localhost:3000/api/users \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'

# Any other path → {"ok":false,"error":{"code":"not_found",...}} (404)
curl -i http://localhost:3000/nope
```

## Notes

- **Node.js**: the same handlers run under Node via `createIngressServerNode`
  (see `docs/INGRESS.md`) — only the server backend differs.
- The pre-baked path emits `ratelimit-*` headers and `{"ok":...}` bodies.
  `createIngressFast` (lower-level) emits `x-ratelimit-*` and
  `{"error":{code,status,message,requestId}}` — the two wire formats are a
  benchmark contract and intentionally differ (see `docs/REPO_MAP.md` §4.2).
