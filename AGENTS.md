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
| Build Rust addon (debug) | `bun run build:debug` |
| Rust unit tests | `cargo test` (~60 tests, `rust/unit_tests.rs`) |
| TS unit tests | `bun test` (~72 tests, `test/unit/**`) |
| CPU benchmark | `bun run check` (== `bun bench.ts`) — **not** a typecheck |
| Typecheck | `bunx tsc --noEmit` — **note**: `tsconfig.json` `include` is only `["index.ts", "bench.ts", "src"]`; `bench/` and `test/` are NOT typechecked here |
| HTTP bench (all servers) | `bun run bench:http` |
| HTTP bench (ingress only) | `bun run bench:http:ingress` |
| HTTP smoke (fast sanity) | `bun run bench:http:smoke` |
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
  Cargo.toml) and add a CHANGELOG entry before tagging.
- **Manual release (no tag-push dependency on CI's `publish` job):**
  `bun run publish:manual` (`scripts/publish-manual.mjs`) — builds the host addon,
  downloads the CI-built `addon-*` artifacts for the current `v<version>` tag via
  the GitHub CLI (`gh`), verifies every target is present, and runs
  `npm publish --access public`. It is NOT an escape hatch from the
  all-platforms rule: it requires a successful CI `build` run for the tag and still
  fails if any artifact is missing. Prereqs: `gh` authenticated, npm logged in; for
  the no-`--increment` resume path, a clean checkout of the exact tag. Use
  `bun run publish:manual -- --increment <patch|minor|major|...>` to bump the version
  and create + push the `v<version>` tag automatically via `bun pm version` (syncing
  `Cargo.toml`/`Cargo.lock`/`CHANGELOG.md`), wait for the CI `build` job, then
  publish. `--no-wait` pushes the tag and stops; `bun run publish:manual:dry`
  (`--dry-run`) runs the pipeline without publishing or touching git.

## Layout (quick map)

```
index.ts                  package entry (re-exports src/rust-ffi, src/baseline, src/ingress, ...)
bench.ts                  CPU benchmark entry -> src/bench
src/ingress/              HTTP ingress pipeline (TS layer)
  ├── constants.ts        binary-layout constants, read from Rust at runtime (SINGLE SOURCE OF TRUTH)
  ├── fast.ts             createIngressFast — packed-input path (handleRequestPacked)
  ├── handlers.ts         PRE-BAKED handlers — full_sync path (handleRequestFullSync); used by the bench server
  └── index.ts            public API: re-exports fast + handlers + async createIngress
src/native/index.ts       addon loader + IngressInstance type
src/rust-ffi/index.ts     flat Rust FFI API (`rust`)
src/baseline/             JS baseline implementations (benchmark reference, `native`)
src/bench/                CPU benchmark framework (tasks, measure, report, ...)
src/data, src/shared/     JSON rows + bytes/packed helpers
bench/servers/            bun-server.ts, elysia-server.ts, ingress-server.ts (HTTP bench)
bench/load.ts             HTTP load generator + scenarios; validates response SHAPE
test/unit/                TS tests (ingress/fast, shared/packed, shared/bytes)
rust/                     single cdylib crate, one module per area (lib.rs declares mods)
```

## Ingress: the two paths (do NOT conflate)

1. **`src/ingress/fast.ts`** — `createIngressFast(options)`. JS packs headers
   via `IngressInputPacker`, Rust parses via `handleRequestPacked`. Response
   bodies from `buildTerminalResponse`: `{"error":{code,status,message,requestId}}`,
   `x-ratelimit-*` headers.
2. **`src/ingress/handlers.ts`** — `createIngressHandler(options, runtime)` +
   route factories (`readHandler`, `headHandler`, `jsonWriteHandler`,
   `echoHandler`, `fallbackHandler`) + `createIngressServer()` (Bun.serve
   builder). Rust packs internally via `handleRequestFullSync`. **Different
   wire format**: success = Rust-generated `{"ok":true,...,"requestId":...}`,
   errors = `{"ok":false,"error":{"code","message"}}`, `ratelimit-*` headers.

The HTTP benchmark server (`bench/servers/ingress-server.ts`) uses path 2 and
re-exports the pre-baked functions. **Do not unify the two formats** — the load
generator `bench/load.ts` requires `ok === true` + `requestId: string` on
success and `error.code` / `error.message` on errors (path 2's format).

## Hard constraints & gotchas

- **Constants**: never hardcode binary-layout values. Source of truth is
  `rust/ingress_constants.rs` → exported via NAPI → `src/ingress/constants.ts`.
- **`tsconfig.json`** sets `noUncheckedIndexedAccess: true`. Indexed access on
  `Record<string, Uint8Array>` (e.g. `ERROR_BODIES.internal`) is
  `Uint8Array | undefined` — `handlers.ts` uses `!` where the key is guaranteed.
- **`bench/` is not typechecked by `tsc`** (not in tsconfig `include`). Validate
  bench files with the editor language server, and run `bun run bench:http:smoke`
  to confirm the servers still pass load checks.
- **Hot-path APIs (do not remove)**: `ingress.rs::handle_request_packed`
  (fast.ts) and `handle_request_full_sync` (handlers.ts), `ingress_constants.rs`,
  sync `batch.rs`, `util.rs::init_thread_pool`, and the scalar NAPI fns used by
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
- **`.cargo/config.toml`** hardcodes `-C target-cpu=x86-64-v3` + avx2/bmi2/fma/sse4.2
  for x86_64 linux+darwin — machine-local; no aarch64 equivalent. Don't rely on it.
- **Rate limiter**: 256 `Mutex<LruCache>` shards, `Arc<KeyedRateLimiter>` per
  ingress instance (NOT shared across routes), per-process (not distributed);
  monotonic `Instant` + one-time wall offset via `OnceLock`.
- **XFF / proxy trust**: empty trusted networks → `ProxyTrustMode::All`
  (trust everything → spoofable). The bench server's `INGRESS_TRUST_PROXY`
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

## Testing

- **TS**: `bun test`. Add tests under `test/unit/<area>/`. Only `test/unit/*`
  currently has files (`ingress/fast`, `shared/packed`, `shared/bytes`).
- **Rust**: `cargo test` — core logic in `rust/unit_tests.rs`, wired from
  `lib.rs` via `#[cfg(test)] mod unit_tests;`.
- **HTTP**: after touching any server or `handlers.ts`, run
  `bun run bench:http:smoke` (or `SERVER=ingress SCENARIO=01-smoke bun run bench:http:smoke`)
  and confirm no `shape_failure` / `unexpected_status` in the report.

## Do NOT

- Resurrect removed Rust modules (`core/`, `export.rs`, `async_tasks.rs`, `ingress_async.rs`, `tokio`).
- Change the ingress wire format used by the benchmark server.
- Hardcode layout constants instead of reading them from `constants.ts`.
- Remove the hot-path NAPI APIs listed above.
