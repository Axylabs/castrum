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

## Tests / parity

- `rust/ingress/native_route.rs` unit tests + `rust/ffi.rs` C-ABI tests.
- `test/unit/ingress/native-route.test.ts`.
- `scripts/verify-native-route.ts` + ignex's `route-wire.test.ts` /
  `packages/native/test/route.test.ts`.

> **Naming note (flux → ignex)**: the external consumer was historically called
> `@flux/native` (castrum v0.8.0, guarded by `test/compat/flux-contract.test.ts`).
> The current live wire is `@ignex/native`. Both names appear in changelogs;
> `@ignex/native` is the active contract.
