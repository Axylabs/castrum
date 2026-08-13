# Getting Started with castrum

A walkthrough for a first-time contributor or intern. By the end you'll know
how to import the package, use the `rust.*` primitives, stand up an HTTP
server, run the benchmarks, and run the test suite. For the full file map see
[`REPO_MAP.md`](./REPO_MAP.md).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (primary runtime)
- [Rust](https://rustup.rs) — stable + `cargo` (to build/test the addon). The
  repo pins a toolchain in `rust-toolchain.toml` (`channel = "1.97.1"`); install
  it with `rustup` so local builds match CI.
- Node.js ≥ 20.3 (optional — only for the Node compatibility path)

> **Building on different OSes**: `bun run build` (napi) works on Linux, macOS,
> and Windows (WSL recommended on Windows). `bun run build:perf` shells out to
> `bash scripts/build-perf.sh` and is **Linux-only** — it is a local max-perf
> build, never for publish. If `bash` is unavailable, use plain `bun run build`.

```bash
bun install
```

## 1. Import the package

The entry point is `index.ts` (Bun resolves it via the `bun` export condition).
Node users get the compiled `dist/index.js`.

```ts
import { rust } from "castrum";
```

## 2. Use the Rust-accelerated primitives

The flat `rust.*` namespace wraps every native function:

```ts
import { rust } from "castrum";

rust.crc32(new TextEncoder().encode("hello"));     // number
rust.fnv1a64(bytes);                               // bigint
rust.jsonValid(bytes);                             // boolean
rust.validateEmail(emailBytes);                    // boolean

// Text helpers (string in / string out)
rust.text.mimeFromExtension(".js");                // "text/javascript"
rust.text.urlEncode("a b");                        // "a%20b"

// Batch helpers (array of byte arrays → packed bitset/count)
rust.batch.jsonValid([docA, docB, docC]);          // Uint8Array bitset
rust.batch.fnv1a64([a, b]);                        // BigUint64Array
rust.batch.etag([a, b]);                           // Uint8Array[]
```

Most functions accept `Uint8Array` (or strings via the `text.` namespace).
Everything is **synchronous** — there is no async/await in the FFI surface.

> **Transport**: under Bun these calls run through `bun:ffi` (the PRIMARY
> transport — see `rust.transport()` / `rust.ffiActive()`); Node and any
> `CASTRUM_FFI_MODE=napi` fall back to the napi addon. Surfaces with no C-ABI
> export (instances, `rust.batch.*`/`packed.*`, `text.*`, structured scalars)
> always use the napi addon.

> **Tip**: `rust` is a singleton created with sensible defaults. If you need
> isolated state (own rayon threads, own HMAC cache), call
> `createRust({ rayonThreads: 4 })`.

### Higher-order data loader (`loader`)

For workloads that call the same op many times, `loader` gives you a hot,
pre-bound function with automatic bulk-vs-scalar dispatch, DataLoader-style
coalescing and a bounded LRU cache — over **44 ops** including paired and
schema-validator ops:

```ts
import { loader } from "castrum";

const isEmail = loader("validateEmail");
isEmail(emailBytes);                              // scalar → boolean
isEmail([a, b, c]);                               // bulk → ONE packed call
await isEmail.load(a);                            // coalesced + cached

loader.run("jsonPatch", docs, patches);           // paired ops (companion array)
loader.schema(validator)(docs);                   // schema bitset (+ .count())
```

See the README "Higher-order data loader" section for the full op table and
`createLoader` options.

## 3. The `proven` performance surface

Not every `rust.*` function beats the JS baseline on every CPU. `proven`
exposes the **full** `rust.*` surface, and each function's JSDoc records its
measured performance vs the JS baseline — functions that are slower carry
`@deprecated`:

```ts
import { proven, PROVEN_SURFACE } from "castrum";

proven.fnv1a64(bytes);   // JSDoc: ~11x faster than the JS baseline
```

`PROVEN_SURFACE` is the registry (pure data); `scripts/check-proven.ts`
audits it against the CPU benchmark so it can't drift, and
`scripts/annotate-performance.ts` (`bun run check:annotate`) refreshes the
per-function JSDoc from the latest report.

## 4. Stand up an HTTP server (the ingress pipeline)

The quickest path is the **pre-baked** route handlers + the server builder:

```ts
import { createIngressHandler, createIngressServer } from "castrum";

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  cors: { allowOrigin: ["https://app.example.com"] },
});

// createIngressServer is SYNCHRONOUS — it wraps Bun.serve over the routes.
// Each route maps HTTP methods to the pre-baked handlers (see below):
const server = createIngressServer({
  port: 3000,
  routes: {
    "/health":    { read: ingress },                  // GET + HEAD
    "/api/users": { read: ingress, write: ingress },  // + POST/PUT/PATCH (+OPTIONS)
  },
});

console.log("listening on", server.port);
```

- `read: ingress` — GET (+ HEAD) returns the ingress body JSON.
- `write: ingress` — POST/PUT/PATCH validates + echoes JSON.
- `echo: ingress`, `cookies: ingress`, and a top-level `fallback` are the other
  route options. The underlying factories (`readHandler`, `jsonWriteHandler`,
  `echoHandler`, `headHandler`, `fallbackHandler`) are also exported directly
  if you'd rather wire methods by hand.
- **Bun-only**: `createIngressServer`. **Node**: use `createIngressServerNode`
  with the same `routes` spec (and `await srv.ready` for the port).

The wire format is `{"ok":true,...,"requestId":...}` on success and
`{"ok":false,"error":{code,message}}` on errors, with `ratelimit-*` headers.

> There is also a lower-level **fast path** (`createIngressFast` +
> `createIngressSync`/`createIngress`). Prefer it only when you need the
> absolute lowest overhead and are comfortable calling `run()` yourself with a
> synchronous callback.

## 5. Run the benchmarks

```bash
# CPU benchmark (correctness checks + comparisons) — also gates `proven`
bun run check

# HTTP benchmark across all servers (bun / elysia / ingress)
bun run bench:http

# Fast HTTP smoke (the CI wire-format guard)
bun run bench:http:smoke
```

Results land in `bench/results/` (gitignored).

## 6. Run the tests

```bash
# Everything at once (TS unit + Rust unit + typecheck + lint)
bun run test:all

bun test          # TypeScript unit tests (test/unit/**)
bun run test:rust # Rust unit tests (cargo test)
bun run typecheck # TypeScript typecheck
bun run lint:ci   # Biome lint gate (what CI enforces)
bun run test:node # Node.js integration tests (node --test) — run `bun run build:js` first
```

## 7. Make your first change

1. Find where the code lives with [`REPO_MAP.md`](./REPO_MAP.md).
2. Edit the TypeScript (`src/`) and/or Rust (`rust/`).
3. If you changed Rust, rebuild the addon: `bun run build:debug`.
4. Run `bun test`, `bun run typecheck`, and `cargo test`.
5. If you touched any server or `handlers.ts`, run `bun run bench:http:smoke`.
6. If you changed a public function, update the `PROVEN_SURFACE` registry
   (`src/shared/proven.ts`) and run `bun run check:proven:fail` on a release
   build (`bun run build`).
7. Format + lint: `bun run format` and `bun run lint`.

## Common gotchas

- The **two ingress paths** have different wire formats — don't unify them
  (see REPO_MAP §4.2 and AGENTS.md).
- `tsconfig.json` typechecks `index.ts`, `bench.ts`, and `src/` (so `bench/` IS
  covered by `bun run typecheck`); `test/` + `bench/` are covered by
  `bun run typecheck:test` (`-p tsconfig.test.json`).
- `src/ingress/constants.ts` dlopens the addon at import time — that's
  intentional.
- The native addon must be rebuilt (`bun run build:debug`) before tests that
  touch Rust changes will see them.

## Next steps

- [`REPO_MAP.md`](./REPO_MAP.md) — where everything is and how it connects
- [`INGRESS.md`](./INGRESS.md) — the full pre-baked ingress API
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — deep-dive internals
- [`AGENTS.md`](../AGENTS.md) — agent/contributor guidance
