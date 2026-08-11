# AGENTS.md — castrum

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs live in `README.md` and `docs/`.

## What this project is

`castrum` is a hybrid **Bun (TypeScript) + Rust** package. A Rust
cdylib (`castrum.<platform>-<arch>.node`, built with napi-rs) provides
performance-critical primitives; TypeScript (`src/`) provides the ergonomic
public API. It ships a CPU benchmark (`bench.ts`), an HTTP benchmark
(`bench/run-bench.ts` + `bench/servers/*-server.ts`), and a production-grade
HTTP **ingress pipeline** for Bun servers.

## Commands

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Build Rust addon (release) | `bun run build` (== `napi build --release --platform`) |
| Build Rust addon (LOCAL max perf) | `bun run build:perf` (x86-64-v3 + AVX2/BMI2/FMA — never for publish) |
| Build Rust addon (debug) | `bun run build:debug` |
| Build compiled JS entry (Node) | `bun run build:js` (bundle + types → `dist/`) |
| Node smoke tests | `bun run test:node` (== `node --test test/integration/node-smoke.test.mjs test/integration/node-enterprise.test.mjs`; explicit file paths — Node 24 rejects a directory arg) |
| Installed-tarball e2e | `bun run verify:install` (pack → install into a temp consumer → import from `node_modules`) |
| Rust unit tests | `cargo test` (~250 tests; per-module `#[cfg(test)] mod tests` + `rust/unit_tests.rs`) |
| TS unit tests | `bun test` (~255 tests, `test/unit/**`) |
| CPU benchmark | `bun run check` (== `bun bench.ts`) — **not** a typecheck |
| Proven-surface audit | `bun run check:proven` (report) / `bun run check:proven:fail` (CI gate) |
| Startup / first-call benchmark | `bun run bench:startup` |
| Typecheck | `bun run typecheck` (== `bunx tsc --noEmit`; `include` = index.ts, bench.ts, src, bench) + `bun run typecheck:test` (== `bunx tsc --noEmit -p tsconfig.test.json`; typechecks `test/` + `bench/` with unused locals/params on) |
| JS lint / format (Biome) | `bun run lint` / `bun run lint:fix` / `bun run format` |
| Version consistency | `bun run check:version` (package.json ↔ Cargo.toml ↔ CHANGELOG) |
| JS dependency audit | `bun run audit` |
| Cargo deny audit | `bun run deny` (== `cargo deny check`) |
| HTTP bench (all servers) | `bun run bench:http` |
| HTTP bench (ingress only) | `bun run bench:http:ingress` |
| HTTP smoke (fast sanity; CI-gated wire-format guard) | `bun run bench:http:smoke` |
| Ingress load scenario | `SERVER=ingress SCENARIO=01-smoke bun run bench:http:smoke` |

## Publishing (npm)

- Package name is **`castrum`** (unscoped, public npm). The native binary name is
  `castrum` (`castrum.<platform>-<arch>.node`), declared in package.json
  `napi.binaryName` and mirrored in Cargo.toml `[package]`/`[lib] name`. Keep all
  three in sync.
- Runtime env vars use the `CASTRUM_*` prefix; legacy `RUST_BENCH_*` / `RUST_*`
  names are still read as aliases (see `docs/ENVIRONMENT.md`).
- **Do not `npm publish` locally** — the package ships ALL `napi.targets` in one
  tarball, and `prepublishOnly` (`node scripts/prepublish.mjs`) fails unless every
  platform `.node` is present. Push a `v*` tag instead: `.github/workflows/ci.yml`
  builds + uploads each platform artifact, then the `publish` job downloads them
  into `./artifacts`, stages them, and runs `npm publish --access public`
  (requires the `NPM_TOKEN` secret). Bump `version` in package.json (and
  Cargo.toml) and add a CHANGELOG entry before tagging. The ONLY local-publish
  exception is `bun run publish:manual`, which sets `CASTRUM_PUBLISH_ALLOW_PARTIAL=1`
  to ship a single-platform tarball.
- **Simple manual publish (no CI / GitHub dependency):**
  `bun run publish:manual` (`scripts/publish-manual.mjs`) — bumps the version via
  `bun pm version` (`--increment <patch|minor|major|...>`, syncing
  `Cargo.toml`/`Cargo.lock`/`CHANGELOG.md`), creates + pushes the `v<version>` git
  tag (and the current branch), builds the host addon (`bun run build`), and runs
  `npm publish --access public`. It sets `CASTRUM_PUBLISH_ALLOW_PARTIAL=1` for the
  publish, so `prepublishOnly` ships ONLY the platforms built locally (currently the
  host platform) instead of failing on missing `napi.targets`. Full multi-platform
  tarballs still come from CI on a v* tag push. Prereqs: npm logged in (or
  `NPM_TOKEN` exported); a clean tree when using `--increment`. Without
  `--increment`, HEAD must sit on the exact `v<version>` tag (`--allow-dirty` to
  tolerate an uncommitted tree). `bun run publish:manual:dry` (`--dry-run`) prints
  the plan without changing anything.

## Layout (quick map)

```
index.ts                  package entry (re-exports src/rust-ffi, src/loader, src/integration, src/ingress, ...)
bench.ts                  CPU benchmark entry -> src/bench
dist/                     COMPILED ESM entry for Node (gitignored): dist/index.js + dist/index.d.ts
                          built by `bun run build:js`; wired via exports conditions (`bun` -> index.ts)
src/shared/runtime.ts     runtime detection (isBun/isNode) — the ONLY place `typeof Bun` is checked
src/shared/log.ts         createStructuredLogger (CASTRUM_LOG_LEVEL-gated JSON lines)
src/ingress/              HTTP ingress pipeline (TS layer), decomposed by task:
  ├── constants.ts        binary-layout constants, read from Rust at runtime (SINGLE SOURCE OF TRUTH)
  ├── shared.ts           JS constants shared by both paths (METHOD_KIND, DEFAULT_MAX_BODY_BYTES, HeaderPlan)
  ├── status.ts           status normalization helpers (both paths)
  ├── errors.ts           fast-path error-code name/message mapping
  ├── options.ts          IngressFast option types + fail-fast validation + trustProxy deprecation warning
  ├── types.ts            public API types (IngressOptions/Result/Context/...)
  ├── body.ts             streaming request-body reader (async API; size guard + bodyTimeoutMs)
  ├── context.ts          result snapshot + synthetic/internal context builders
  ├── server.ts           createIngressServer (Bun.serve) + buildRouteHandlers (shared) + gracefulShutdown
  ├── server-node.ts      createIngressServerNode (node:http adapter, same route handlers)
  ├── packing/            header-packing.ts (fast) + input-packer.ts + gather-raw-headers.ts (pre-baked) + scratch.ts (shared TLS buffers + per-header size guards)
  ├── headers/            cors.ts + hsts.ts + fast-templates.ts + baked-templates.ts (two template builders, NOT unified)
  ├── decode/             fast-result.ts + baked-result.ts (two decoders, NOT unified) + packed-sections.ts (shared section layout)
  ├── response/           terminal.ts (fast) + error-bodies.ts (pre-baked)
  ├── routes/             read/head/json-write/echo/fallback factories + common.ts
  ├── fast.ts             thin: createIngressFast (packed-input path, handleRequestPacked) + re-exports
  ├── handlers.ts         thin: createIngressHandler (packed-input path: frame packed in
  │                       JS via IngressInputPacker + gatherRawHeadersPacked, driven by
  │                       handleRequestPacked, pooled output); used by the bench server
  └── index.ts            barrel: public API + async createIngress + re-exports
src/native/               addon layer: types.ts (NativeAddon + instance types) + loader.ts (getAddon/lazyAddon) + index.ts barrel
src/rust-ffi/             flat Rust FFI API (`rust`), decomposed: options.ts + addon.ts + context.ts + text.ts + batch.ts + packed.ts + scalar/ (interface + hashing/json/http/crypto/payload/factories builders) + client.ts + proven.ts + index.ts barrel
src/shared/request-id.ts  shared zero-alloc request ID generator (both ingress paths) — aliased buffer hazard documented
src/shared/buffer-pool.ts  generic reusable byte-buffer pool (pooled output buffers, zero-copy borrows)
src/shared/response.ts     pooledBodyResponse: Response that returns a pooled buffer on body consumption
src/shared/env.ts          centralized env-var alias resolution (CASTRUM_* + legacy RUST_BENCH_*/RUST_* names)
src/loader/               higher-order loader (HFC) over the curated op set (ops/cost/batch/index) — exported from index.ts
src/integration/          framework-agnostic helpers: createPipeline, createWebSocketUpgrade, sseResponse — exported from index.ts
src/baseline/             JS baseline implementations (benchmark reference, `native`)
src/bench/                CPU benchmark framework (tasks, measure, report, ...)
src/data, src/shared/     JSON rows + bytes/packed helpers
bench/servers/            bun-server.ts, elysia-server.ts, ingress-server.ts (HTTP bench)
bench/load.ts             HTTP load generator + scenarios; validates response SHAPE
bench/startup.ts          "instant execution" benchmark (import + first-call timing)
scripts/build-perf.sh     LOCAL-only max-perf build (x86-64-v3 + SIMD)
test/unit/                TS tests (ingress/fast, shared/packed, shared/bytes, features, ingress/body)
test/integration/         Node tests (node-smoke.test.mjs + node-enterprise.test.mjs, run via node --test; the enterprise file adds Buffer interop, the precompiled instances, node:crypto cross-checks, keep-alive/413/clientError/slowloris)
rust/                     one cdylib crate (Cargo [lib] → rust/lib.rs), decomposed into
                          DOMAIN FOLDERS (lib.rs declares the folders + a module map):
  ├── lib.rs              declaration hub + module map comment; unit-test scaffolding
  ├── util/               SHARED INFRASTRUCTURE (mod.rs re-exports keep `crate::util::*`)
  │   ├── bytes.rs        byte primitives: word-compare, hex, %XX decode, cookie_pairs
  │   ├── packed.rs       zero-alloc packed iterators + byte writers (VecWriter, PackedIter)
  │   ├── batch.rs        aggregate packed batch napi APIs (bitset/count/sum/direct)
  │   ├── batch_core.rs   generic rayon-parallel batch helpers (bitset/count/sum)
  │   ├── threadpool.rs   rayon global pool init + parallelism heuristic
  │   └── validation.rs   email / UUID / IPv4 / IPv6 validators
  ├── http/               HTTP WIRE FORMATS & PARSING
  │   ├── headers.rs      zero-alloc packed-header parser (HeaderRefs)
  │   ├── method.rs       HTTP method classification
  │   ├── http_parser.rs  httparse → packed request
  │   ├── cookie_parser.rs / query_parser.rs   zero-alloc packed pairs parsers
  │   ├── form.rs         x-www-form-urlencoded parser + FormParser instance
  │   ├── media_type.rs   Content-Type parser + MediaTypeParser / MediaTypeMatcher
  │   ├── url_codec.rs / url_join.rs   percent-encoding + RFC 3986 resolve (UrlBuilder)
  │   ├── etag.rs         etag / http_date / parse_http_date + ConditionalRequest (304)
  │   ├── accept.rs       Accept-Encoding + AcceptNegotiator (q-values, specificity-first)
  │   ├── mime_lookup.rs  extension → MIME (phf table)
  │   └── multipart.rs    multipart/form-data parser (+ limits)
  ├── crypto/             AUTH & HASHING (compiled-once instances; keys compiled at construction)
  │   ├── hmac_sha256.rs / cookie_sign.rs / csrf.rs   HMAC, signed cookies, CSRF
  │   ├── jwt.rs          HS256 JWT sign/verify + JwtSigner (precomputed header)
  │   ├── aead.rs         AES-256-GCM / chacha20-poly1305 + AeadCipher
  │   ├── argon2.rs       argon2id + Argon2Hasher
  │   ├── base64.rs       base64/base64url/hex + Base64Codec
  │   ├── hashing.rs      FNV-1a / XXH3 / crc32
  │   └── random_token.rs random hex tokens
  ├── json/               JSON & SCHEMA
  │   ├── json_ops.rs     zero-DOM validate/sum + DOM parse
  │   ├── json_ser.rs     zero-alloc JSON escaping + cookie/query → JSON writers
  │   ├── json_patch_ops.rs  RFC 6902 JSON patch
  │   ├── json_schema.rs  SchemaValidator napi class (fast path + jsonschema-crate fallback)
  │   └── fast_schema/    zero-DOM JSON Schema fast path: mod.rs (re-exports compile/FastNode)
  │       └── types.rs / cursor.rs / compile.rs / validate.rs / tests.rs
  ├── payload/            OUTPUT & STREAMING
  │   ├── compress.rs     gzip (zlib-rs) + brotli + batch
  │   ├── sse.rs / ws_frames.rs / websocket.rs   SSE framing, RFC 6455 codec, accept-key
  │   └── template.rs     minijinja TemplateRenderer + batch
  ├── ingress/            THE INGRESS PIPELINE
  │   ├── mod.rs          thin napi boundary: Ingress class + entry points
  │   ├── pipeline.rs     core 8-stage pipeline (IngressInner::handle_packed,
  │   │                   write_body_sections, BodySections, IngressSchema)
  │   ├── tests.rs        ingress unit tests
  │   ├── options.rs / time.rs / packed.rs   option structs, clock, packed readers/builder
  │   ├── cors.rs / proxy.rs / ip_trust.rs / rate_limit.rs / terminal.rs
  │   ├── output.rs       SINGLE NUMERIC SOURCE for the ingress binary layout
  │   └── ingress_constants.rs  NAPI projection of output.rs (single numeric source = output.rs)
  ├── test_support.rs     shared #[cfg(test)] helpers (pack_headers, decode_packed_pairs, Rng)
  └── unit_tests.rs       cross-module test suite
```

## Ingress: the two paths (do NOT conflate)

1. **`src/ingress/fast.ts`** — `createIngressFast(options)`. JS packs headers
   via `IngressInputPacker`, Rust parses via `handleRequestPacked`. Response
   bodies from `buildTerminalResponse`: `{"error":{code,status,message,requestId}}`,
   `x-ratelimit-*` headers.
2. **`src/ingress/handlers.ts`** — `createIngressHandler(options, runtime)` +
   route factories (`readHandler`, `headHandler`, `jsonWriteHandler`,
   `echoHandler`, `fallbackHandler`) + `createIngressServer()` (Bun.serve
   builder). JS packs the request frame (`IngressInputPacker` + packed headers
   via `gatherRawHeadersPacked`, keeping path 2's per-header size guards) and
   drives the SAME native core as path 1 (`handleRequestPacked`); the full_sync
   napi entries remain as compatible allocating / reusable-output wrappers.
   **Different wire format**: success = Rust-generated
   `{"ok":true,...,"requestId":...}`, errors =
   `{"ok":false,"error":{"code","message"}}`, `ratelimit-*` headers.

The HTTP benchmark server (`bench/servers/ingress-server.ts`) uses path 2 and
re-exports the pre-baked functions. **Do not unify the two formats** — the load
generator `bench/load.ts` requires `ok === true` + `requestId: string` on
success and `error.code` / `error.message` on errors (path 2's format).

> **Pooled output buffers (handlers.ts)**: `createIngressHandler` owns a
> `BufferPool` (`src/shared/buffer-pool.ts`) sized by `runtime.outputBufferSize`
> AND a reusable `IngressInputPacker`. `run()` packs the frame in JS (headers
> via `gatherRawHeadersPacked`, url/ip/rid encoded directly into the packer
> buffer), writes into a pooled buffer via `handleRequestPacked`, and passes the
> exact written subarray to `BakedIngressResult.refresh`. In copy mode the
> buffer is released at the end of `run()`; in zero-copy mode
> `ingress.zeroCopyResponse()` serves a `pooledBodyResponse` that keeps the
> buffer in flight until the body is consumed.

> Why the result decoders and header-template builders are NOT shared: although
> both paths decode the same Rust OUT_* layout, `FastIngressResult` and
> `BakedIngressResult` use different status normalization and expose different
> fields, and the two header-template builders emit different wire formats
> (`x-ratelimit-*` vs `ratelimit-*`). This is intentional — see the constraint
> above. What IS shared: `generateRequestId` (`src/shared/request-id.ts`).

## Hard constraints & gotchas

- **Node.js compatibility (Bun-first)**: `package.json` `exports` uses `types` /
  `bun` / `node` / `default` conditions. Bun resolves the `bun` condition → raw
  `index.ts` (zero startup cost — DO NOT point it at dist/). Node resolves `node` →
  `dist/index.js` (compiled ESM, built by `bun run build:js`), with bundled
  `dist/index.d.ts`. `dist/` is gitignored and NOT committed. Do NOT set
  `sideEffects: false` — importing the package eagerly dlopens the addon via
  `src/ingress/constants.ts`.
- **Runtime seam**: runtime detection lives ONLY in `src/shared/runtime.ts`
  (`isBun`/`isNode`). Do not sprinkle `typeof Bun` checks elsewhere. `createIngressServer`
  is Bun-only (throws on Node); Node users use `createIngressServerNode` (same route
  handlers via `buildRouteHandlers` in `server.ts`).
- **Addon loader** (`src/native/loader.ts`): resolves the `.node` from multiple roots so
  it works from BOTH the source layout (`src/native/…`) and the bundled layout
  (`dist/…`). Honor `CASTRUM_NATIVE_LIBRARY_PATH` / `NAPI_RS_NATIVE_LIBRARY_PATH`. Run
  `bun run bench:startup` after touching it.
- **Constants**: never hardcode binary-layout values. The single NUMERIC source is
  `rust/ingress/output.rs`; `rust/ingress/ingress_constants.rs` re-exports those
  values to JS via NAPI (`#[napi] pub const ... = crate::ingress::output::OUT_X
  as u32`), and `src/ingress/constants.ts` reads them. They cannot drift.
- **Ingress schema (fast path)**: `IngressInner.schema` is an `Option<Arc<IngressSchema>>`
  (rust/ingress/pipeline.rs) that precompiles BOTH the authoritative `jsonschema`
  validator AND the zero-DOM `fast_schema::FastNode` once at construction.
  `handle_packed` gates the body with `json_valid_bytes` (→ 400) then runs
  `IngressSchema::validate` (fast path; jsonschema DOM fallback for unsupported
  keywords) → 422. The fast_schema fast path MUST stay byte-parity with the
  jsonschema crate for supported keywords (see rust/json/fast_schema/tests.rs).
- **`tsconfig.json`** sets `noUncheckedIndexedAccess: true`. Indexed access on
  `Record<string, Uint8Array>` (e.g. `ERROR_BODIES.internal`) is
  `Uint8Array | undefined` — `handlers.ts` uses `!` where the key is guaranteed.
- **`bench/` IS typechecked by `tsc`** (in tsconfig `include`). `test/` is not —
  validate test files with the editor language server, and run
  `bun run bench:http:smoke` to confirm the servers still pass load checks.
- **Hot-path APIs (do not remove)**: `rust/ingress/mod.rs` (`Ingress`)::
  `handle_request_packed` (drives BOTH ingress paths — `fast.ts` packs headers
  via `packHeaders` and `handlers.ts` packs the full frame via
  `IngressInputPacker` + `gatherRawHeadersPacked`), `handle_request_full_sync`
  AND `handle_request_full_sync_into` (public compat wrappers — the latter is
  the reusable-output variant; keep `handleRequestFullSync` as the allocating
  compat wrapper), `rust/ingress/ingress_constants.rs`, sync `util/batch.rs`,
  `util/mod.rs::init_thread_pool`, and the scalar NAPI fns used by
  `src/bench/tasks/*`.
- **Rust crate history**: it is ONE cdylib crate (Cargo `[lib]` → `rust/lib.rs`).
  `rust/core/`, `export.rs`, `async_tasks.rs`, `ingress_async.rs` and the direct
  `tokio` dependency were **removed** — do not resurrect them.
- **Release profile** (Cargo.toml): `panic = "unwind"` (so napi `catch_unwind`
  turns panics into JS 500s), `overflow-checks = true`, `debug-assertions = false`.
- **mimalloc**: global allocator with `local_dynamic_tls`; do NOT enable the
  libc `override` interposition feature (embedding hazard).
- **jsonschema** dep uses `default-features = false, features = ["resolve-file"]`
  — keep the async HTTP/TLS stack out.
- **`.cargo/config.toml`** has NO hardcoded target flags (it only documents them in a
  comment). Published artifacts build for baseline x86-64 / aarch64. For LOCAL
  benchmarking use `bun run build:perf` (`scripts/build-perf.sh`), which compiles
  with `-C target-cpu=x86-64-v3` + avx2/bmi2/fma/sse4.2. Never commit those flags
  as the default and never use `build:perf` for publish.
- **Rate limiter**: 256 `Mutex<LruCache>` shards per limiter; limiters are
  **shared process-wide** via `SHARED_LIMITERS` (an `OnceLock<Mutex<LruCache>>`
  keyed by configuration, capped at 16 distinct configs) so the same config
  shares ONE budget across all routes/instances — this blocks route-splitting
  bypass (see SECURITY.md). Per-process, not distributed; monotonic `Instant` +
  one-time wall offset via `OnceLock`. Ingress stores it as a
  `RateLimiterState` enum (`Disabled`/`Enabled`) so the code can't have a
  "rate enabled but no limiter" state.
- **XFF / proxy trust**: empty `trustedProxies.networks` → trust NOTHING (safe
  default, not spoofable). The deprecated `trustProxy: true` boolean → trust
  EVERY hop (spoofable) and warns. The bench server's `INGRESS_TRUST_PROXY`
  defaults OFF; only enable behind a trusted edge.

## Editing conventions

- **TS**: explicit types on all public APIs; JSDoc (`@param`, `@returns`,
  `@example`) on exports; named imports; `camelCase` fns/vars, `PascalCase`
  types. One logical module per file.
- **Rust**: `rustfmt`, `cargo clippy` clean, `///` doc comments, snake_case.
  Keep NAPI types out of internal signatures so core logic stays testable.
- **Wire format is a contract**: changing success/error body shape or the
  `ratelimit-*` header names in `handlers.ts` breaks `bench/load.ts` checks and
  invalidates benchmark baselines.
- **Benchmark controls**: `CASTRUM_BENCH_BATCH_SIZE` (CPU-bench batch size for
  sub-µs ops; default 64), `HTTP_NO_SHAPE=1` (load generator skips response-shape
  `JSON.parse` for pure-throughput runs). `bun run check` persists a
  machine-readable CPU report to `bench/results/cpu/` (gitignored).
- **Performance-proven surface**: `src/shared/proven.ts` (`PROVEN_SURFACE`) is the
  single source of truth for which `rust.*` functions are exported via `proven`
  (only status === "proven"). The registry is PURE DATA (no addon imports) so
  `scripts/check-proven.ts` can audit it without dlopening. When you add/change a
  public function, update the registry and run `bun run check:proven:fail` on a
  RELEASE build (debug builds inflate rust timings). Classifications must reflect
  the shipped baseline-CPU release build, not the local SIMD `build:perf`.

## Testing

- **TS**: `bun test` (~255). Add tests under `test/unit/<area>/` (`ingress/`,
  `shared/`, `features/`).
- **Rust**: `cargo test`. New logic ships with a `#[cfg(test)] mod tests` block in
  the SAME module file (ingress.rs, url_codec.rs, validation.rs, proxy.rs,
  hmac_sha256.rs already do). Cross-module suites live in `rust/unit_tests.rs`;
  shared test helpers live in `rust/test_support.rs`.
- **HTTP**: after touching any server or `handlers.ts`, run
  `bun run bench:http:smoke` (or `SERVER=ingress SCENARIO=01-smoke bun run bench:http:smoke`)
  and confirm no `shape_failure` / `unexpected_status` in the report.
- **Startup**: after touching the addon loader (`src/native/index.ts`) or package
  entry, run `bun run bench:startup` to confirm import / first-call timing.

## Do NOT

- Resurrect removed Rust modules (`core/`, `export.rs`, `async_tasks.rs`, `ingress_async.rs`, `tokio`).
- Change the ingress wire format used by the benchmark server.
- Hardcode layout constants instead of reading them from `constants.ts`.
- Remove the hot-path NAPI APIs listed above.
