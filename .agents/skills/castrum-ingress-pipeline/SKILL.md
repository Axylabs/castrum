---
name: castrum-ingress-pipeline
description: Work inside castrum's HTTP ingress pipeline — the two wire formats, the layer map, single-source layout constants, and the invariants to keep when editing src/ingress/ or rust/ingress/.
---

# castrum: Ingress pipeline

The ingress is the production-grade HTTP pipeline: TS ergonomics in
`src/ingress/`, the native engine in `rust/ingress/`, one numeric layout
source, two deliberately-unified-able wire formats. `docs/INGRESS.md` is the
full reference; ADR `0001-two-wire-formats.md` records the why.

## The TWO paths — do not unify

| | `createIngressFast` | `createIngressHandler` |
|---|---|---|
| Rate-limit headers | `x-ratelimit-*` | `ratelimit-*` |
| Error envelope | `{"error":{code,status,message,requestId}}` | `{"ok":true\|false,...}` |
| Serving docs | `docs/INGRESS.md` | `docs/INGRESS.md` |

Both are live; ADR-0001 + AGENTS.md enforce non-unification. Never merge them.

## Layer map (`src/ingress/`)

```
packing/   frame packing (input-packer, header-packing, scratch)
headers/   CORS / HSTS / security templates
decode/    fast-result, baked-result, packed-sections decoders
response/  terminal, baked-response, error-bodies
routes/    per-route handler factories (read/head/json-write/echo/delete/options/fallback/native/responder)
router.ts  createIngressRouter — per-route compiled TS stack
native-route.ts  createNativeRoute — route-wire v3, ONE native call per frame
server.ts / server-node.ts   Bun.serve / node:http
```

## The invariants

1. **Single source of truth for layout numbers**: `src/ingress/constants.ts`
   reads the Rust layout via `castrum_ingress_layout` (C-ABI) or
   `ingress_constants.rs` (napi). Never hardcode a layout constant.
2. **Native pipeline entry points**: `handle_request_packed` /
   `handle_request_full_sync{,into}` (napi) and
   `castrum_ingress_handle_packed` (C-ABI opaque-handle fast path). The Rust
   side wraps the whole pipeline in `panic_guard` (→ 0 → JS 500), null-checks
   every pointer, and uses `slices_overlap` to copy input/body when it
   overlaps `out`.
3. **Two wire formats** (`docs/INGRESS.md`): the fast path and the handler
   path each have their own result envelope — `decode/` knows both.
4. **`src/ingress/index.ts` stays a pure re-export barrel** (except the
   `createIngressServer` shadow) — `check:clean` enforces this.
5. **Zero-copy policy**: `INGRESS_ZERO_COPY` is opt-in and off by default
   (bodies copied unless per-response output buffers are implemented);
   `INGRESS_OUTPUT_BUF_BYTES` bounds the Rust output buffer (truncation sets
   `FLAG_BODY_TRUNCATED` and fails closed).
6. **Env surface** is documented in `docs/ENVIRONMENT.md` — every `INGRESS_*`
   var is read in `bench/http/servers/ingress-server.ts` /
   `router-server.ts`; add/remove vars there AND in the doc.

## Native route stack (route-wire v3)

`createNativeRoute(plan)` compiles a descriptor once, then `runFrame` = ONE
native call returning flags + errorCode + query/cookie pairs. LENIENT parse
parity with ignex's JS `queryPairs`/`cookiePairs` (malformed `%ZZ` passes
through raw; `+` → space; cookies trim + DQUOTE-unwrap values but not names).
The stack does NOT do CORS/rate-limit/security-headers/IP-trust/metadata —
routes needing those use the full pipeline. Wire tags must match
`route-wire.ts` EXACTLY; `ROUTE_DESC_VERSION` bumps on any wire change. This
is the LIVE wire consumed by `@ignex/native`'s `createNativeRoute`.

## Verify after changes

```bash
bun run bench:http:smoke          # the CI-gated wire-format guard
bun test                          # test/unit/ingress/** (20 files)
cargo test                        # rust/ingress/** + rust/ffi/ ingress tests
bun run check:clean               # purity + module headers + doc links
```
