# Native route stack — the `@ignex/native` wire (route-wire v3)

`rust/ingress/native_route.rs` exposes the **per-route native stack**: a route
descriptor compiles once into a pre-baked `NativeRoute`, then each request runs
ONE native call. It is the LIVE external wire consumed by `@ignex/native`'s
`createNativeRoute` — a `castrum` consumer that compiles routes natively.

> **History**: the old `rust/route.rs` was dead external-project wire (a THIRD
> wire format, never bound in `src/native/ffi.ts`) and was removed in v0.9.0.
> `native_route.rs` implements the now-live ignex contract and supersedes it.

## Route-wire v3

- Magic `ROUT` (0x524f5554), version 3.
- Stage tags: `parseQuery = 0 … requireJsonBody = 5`.
- Result layout: `[flags u32][errorCode u32]` + optional query/cookie pair
  sections.

Descriptor/stage/part tags + result layout must match `route-wire.ts` EXACTLY —
`ROUTE_DESC_VERSION` bumps on any wire change (a mismatched compiler/addon must
be a hard reject, never a silent misparse).

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

## Surfaces

- `castrum_route_compile` / `castrum_route_run` / `castrum_route_destroy`
  (C-ABI, needed-size convention, panic-guarded, immutable `&self` run).
- napi `Route` class (Node / fallback path).
- **Public castrum surface (`createNativeRoute`, `nativeRouteHandler`)**:
  the stack is now a first-class castrum API, not just the ignex wire.
  - `createNativeRoute(plan)` (`src/ingress/native-route.ts`) compiles a
    route-wire v3 descriptor once and runs each frame in ONE native call —
    `run(query, cookie, body)` / `runFrame(frame)` return the decoded verdict
    (flags + errorCode + query/cookie pairs); `destroy()` frees the handle.
    The pure wire helpers (`encodeRouteDescriptor`, `packRouteFrame`,
    `decodeRouteResult`, layout constants) live in
    `src/ingress/packing/route-wire.ts`.
  - `nativeRouteHandler(plan, responder, opts)` (`src/ingress/routes/native.ts`)
    wraps a compiled route as a `RouteHandler`: extracts the query substring +
    Cookie header, runs the tiny frame, rejects 400/422 on verdict failure,
    and hands the decoded snapshot to the responder for the 2xx.
  - `createIngressRouter`'s `native` route spec wires it into a server (see
    `INGRESS-ROUTER.md`). Measured: ~580ns cheaper per request than the
    full-pipeline responder on a parseQuery+parseCookies route, and **+34%
    RPS at the HTTP level** on the bench server's `/api/native` vs `/api/users`
    (server-bound config, 2000 connections).
  - Trade-off (deliberate): the native stack does NOT do CORS, rate limiting,
    security headers, IP trust, or the castrum metadata envelope — routes that
    need those must use the full pipeline. The lean path is for routes where
    the framework owns the response body and only needs parse + verdict.

## Tests / parity

- `rust/ingress/native_route.rs` unit tests + `rust/ffi/` C-ABI tests.
- `test/unit/ingress/native-route.test.ts` (wire round-trip + lenient parity).
- `test/unit/ingress/native-route-public.test.ts` (public surface + router
  `native` kind).
- `scripts/verify-native-route.ts` + ignex's `route-wire.test.ts` /
  `packages/native/test/route.test.ts`.

> **Naming note (flux → ignex)**: the external consumer was historically called
> `@flux/native` (castrum v0.8.0, guarded by `test/compat/flux-contract.test.ts`).
> The current live wire is `@ignex/native`. Both names appear in changelogs;
> `@ignex/native` is the active contract.
