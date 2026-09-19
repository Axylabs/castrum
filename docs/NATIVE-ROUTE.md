# Native route stack — the `@ignex/native` wire (route-wire v5)

`rust/ingress/native_route.rs` exposes the **per-route native stack**: a route
descriptor compiles once into a pre-baked `NativeRoute`, then each request runs
ONE native call. It is the LIVE external wire consumed by `@ignex/native`'s
`createNativeRoute` — a `castrum` consumer that compiles routes natively.

> **History**: the old `rust/route.rs` was dead external-project wire (a THIRD
> wire format, never bound in `src/native/ffi.ts`) and was removed in v0.9.0.
> `native_route.rs` implements the now-live ignex contract and supersedes it.

## Route-wire v5

- Magic `ROUT` (0x524f5554), version 5.
- Stage tags: `parseQuery = 0 … requireJsonBody = 5`.
- Part tags: `body = 3`, `response = 5`, **`program = 7`**. The ad-hoc
  `pre` part (tag 6) is **GONE** — a v5 descriptor carrying it is a hard reject
  (one v5, not two).
- Frame: `[flags u32][qLen][query][cLen][cookie]` followed by an optional
  `[bLen][body]` and an optional `[ridLen][rid]`. Frame flag bit 0 = body
  present, bit 1 = request-id present. v5 adds the optional, flag-gated
  `[method u8]`, `[ipLen][ip]`, `[headersLen][packed headers]` sections and the
  `HTTPS` bit (bits 2–5).
- Result layout: `[flags u32][errorCode u32]` + either the optional query/cookie
  pair sections (v3 shape) OR, when a terminal op emits a response, the framed
  HTTP response:
  `[status u16][hdrCount u32]{[nameLen u32][name][valueLen u32][value]}…`
  `[bodyLen u32][body]`, with result flag bit 7 (`HAS_RESPONSE`) set.
- A response body/header value may contain `{requestId}`/`{origin}`/`{remaining}`
  /`{resetSecs}`/`{retryAfterSecs}`/`{retryAfterMs}` placeholders, substituted
  from the frame + the program state.

## Native op program (v5 `program` part)

The `program` part replaces fixed stages with an **open op program**: an ordered,
fixed-width op stream interpreted by a tight loop (`run_program` in
`rust/ingress/native_route.rs`). An op is `(tag, operands, out-slot)` addressed
by a stable tag in a versioned registry (`ROUTE_PROGRAM_VERSION`,
`ROUTE_OP` / `OP_*`). Ops compose in any order/number; a decision op may `HALT`
(selecting a terminal class from its `ResponseSet`), and `JUMP`/`BRANCH` are
forward-only so execution always terminates. Unknown/bad tags, a bad program
version, a non-forward jump, a missing required class, or a `callout` are all
**hard rejects at compile** → the caller falls back to JS.

Payload:
`[version u8 = 1][constCount u32]{[len u32][bytes]}…`
`[opCount u32]{[tag u8][a u32][b u32][c u32]}…` (13 bytes/op).

Registry tags: `parse_query=1`, `parse_cookies=2`, `limits=3`, `ip_trust=4`,
`cors=5`, `rate_limit=6`, `security_headers=7`, `set_header=8`, `json_valid=9`,
`schema_validate=10`, `response_projection=11`, `halt=12`, `jump=13`,
`branch=14`, `callout=15` (documented, **rejected by this executor**).

Ops reuse the ingress cores (`CorsEngine`, `KeyedRateLimiter`,
`ProxyTrustMode`, `HeaderRefs`, `IngressSchema`, `json_valid_bytes`) and the SAME
TS header/body builders the JS path uses (`buildProgramPlan` in
`src/ingress/pre-effects.ts`), so the emitted bytes match the pre-baked JS path.
The op implementations themselves are pre-parsed at compile time into a `Vec<Op>`
and the per-request state is a fixed slab — nothing is allocated in the loop.
A program containing a `rate_limit` op is side-effecting, so the executor
computes a conservative output bound BEFORE running it: a needed-size retry can
never consume a rate-limit token twice.

`test/unit/ingress/native-route-program.test.ts` pins the public
`createNativeRoute({ program })` surface (OK / preflight 204+403 / 429) and the
wire rejects; `bench/cost/native-route-program.ts` times a zero-callout program
(parse + CORS + security + response) against the JS-equivalent work.

## Native response projection (v4 part, still supported)

Besides a per-class set, the older `response` part (tag 5) still compiles a
single 2xx projection. It is retained for the minimal constant-body case; the
`program` part supersedes it for anything with pre-effects.

Descriptor/stage/part tags + result layout must match `route-wire.ts` EXACTLY —
`ROUTE_DESC_VERSION` bumps on any wire change (a mismatched compiler/addon must
be a hard reject, never a silent misparse). v3/v4 descriptors are rejected by a
v5 build (and vice versa).

## Parse semantics (LENIENT)

Byte-parity with ignex's JS `queryPairs` / `cookiePairs`: malformed `%ZZ` /
invalid-UTF-8 `%FF` pass through raw, `+` → space, `%2B` → `+`, cookies trim +
DQUOTE-unwrap the VALUE but not the name, no cookie URL-decoding. Do NOT reuse
the strict scalar `query_parser` for this wire.

## Validation

The stack validates the BODY only (via `IngressSchema`); a non-body schema in
the descriptor is an unsupported feature → fail compile so the caller falls
back to JS. `requireJsonBody` → 400; `validateBody` schema fail → 422;
first-failure-wins in stage order.

The standalone `response` part is deliberately minimal: a constant pre-encoded
body with one optional `{requestId}` placeholder. A non-OK verdict keeps the v3
verdict shape (the caller must be able to reject).
`test/unit/ingress/native-route-response.test.ts` pins that wire round-trip;
`bench/cost/native-route-response.ts` is the micro-benchmark comparing native
assembly against the JS `JSON.stringify` + `new Headers` + body-encode cost.

## Surfaces

- `castrum_route_compile` / `castrum_route_run` / `castrum_route_destroy`
  (C-ABI, needed-size convention, panic-guarded, immutable `&self` run).
- napi `Route` class (Node / fallback path).
- **Public castrum surface (`createNativeRoute`, `nativeRouteHandler`)**:
  the stack is now a first-class castrum API, not just the ignex wire.
  - `createNativeRoute(plan)` (`src/ingress/native-route.ts`) compiles a
    route-wire v5 descriptor once and runs each frame in ONE native call —
    `run(query, cookie, body, pre?, requestId?)` / `runFrame(frame)` return the
    decoded verdict (flags + errorCode + optional response); `destroy()` frees
    the handle. The pure wire helpers (`encodeRouteDescriptor`,
    `encodeProgram`, `packRouteFrame`, `decodeRouteResult`, layout constants)
    live in `src/ingress/packing/route-wire.ts`.
  - `nativeRouteHandler(plan, responder, opts)` (`src/ingress/routes/native.ts`)
    wraps a compiled route as a `RouteHandler`: extracts the query substring +
    Cookie header, runs the tiny frame, rejects 400/422 on verdict failure,
    and hands the decoded snapshot to the responder for the 2xx.
  - `createIngressRouter`'s `native` route spec wires it into a server (see
    `INGRESS-ROUTER.md`). Measured: ~580ns cheaper per request than the
    full-pipeline responder on a parseQuery+parseCookies route, and **+34%
    RPS at the HTTP level** on the bench server's `/api/native` vs `/api/users`
    (server-bound config, 2000 connections).
  - The v5 `program` part removes the old trade-off for the framework layer:
    CORS, rate limiting, security headers, IP trust, body validation and the
    response projection all run in one native call. Routes that still need a JS
    handler emit a `callout` in the program, which this executor rejects →
    they fall back to the JS core. The castrum metadata envelope is still
    pipeline-only.

## Tests / parity

- `rust/ingress/native_route.rs` unit tests + `rust/ffi/` C-ABI tests.
- `test/unit/ingress/native-route.test.ts` (wire round-trip + lenient parity).
- `test/unit/ingress/native-route-public.test.ts` (public surface + router
  `native` kind).
- External parity: ignex's `route-wire.test.ts` /
  `packages/native/test/route.test.ts` (in the `@ignex/native` repo).

> **Naming note (flux → ignex)**: the external consumer was historically called
> `@flux/native` (castrum v0.8.0, guarded by `test/compat/flux-contract.test.ts`).
> The current live wire is `@ignex/native`. Both names appear in changelogs;
> `@ignex/native` is the active contract.
