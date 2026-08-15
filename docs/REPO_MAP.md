# castrum — Repo Map (what is where, and why it works this way)

This is the **navigation doc**. It tells you where everything lives, how the
pieces connect, and how to run/build/test/bench/publish. If you are brand new,
read [`GETTING_STARTED.md`](./GETTING_STARTED.md) first; if you want deep-dive
architecture, read [`ARCHITECTURE.md`](./ARCHITECTURE.md). If you are an AI
agent editing this repo, [`AGENTS.md`](../AGENTS.md) is the agent-facing map.

---

## 1. What this project is

`castrum` is a hybrid **Bun (TypeScript) + Rust** package:

- A **Rust cdylib** (`castrum.<platform>-<arch>.node`, built with napi-rs,
  ALSO exporting `extern "C"` symbols for Bun's `bun:ffi` — see
  `rust/ffi.rs`) provides the performance-critical primitives (parsers,
  crypto, hashing, JSON, compression, and the HTTP **ingress pipeline**).
  Under Bun, `bun:ffi` is the PRIMARY transport; NAPI is the fallback
  (Node, `CASTRUM_FFI_MODE=napi`, or a failed ffi self-test).
- **TypeScript** (`src/`) provides the ergonomic public API: the flat `rust.*`
  FFI client, the `proven` performance surface, and the ingress layer.
- It ships benchmarks: a **CPU benchmark** (`bench.ts` → `src/bench`) and an
  **HTTP benchmark** (`bench/run-bench.ts` + `bench/servers/*`).

Bun is the primary runtime; Node.js ≥20.3 is supported via a compiled ESM entry
(`dist/`).

---

## 2. Command cheat-sheet

| Task | Command | Notes |
|------|---------|-------|
| Install deps | `bun install` | |
| Build Rust addon (release) | `bun run build` | `napi build --release --platform` |
| Build Rust addon (LOCAL max perf) | `bun run build:perf` | x86-64-v3 + AVX2 — **never for publish** |
| Build Rust addon (debug) | `bun run build:debug` | |
| Build compiled JS entry (Node) | `bun run build:js` | bundle + types → `dist/` (gitignored) |
| TS unit tests | `bun test` | ~540 tests, `test/unit/**` |
| Rust unit tests | `bun run test:rust` | `cargo test`, ~440 tests |
| Node smoke tests | `bun run test:node` | explicit `.mjs` paths (Node 24 rejects dir arg) |
| Installed-tarball e2e | `bun run verify:install` | pack → install → import from `node_modules` |
| Typecheck | `bun run typecheck` | `bunx tsc --noEmit` (only `index.ts`, `bench.ts`, `src/`) |
| CPU benchmark + correctness | `bun run check` | == `bun bench.ts`; writes `bench/results/cpu/` |
| Proven-surface audit | `bun run check:proven[:fail]` | `:fail` gates CI on regressions |
| Performance JSDoc | `bun run check:annotate` | rewrites perf JSDoc from CPU report; `--dry-run` previews |
| HTTP bench (all servers) | `bun run bench:http` | |
| HTTP smoke (fast sanity) | `bun run bench:http:smoke` | **the wire-format guard** (CI-gated) |
| Startup bench | `bun run bench:startup` | import + first-call timing |
| JS lint (Biome) | `bun run lint` / `lint:fix` | `bunx biome check [--write] .` |
| JS format (Biome) | `bun run format` | `bunx biome format --write .` |
| Version consistency | `bun run check:version` | package.json ↔ Cargo.toml ↔ CHANGELOG |
| JS dependency audit | `bun run audit` | `bun audit` (reports advisories) |
| Cargo deny audit | `bun run deny` | `cargo deny check` |
| Publish (manual, single-platform) | `bun run publish:manual[:dry]` | see §6 |

---

## 3. Directory map

### Source (what you edit)

```
index.ts                  Package entry (Bun). Re-exports src/rust-ffi, proven, shared helpers, src/ingress.
bench.ts                  CPU benchmark entry point → src/bench/run.ts.

examples/                 Runnable sample app (basic-server.ts + README) — see also README Quick Start.
  basic-server.ts         Minimal pre-baked ingress server + rust.* primitives.

src/
  native/                 The native transport layer: bun:ffi (primary on Bun) + NAPI fallback.
    types.ts              NativeAddon module-surface interface (mirrors index.d.ts).
    types/instances.ts    Per-class INSTANCE types (Ingress, SchemaValidator, JwtSigner, ...) + result types.
    loader.ts             Addon path resolution (multi-root) + getAddon()/lazyAddon().
    ffi.ts                bun:ffi C-ABI bindings (Bun-only): lazy bind + bind-time self-test,
                          CASTRUM_FFI_MODE gating, castrum_ingress_layout blob for constants.ts.
    ffi/                  ffi/types.ts (BunFFI interface) + constants.ts + selftest.ts (bind-time self-test).
    index.ts              Barrel.
  rust-ffi/               The flat `rust.*` FFI client (TS wrappers over the addon).
    client.ts             createRust() factory + the default `rust` instance + configure().
    scalar/ / text.ts / packed.ts   namespaces (buildScalar, buildText, ...).
    batch/                Array-of-bytes batch namespace: types.ts (RustBatch interface) + build.ts (impl) + index.ts.
    context.ts            Per-instance state (caches, rayon-pool bookkeeping).
    options.ts            RustOptions + rayon-thread resolution + coercion helpers.
    addon.ts              The single shared lazy addon proxy.
    proven.ts             `proven` client — the FULL rust.* surface, annotated (same object as `rust`).
    index.ts              Barrel (exports rust, createRust, types).
  shared/                 Cross-cutting helpers.
    runtime.ts            THE ONLY place `typeof Bun` is checked (isBun/isNode).
    bytes.ts              Shared TextEncoder/Decoder singletons + toPlainBuffer.
    packed/               Packed wire-format helpers (split from the old packed.ts monolith).
      wire.ts             PURE byte encode/decode (u32/bitset/i64/byte-results/multipart, pairs, pack-scratch) — no addon.
      schema.ts           SchemaValidator alias + schemaValidateBatch/Count.
      parsers.ts          lazy-addon string parsers (parseQueryString/parseCookieHeader/parseFormBody).
      index.ts            Barrel (existing `../shared/packed` imports unchanged).
    request-id.ts         Zero-alloc request-id generator (both ingress paths).
    buffer-pool.ts        Generic reusable byte-buffer pool (pooled ingress output).
    response.ts           pooledBodyResponse (releases the pool on body consume).
    log.ts                createStructuredLogger (CASTRUM_LOG_LEVEL-gated JSON lines).
    proven.ts             PROVEN_SURFACE registry (PURE DATA — no addon imports).
  ingress/                The HTTP ingress pipeline (two paths — see §4.2).
    fast.ts               PATH 1: createIngressFast (packed-input via handleRequestPacked).
    handlers.ts           PATH 2: createIngressHandler (JS-packs the frame via IngressInputPacker
                          + gatherRawHeadersPacked → handleRequestPacked).
    index.ts              Barrel + createIngress / createIngressSync convenience factories.
    shared.ts             JS constants + buildHeaderPlan + assertSyncCallback (shared by both paths).
    constants.ts          Binary-layout constants read from Rust at runtime (SINGLE SOURCE).
    status.ts / errors.ts / options.ts / types.ts / body.ts / context.ts
    packing/              header-packing.ts, input-packer.ts, gather-raw-headers.ts
    headers/              cors.ts, hsts.ts, fast-templates.ts, baked-templates.ts
    decode/               fast-result.ts, baked-result.ts   (TWO decoders — see §4.2)
    response/             terminal.ts, error-bodies.ts
    routes/               read/head/json-write/echo/fallback factories + common.ts
    server.ts             createIngressServer (Bun.serve) + buildRouteHandlers + gracefulShutdown.
    server-node.ts        createIngressServerNode (node:http adapter, same route handlers).
  integration/            Framework integration (wraps path 2 — createIngressHandler).
    pipeline.ts           createPipeline (framework-agnostic request stage for Hono/Elysia/Bun.serve).
    websocket.ts          createWebSocketUpgrade (RFC 6455 101 handshake + subprotocol).
    streaming.ts          sseResponse (SSE frames via rust.sseEncodeEvent).
  baseline/               Pure-JS baseline implementations (benchmark reference). Internal.
  bench/                  CPU benchmark framework (tasks, measure, report, checks, comparisons).
  data/                   json-rows.ts fixture generator (benchmark-only).
```

```
rust/                     ONE cdylib crate (Cargo [lib] → lib.rs).
  lib.rs                  Declaration hub + module map + crate docs.
  util/                   Shared infrastructure: bytes, packed, batch (+batch_core), threadpool, validation.
  http/                   HTTP wire formats & parsing: headers, method, http/cookie/query parsers,
                          form, media_type, url_codec, url_join, etag, accept, mime_lookup, multipart.
  crypto/                 Auth & hashing: hmac_sha256, cookie_sign, csrf, jwt, aead, argon2,
                          base64, hashing (fnv/crc32/xxh3), random_token.
  json/                   JSON & schema: json_ops, json_ser, json_patch_ops, json_schema (napi),
                          fast_schema/ (zero-DOM engine — pure, no napi).
  payload/                Output & streaming: compress, sse, ws_frames, websocket, template.
  ingress/                THE ingress pipeline: mod.rs (napi boundary), pipeline.rs (core 8-stage),
                          options/time/packed, cors, proxy, ip_trust, rate_limit, terminal,
                          output.rs (single numeric layout source), ingress_constants.rs (napi projection).
  ffi.rs                  #[no_mangle] extern "C" exports (75 castrum_* symbols — 67 direct + 4
                          validator_c_abi! + 4 compress_to_out!; parity guarded by
                          test/unit/features/ffi-symbol-parity.test.ts) for Bun's bun:ffi
                          primary transport, incl. castrum_ingress_layout (the layout blob).
  unit_tests.rs / test_support.rs   Cross-module Rust test suites.
```

### Generated / ignored (do NOT edit)

| Path | What it is | Why ignored |
|------|-----------|-------------|
| `dist/` | Compiled ESM entry + types for Node | Built by `build:js`; gitignored |
| `index.js` / `index.d.ts` | NAPI-RS generated loader/declarations | Regenerated by `napi build`; gitignored |
| `castrum.<platform>-<arch>.node` | The native addon binary | Built locally; gitignored |
| `bench/results/` | Bench reports (cpu/, http/) | Generated; gitignored |
| `target/` | Cargo build output | gitignored |
| `node_modules/` | Deps | gitignored |
| `artifacts/` | CI publish staging dir | gitignored |

---

## 4. How the pieces connect (the 5 cross-cutting flows)

### 4.1 Constants never drift (single numeric source)
`rust/ingress/output.rs` defines every ingress layout constant once → projected
to JS two ways: `rust/ingress/ingress_constants.rs` via `#[napi] const` (NAPI)
AND `rust/ffi.rs` `IngressLayout` via `castrum_ingress_layout` (C ABI, primary
on Bun) → `src/ingress/constants.ts` reads them at runtime (ffi blob on Bun,
napi on Node). Drift is pinned by the Rust unit test
`ingress_layout_c_abi_matches_output_source` and the bun:ffi bind-time
self-test. **Never hardcode a layout value** — if you change the layout, change
`output.rs` and nothing else.

### 4.2 The TWO ingress paths (do not conflate)
1. **`src/ingress/fast.ts`** — `createIngressFast(options)`. JS packs request
   headers into a binary buffer (`IngressInputPacker`), Rust parses via
   `handleRequestPacked`. Responses: `{"error":{code,status,message,requestId}}`
   with `x-ratelimit-*` headers.
2. **`src/ingress/handlers.ts`** — `createIngressHandler(options, runtime)`.
   The request frame is packed in JS (`IngressInputPacker` +
   `gatherRawHeadersPacked`) and driven through the SAME native core as path 1
   (`handleRequestPacked`), writing into a **pooled** output buffer. Responses:
   `{"ok":true,...,"requestId":...}` (success) / `{"ok":false,"error":{code,
   message}}` (errors) with `ratelimit-*` headers.

These wire formats are a **benchmark contract** (`bench/load.ts` validates
them) — they are intentionally NOT unified. The two decoders
(`decode/fast-result.ts` vs `decode/baked-result.ts`) and the two header-template
builders (`headers/fast-templates.ts` vs `headers/baked-templates.ts`) exist for
this reason. **Shared between both paths**: `generateRequestId`
(`src/shared/request-id.ts`) and `buildHeaderPlan` / `assertSyncCallback`
(`src/ingress/shared.ts`).

### 4.3 Addon loading + runtime seam
- `src/native/loader.ts` resolves the `.node` from multiple roots so it works
  from both the source layout (`src/…`) and the bundled layout (`dist/…`).
  Honors `CASTRUM_NATIVE_LIBRARY_PATH` / `NAPI_RS_NATIVE_LIBRARY_PATH`.
- Runtime detection lives **only** in `src/shared/runtime.ts`
  (`isBun`/`isNode`). `createIngressServer` is Bun-only; Node users use
  `createIngressServerNode` (same route handlers via `buildRouteHandlers`).
- ⚠️ `src/ingress/constants.ts` is the **one module that dlopens the addon at
  import time** (its constants are needed as soon as ingress is imported).
  Everything else is lazy.

### 4.4 The `proven` performance surface
`src/shared/proven.ts` (`PROVEN_SURFACE`) is the single source of truth for the
per-function performance classifications. It is **pure data** (no addon
imports) so `scripts/check-proven.ts` can audit it without dlopening.
`src/rust-ffi/proven.ts` exposes the FULL `rust.*` surface (nothing is
filtered); each function's JSDoc carries its measured performance vs the JS
baseline, written by `scripts/annotate-performance.ts` (`bun run check:annotate`)
and marked `@deprecated` when slower. `bun run check:proven:fail` (CI) audits
the registry against the CPU benchmark report on a **release** build.

### 4.5 Pooled output buffers (path 2)
`createIngressHandler` owns a `BufferPool` (`src/shared/buffer-pool.ts`) sized
by `runtime.outputBufferSize`. `run()` packs the frame in JS (`IngressInputPacker`
+ `gatherRawHeadersPacked`) and writes via `handleRequestPacked`
into the pooled buffer, passing the exact written subarray to
`BakedIngressResult.refresh`. In copy
mode the buffer is released at the end of `run()`; in zero-copy mode
`ingress.zeroCopyResponse()` serves a `pooledBodyResponse`
(`src/shared/response.ts`) that keeps the buffer in flight until the body is
consumed.

---

## 5. Testing & benchmarks

- **TS**: `bun test` → `test/unit/**` (`ingress/`, `shared/`, `features/`).
- **Rust**: `cargo test` → per-module `#[cfg(test)] mod tests` + cross-module
  `rust/unit_tests.rs`.
- **Node**: `test/integration/node-smoke.test.mjs` + `node-enterprise.test.mjs`
  via `node --test` (run with `bun run test:node`).
- **CPU bench**: `bun run check` (correctness checks + comparisons). Sub-µs ops
  are batched (`CASTRUM_BENCH_BATCH_SIZE`). Report → `bench/results/cpu/`.
- **HTTP bench**: `bench/run-bench.ts` + `bench/load.ts` (load generator that
  validates response SHAPE) + `bench/servers/{bun,elysia,ingress}-server.ts`.
  `bench:http:smoke` is the fast CI wire-format gate.

---

## 6. Publishing (npm)

- Package name `castrum` (unscoped, public). Native binary name `castrum`
  (declared in package.json `napi.binaryName` + Cargo.toml — keep in sync).
- **Multi-platform (recommended)**: push a `v*` tag → `.github/workflows/ci.yml`
  builds each platform addon, the `publish` job downloads them into
  `./artifacts`, stages them, and runs `npm publish` (needs `NPM_TOKEN`).
- **Manual single-platform**: `bun run publish:manual --increment minor`
  (syncs package.json ↔ Cargo.toml ↔ CHANGELOG, tags, builds, publishes with
  `CASTRUM_PUBLISH_ALLOW_PARTIAL=1`). `--dry-run` plans only.
- `prepublishOnly` runs `build:js` + `scripts/prepublish.mjs` (stages
  `artifacts/*.node` and verifies every `napi.targets` maps to a `.node`).
- Run `bun run check:version` before tagging.

---

## 7. Cross-links

| Doc | Purpose |
|-----|---------|
| [`GETTING_STARTED.md`](./GETTING_STARTED.md) | Beginner tutorial (intern-friendly) |
| [`API.md`](./API.md) | The complete public API reference |
| [`CASE_STUDY.md`](./CASE_STUDY.md) | Data-driven case study: how castrum was built and measured |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Deep-dive: modules, data flow, output layout, memory, concurrency |
| [`INGRESS.md`](./INGRESS.md) | The pre-baked ingress API + route factories + servers |
| [`BENCHMARKS.md`](./BENCHMARKS.md) | Benchmark scenarios, report format, how to run |
| [`ENVIRONMENT.md`](./ENVIRONMENT.md) | All `CASTRUM_*` env vars (+ legacy aliases) |
| [`AGENTS.md`](../AGENTS.md) | AI-agent editing guidance (commands, constraints, gotchas) |
| `README.md` | Public-facing overview + quick start |
