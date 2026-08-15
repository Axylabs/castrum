# AGENTS.md — castrum

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs live in `README.md` and `docs/`;
`docs/FFI_BUN_GUIDE.md` is the canonical "writing Rust for Bun" reference
(ABI types, `buffer`/`buffer_length`, pointer/cstring semantics, panic
containment, self-test, dlopen lifetime) — read it before adding a `castrum_*`
export or touching `src/native/ffi.ts`.

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
| Rust unit tests | `cargo test` (~440 tests; per-module `#[cfg(test)] mod tests` + `rust/unit_tests.rs`) |
| TS unit tests | `bun test` (~540 tests, `test/unit/**`) |
| CPU benchmark | `bun run check` (== `bun bench.ts`) — **not** a typecheck |
| Bun built-ins diagnostic set | part of `bun run check` — `diag:` task names (bun-builtins.ts), NEVER audited by check:proven; decision matrix in docs/bun-builtins-decision-matrix.md |
| Proven-surface audit | `bun run check:proven` (report) / `bun run check:proven:fail` (CI gate) |
| Startup / first-call benchmark | `bun run bench:startup` |
| FFI transport benches | `bun run bench:ffi` / `bench:ffi:load` / `bench:ffi:public` / `bench:ffi:workers` |
| Native batch parity check | `bun run verify:native:batch` |
| Typecheck | `bun run typecheck` (== `bunx tsc --noEmit`; `include` = index.ts, bench.ts, src, bench) + `bun run typecheck:test` (== `bunx tsc --noEmit -p tsconfig.test.json`; typechecks `test/` + `bench/` with unused locals/params on) |
| JS lint / format (Biome) | `bun run lint` / `bun run lint:fix` / `bun run format` |
| Version consistency | `bun run check:version` (package.json ↔ Cargo.toml ↔ CHANGELOG) |
| JSDoc coverage guard | `bun run check:jsdoc` (== `bun scripts/check-jsdoc.ts`) — fails if < 70% of `src/`+`index.ts` exported symbols lack a JSDoc block; run after adding public exports |
| JS dependency audit | `bun run audit` |
| Cargo deny audit | `bun run deny` (== `cargo deny check`) |
| Coverage floors | `bun run test:coverage` (== `node scripts/check-coverage.mjs`) — 75% overall line floor + a 50% per-directory floor on the SHIPPED dirs (`src/ingress`, `src/shared`, `src/rust-ffi`, `src/native`, `src/loader`, `src/integration`) so one directory can't collapse while others compensate |
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
  ├── metrics.ts          createIngressMetrics (hook wiring) + metricsHandler (/metrics Prometheus text)
  ├── health.ts           livenessHandler / readinessHandler / healthHandler probe factories
  ├── shared.ts           JS constants shared by both paths (METHOD_KIND, DEFAULT_MAX_BODY_BYTES, HeaderPlan)
  ├── status.ts           status normalization helpers (both paths)
  ├── errors.ts           fast-path error-code name/message mapping
  ├── options.ts          IngressFast option types + fail-fast validation + trustProxy deprecation warning
  ├── types.ts            public API types (IngressOptions/Result/Context/...)
  ├── body.ts             streaming request-body reader (async API; size guard + bodyTimeoutMs)
  ├── context.ts          result snapshot + synthetic/internal context builders
  ├── server.ts           createIngressServer (Bun.serve) + buildRouteHandlers (shared) + gracefulShutdown
  ├── server-node.ts      createIngressServerNode (node:http adapter, same route handlers;
  │                       WebSocket `upgrade` + 431 on header overflow + keep-alive body drain)
  ├── router.ts           createIngressRouter — per-route compiled ingress (each route compiles its
  │                       OWN native IngressInner from per-route options + per-route HeaderPlan +
  │                       optional pre-warm; same wire format as handlers.ts; the bench server has a
  │                       router variant at bench/servers/router-server.ts). Supersedes the deleted
  │                       rust/route.rs (dead external-project wire — do NOT resurrect it).
  ├── packing/            header-packing.ts (fast) + input-packer.ts + gather-raw-headers.ts (pre-baked) + scratch.ts (shared TLS buffers + per-header size guards)
  ├── headers/            cors.ts + hsts.ts + fast-templates.ts + baked-templates.ts (two template builders, NOT unified)
  ├── decode/             fast-result.ts + baked-result.ts (two decoders, NOT unified) + packed-sections.ts (shared section layout)
  ├── response/           terminal.ts (fast) + error-bodies.ts (pre-baked)
  ├── routes/             read/head/json-write/echo/delete/options/fallback factories + common.ts
  ├── fast.ts             thin: createIngressFast (packed-input path, handleRequestPacked) + re-exports
  ├── handlers.ts         thin: createIngressHandler (packed-input path: frame packed in
  │                       JS via IngressInputPacker + gatherRawHeadersPacked, driven by
  │                       handleRequestPacked, pooled output); used by the bench server
  └── index.ts            barrel: public API + async createIngress + re-exports
src/native/               native transport layer: types.ts (NativeAddon module surface) + types/instances.ts (per-class
                          INSTANCE types, merged single AcceptNegotiatorInstance) + loader.ts (getAddonPath/getAddon/lazyAddon) +
                          ffi.ts (Bun PRIMARY bun:ffi C-ABI transport over rust/ffi.rs; lazy bind + bind-time self-test +
                          CASTRUM_FFI_MODE gating + castrum_ingress_layout blob + growExact needed-size retry for variable-size
                          outputs; napi is the FALLBACK) + ffi/{types,constants,selftest}.ts + index.ts barrel
src/rust-ffi/             flat Rust FFI API (`rust`), decomposed: options.ts + addon.ts + context.ts (resolveNative/resolvePoolNative
                          shared first-use caches) + text.ts + batch/ (types.ts interface + build.ts impl + index.ts barrel) +
                          packed.ts + scalar/ (interface + hashing/json/http/crypto/payload/factories builders) + client.ts +
                          proven.ts + index.ts barrel
src/shared/request-id.ts  shared zero-alloc request ID generator (both ingress paths) — aliased buffer hazard documented
src/shared/metrics.ts     zero-dep metrics registry (counters/gauges/histograms + Prometheus render)
src/shared/trace.ts       W3C traceparent/span-id helpers (tracing correlation)
src/shared/uuid.ts        uuidv7() — delegates to Bun.randomUUIDv7, crypto.randomUUID on Node
src/shared/buffer-pool.ts  generic reusable byte-buffer pool (pooled output buffers, zero-copy borrows)
src/shared/response.ts     pooledBodyResponse: Response that returns a pooled buffer on body consumption
src/shared/env.ts          centralized env-var alias resolution (CASTRUM_* + legacy RUST_BENCH_*/RUST_* names)
src/shared/packed/        packed wire-format helpers (split from the old packed.ts monolith):
  ├── wire.ts             PURE byte encode/decode (u32/bitset/i64/byte-results/multipart, pairs, pack-scratch pool) — NO addon dlopen
  ├── schema.ts           SchemaValidator alias + schemaValidateBatch/Count (uses wire.ts scratch)
  ├── parsers.ts          lazy-addon ergonomic string parsers (parseQueryString/parseCookieHeader/parseFormBody)
  └── index.ts            barrel re-export (existing `../shared/packed` imports unchanged)
src/loader/               higher-order loader (HFC) over the curated op set (ops/cost/batch/index) — exported from index.ts
src/integration/          framework-agnostic helpers: createPipeline, createWebSocketUpgrade, sseResponse — exported from index.ts
src/baseline/             JS baseline implementations (benchmark reference, `native`)
src/bench/                CPU benchmark framework (tasks, measure, report, ...)
  ├── raw-native.ts       RAW addon accessors (FFI-first/napi) for ops whose public
  │                       rust.* delegates to Bun under Bun — the CPU bench `rust:`
  │                       column must measure the ADDON, not the delegated built-in
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
  ├── ffi.rs              `#[no_mangle] extern "C"` exports (75 castrum_* — 67 direct + 4
                          validator_c_abi! + 4 compress_to_out! — incl. the
                          castrum_gzip_isize size probe; parity guarded by
                          test/unit/features/ffi-symbol-parity.test.ts) for Bun's `bun:ffi`
                          C-ABI PRIMARY transport (scalar hot fns + ingress layout blob;
                          SAME cdylib serves both napi on Node/fallback and bun:ffi on Bun
                          — see src/native/ffi.ts).
                          VARIABLE-SIZE convention: return the EXACT required byte count on a
                          too-small buffer (0 = real error) so JS allocates once and retries at
                          most once (no grow-retry re-run loop).
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
  │   ├── bcrypt.rs       bcrypt PHC `$2b$` hashing/verify (passwordHashBcrypt)
  │   ├── pbkdf2.rs       PBKDF2-HMAC-SHA256 (pbkdf2Sha256)
  │   ├── base64.rs       base64/base64url/hex + Base64Codec
  │   ├── hashing.rs      FNV-1a / XXH3 / crc32
  │   └── random_token.rs random hex tokens
  ├── json/               JSON & SCHEMA
  │   ├── json_ops.rs     zero-DOM validate/sum + DOM parse (sonic Value → JS via napi_marshal)
  │   ├── napi_marshal.rs sonic_rs::Value → napi JsUnknown walker (sonic_value_to_js,
  │   │                   napi serde-json Number parity) + sonic_values_equal (jsonschema
  │   │                   cmp::equal, insertion-order object keys) — shared by jwt_verify,
  │   │                   json_parse and fast_schema enum/const/uniqueItems
  │   ├── json_ser.rs     zero-alloc JSON escaping + cookie/query → JSON writers
  │   ├── json_patch_ops.rs  CUSTOM sonic RFC 6902 JSON patch engine (Pointer ~0/~1
  │   │                   unescape + PatchOp add/remove/replace/move/copy/test incl.
  │   │                   array `-`/bounds + 1==1.0; serde_json-DOM json-patch/jsonptr
  │   │                   deps REMOVED). Same JsonPatchError semantics + size guards +
  │   │                   packed batch entry points as before
  │   ├── json_schema.rs  SchemaValidator napi class (fast path + jsonschema-crate fallback; 
  │   │                   also SchemaValidator.derive — one-pass validate + extract)
  │   └── fast_schema/    zero-DOM draft-07 JSON Schema fast path: mod.rs (re-exports compile/FastNode + SchemaError)
  │       └── types.rs / cursor.rs / compile.rs / validate.rs / errors.rs / capture.rs (one-pass derive trie) /
  │           email.rs (format:"email" replica) / tests.rs
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
  └── proptest_suite.rs   #[cfg(test)] property-based adversarial-parser tests (dev-dep proptest)
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

- **sonic-rs `sort_keys` determinism**: sonic's owned `Value` backs MUTABLE
  objects with `AHashMap` — iteration order is non-deterministic. The crate
  enables the `sort_keys` feature (`Cargo.toml`) so mutation switches the owned
  map to `BTreeMap` → deterministic sorted serialization. This is a hard wire
  requirement: JWT sign (iat/exp injection via `inject_and_payload_b64_sonic`)
  and the RFC 6902 patch engine must emit byte-identical output across the
  FFI/napi/scalar/bulk transports (pinned by `ffi.test.ts` + `loader.test.ts`).
  Parsed (unmutated) values keep the shared Vec (insertion order) — only
  `as_object_mut()` + `insert` switches to the map — so `sonic_values_equal`
  and `sonic_value_to_js` (which iterate `as_ref()`) keep insertion-order
  semantics. Do NOT remove `sort_keys` without re-pinning every byte-parity
  test, and do NOT write new code that mutates a sonic Value and expects
  insertion-order output.
- **Node.js compatibility (Bun-first)**: `package.json` `exports` uses `types` /
  `bun` / `node` / `default` conditions. Bun resolves the `bun` condition → raw
  `index.ts` (zero startup cost — DO NOT point it at dist/). Node resolves `node` →
  `dist/index.js` (compiled ESM, built by `bun run build:js`), with bundled
  `dist/index.d.ts`. `dist/` is gitignored and NOT committed. Do NOT set
  `sideEffects: false` — importing the package eagerly dlopens the addon via
  `src/ingress/constants.ts`.
- **Runtime seam**: runtime detection lives ONLY in `src/shared/runtime.ts`
  (`isBun`/`isNode`). Do not sprinkle `typeof Bun` checks elsewhere. `createIngressServer`
  guards on `isBun()` and throws a friendly error on Node (it builds a Bun.serve config);
  Node users use `createIngressServerNode` (same route handlers via `buildRouteHandlers`
  in `server.ts`). `BakedServer.port` is the ACTUAL bound port (Bun exposes it even with
  `port: 0`; the Node adapter reports it via `ready`/getter).
- **String-return contract (Bun vs Node)**: text-returning `rust.*` ops return JS
  **strings** on the `bun:ffi` path (cstring → `CString`) and **bytes** under napi (Node /
  `CASTRUM_FFI_MODE=napi`). The TS surface types `Uint8Array | string`. Normalize with
  `toBytes` / `toText` (`src/shared/bytes.ts`); `encoder.encode` / `decoder.decode` accept
  the union. The `*Into`/pooled variants always return bytes. `TextEncoder`/`TextDecoder`
  must only appear in the Node-fallback branches of `src/shared/codec.ts` — do not reintroduce
  them on the Bun path. See `docs/API.md` §Runtime return-type divergence.
- **Addon loader** (`src/native/loader.ts`): resolves the `.node` from multiple roots so
  it works from BOTH the source layout (`src/native/…`) and the bundled layout
  (`dist/…`). Honor `CASTRUM_NATIVE_LIBRARY_PATH` / `NAPI_RS_NATIVE_LIBRARY_PATH`. A
  SET-but-misconfigured override throws (never silently falls through to the package
  roots). Run `bun run bench:startup` after touching it.
- **Bun FFI behavior (learned from Bun 1.3.14 — see `docs/FFI_BUN_GUIDE.md`)**:
  - Hot `bun:ffi` call sites JIT through DFG/FTL into direct native calls (~10–20ns);
    keep `extern "C"` signatures scalar + `(ptr,len)` — no struct-by-value (not
    supported by `bun:ffi`), no variadics, no callbacks in hot paths.
  - `buffer`/`buffer_length` (FFIType 20/21) is an atomic ptr+byteLength snapshot of
    the SAME view at call time; `src/native/ffi.ts` probes it and rewrites every
    `(ptr,usize)` pair via `abi()`/`lenOrView`. Keep the probe — never hardcode the
    pair as the only path.
  - Pointers are JS `number` (53-bit), not BigInt; `u64`/`i64` returns box to BigInt
    unless bound `u64_fast`/`i64_fast`. Byte-count returns MUST use `u64_fast`
    (`U64_FAST` in ffi.ts); opaque handles pass as `usize`/number (`Number(innerPtr())` once).
  - `cstring` returns are cloned at call time (NULL → null) — per-thread reused
    `CSTR_BUF` is safe; never return a pointer into JS-owned/argument memory.
  - Never `close()` a dlopen'd library while bound symbols are live (Bun leaks by
    design; dlclose-on-GC is unsound). `getBunFFI()` binds once and holds forever.
  - Symbols are shared across Worker threads → thread-local caches only
    (`HMAC_KEY_CACHE`, `CSTR_BUF`), no global mutable state on the C-ABI path.
  - Every new `castrum_*` export: `panic_guard` (catch_unwind) on fallible cores,
    null-check pointers + opaque handles, bind-time self-test, `u64_fast` byte counts,
    add to the dlopen map + `ffi/types.ts` + parity test.
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
  **Draft-07 is pinned**: jsonschema 0.48's DEFAULT draft (no `$schema`) is
  2020-12, whose `items`/`$ref`-sibling/boolean-exclusive semantics differ from
  the fast path's draft-07 — so `SchemaValidator` and `IngressSchema` build the
  reference with `.with_draft(Draft7)`, keeping both paths consistent for
  schemas without a `$schema`. A schema's declared `$schema` still overrides
  (and the fast path falls back for non-draft-07 declarations).
  **Fast-path coverage** (draft-07 validation keywords): type, enum, const,
  multipleOf, numeric bounds, min/maxLength, `pattern`/`patternProperties`
  (fancy-regex = jsonschema's engine), items (single + tuple), additionalItems,
  min/maxItems, uniqueItems, contains, min/maxProperties, required, properties,
  additionalProperties, dependencies (array form), if/then/else, allOf, anyOf,
  oneOf, not, in-document `$ref`, format:"email". Falls back: propertyNames,
  dependencies-with-schema, boolean exclusive bounds, other formats,
  remote/dynamic/anchor refs. `format: "email"` is fast-path supported via
  `rust/json/fast_schema/email.rs` (a byte-parity replica of jsonschema 0.48.5's
  `is_valid_email`). NOTE: jsonschema 0.48 disables format validation by default
  (`validator_for`), so BOTH `SchemaValidator` (json_schema.rs) and
  `IngressSchema` build the reference with `should_validate_formats(true)`.
  Detailed errors: `SchemaValidator.validateDetailed` / `validateFirstError`
  return jsonschema-style errors (instance + schema JSON pointers, keyword,
  message) from the zero-DOM path (`validate_errors`).
  **Nesting-depth cap**: the fast path bounds recursion at 128 levels
  (`MAX_DEPTH`, rust/json/fast_schema/errors.rs) — matching sonic-rs (the
  ingress `json_valid_bytes` gate) and serde_json (the DOM reference), so deeper
  documents are rejected rather than stack-overflowing the process (an
  uncatchable abort). Both the schema walk (`validate`) and the structural
  `skip_value` path are guarded. Do NOT raise the cap without matching the
  reference — deeper docs would diverge from the DOM path's parse-fail → invalid.
  **One-pass derive (`SchemaValidator.derive`, rust/json/fast_schema/capture.rs)**: validate a
  document AND capture scalar values / array lengths at object-key JSON-pointer paths during the
  SAME walk — replaces `JSON.parse` + Ajv for derive-pattern routes (response built from a few
  body fields) and rejects invalid bodies with zero DOM/GC. Target paths compile to a TRIE; the
  walk tracks `(node, alive)` per object level (no per-member key cloning; dead subtrees free).
  Capture is OFF by default (`Ctx::capture == None`) so bool/detailed hot paths are unchanged —
  keep it that way, and keep the ROOT-cursor-only + `suppress` guards (sub-scan offsets are
  relative to sub-slices and must never corrupt captured ranges). Paths are object-key pointers;
  array-index steps and `/-`-root are rejected.
- **Decompression cap**: `rust.gzipDecompress` / `rust.brotliDecompress` (and
  `batch.*`) cap decompressed output at 64 MiB by default (`maxDecompressed` napi
  param, `Option<u32>`, rust/payload/compress.rs). This is a decompression-bomb
  guard — do not remove it or raise the default without benchmarking. Keep the
  `.take(cap + 1)` bounded read + length check (post-read length checks alone
  still allocate the full bomb).
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
  `src/bench/tasks/*`. ALSO `rust/ffi.rs` (`castrum_*` C ABI exports) +
  `src/native/ffi.ts` (Bun `bun:ffi` — the PRIMARY transport on Bun; NAPI is
  the fallback for Node / `CASTRUM_FFI_MODE=napi` / self-test failure): the
  bind-time self-test is the safety net — do not remove it, `CASTRUM_FFI_MODE`
  gating, or the napi fallback. Any `castrum_*` export that runs a fallible /
  allocating core MUST route it through `panic_guard` (`catch_unwind` in
  rust/ffi.rs): the raw C ABI has no napi-style unwind guard, so an uncaught
  panic unwinds through `extern "C"` and kills the whole Bun process (this is
  how the ingress server died under `11-concurrent-burst`). The bind-time
  self-test must cover any new C-ABI symbol.
  - `castrum_json_sum_ids` uses a **packed `[u8 ok][i64 sum LE]` output** (9 B:
    1 = valid array — the sum may be 0 —, 0 = invalid; return 9/1/0 bytes): the
    old scalar-i64 ABI (0 for both a legit zero-sum and invalid input) forced
    the JS builder to re-dispatch to napi on every 0n. Keep the ok byte.
  - Repeated same-secret HMAC/CSRF/cookie calls reuse a compiled key via the
    **per-thread `HMAC_KEY_CACHE` LRU** (rust/ffi.rs, cap 16): the C-ABI
    equivalent of the compiled-once `HmacSigner`. Keep it thread-local (zero
    lock contention across Bun Worker threads) and owned (no dangling handles).
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
  bypass (see SECURITY.md). A (cap+1)th distinct config THROWS at construction
  rather than silently evicting a live limiter (eviction would reset per-IP
  budgets — a bypass vector). Per-process, not distributed; monotonic `Instant` +
  one-time wall offset via `OnceLock`. Ingress stores it as a
  `RateLimiterState` enum (`Disabled`/`Enabled`) so the code can't have a
  "rate enabled but no limiter" state.
- **CORS headers**: the Rust `CorsOptions` carries only what the engine EVALUATES
  (origin/methods/headers/credentials); the emitted `access-control-expose-headers` /
  `access-control-max-age` come from the TS header templates (both paths read the same
  `cors` option object).
- **XFF / proxy trust**: empty `trustedProxies.networks` → trust NOTHING (safe
  default, not spoofable). The deprecated `trustProxy: true` boolean → trust
  EVERY hop (spoofable) and warns. The bench server's `INGRESS_TRUST_PROXY`
  defaults OFF; only enable behind a trusted edge.

## Purity & side-effect policy

The codebase is **pure by default**: byte-wire helpers, decoders, packers,
header templates, status mapping, and route factories are side-effect-free
functions of their inputs. Side effects are **deliberately contained** to an
explicit impurity boundary so the hot path can pool/globalize state:

- **Impure (singletons / I/O / process state)** — keep ALL of it inside these
  modules, never spread elsewhere:
  - `src/native/loader.ts` + `src/native/ffi.ts` + `src/native/ffi/selftest.ts` — dlopen, lazy addon, bind-time self-test
  - `src/shared/buffer-pool.ts` + `src/shared/response.ts` — pooled output buffers / borrowed bodies
  - `src/shared/packed/parsers.ts` — lazy `addon` binding (the ONLY non-pure member of `packed/`)
  - `src/loader/index.ts` — dispatch core + configure rebinding
  - `src/rust-ffi/context.ts` — `resolveNative`/`resolvePoolNative` first-use caches
  - `src/ingress/server.ts` / `server-node.ts` — socket I/O; the rate limiter's
    process-wide `SHARED_LIMITERS` and the FFI `HMAC_KEY_CACHE` live in Rust
- **Pure (no addon, no module state)** — new code should land here: `wire.ts`
  decode/encode, `bytes`/`codec`/`request-id`/`trace`/`uuid` helpers, the
  `ingress/decode/*` + `ingress/headers/*` + `ingress/response/*` builders, and
  route factories in `ingress/routes/*`.
- **Rule**: a module in a PURE role must not `import` from `src/native/` (the
  dlopen layer) or `src/shared/buffer-pool.ts`. If it needs the addon, it is
  impure by definition and belongs in the boundary (or takes the resolved fn as
  a parameter — dependency injection keeps it composable AND testable).
- This is a documented contract, not yet machine-enforced; keep the `packed/`
  split as the model (pure `wire.ts` vs lazy `parsers.ts`).

## Editing conventions

- **TS**: explicit types on all public APIs; JSDoc (`@param`, `@returns`,
  `@example`) on exports; named imports; `camelCase` fns/vars, `PascalCase`
  types. One logical module per file. Every exported symbol in `src/` +
  `index.ts` needs a JSDoc block — `bun run check:jsdoc` enforces a 70%
  floor (run it after adding public exports). Preserve the `// src/... — purpose`
  module-header convention on every file, and keep barrel `index.ts` files as
  lightweight re-export hubs (a 1-line header is enough).
- **Rust**: `rustfmt`, `cargo clippy` clean, `///` doc comments, snake_case.
  Keep NAPI types out of internal signatures so core logic stays testable.
- **Wire format is a contract**: changing success/error body shape or the
  `ratelimit-*` header names in `handlers.ts` breaks `bench/load.ts` checks and
  invalidates benchmark baselines.
- **Benchmark controls**: `CASTRUM_BENCH_BATCH_SIZE` (CPU-bench batch size for
  sub-µs ops; default 64), `HTTP_NO_SHAPE=1` (load generator skips response-shape
  `JSON.parse` for pure-throughput runs). `bun run check` persists a
  machine-readable CPU report to `bench/results/cpu/` (gitignored).
- **Performance-annotated surface**: `src/shared/proven.ts` (`PROVEN_SURFACE`) is the
  single source of truth for the benchmark classifications. `proven`
  (`src/rust-ffi/proven.ts`) exports the FULL `rust.*` surface (`export const proven =
  rust`) — the `@performance`/`@deprecated` JSDoc annotations (generated by
  `bun run check:annotate`) are what communicate performance now, NOT a curated
  subset. The registry is PURE DATA (no addon imports) so `scripts/check-proven.ts`
  can audit it without dlopening. When you add/change a public function, update the
  registry and run `bun run check:proven:fail` on a RELEASE build (debug builds
  inflate rust timings). Classifications must reflect the shipped baseline-CPU
  release build, not the local SIMD `build:perf`.
- **Bun delegation (`BUN_WINS`, src/selection.ts)**: the public `rust.*` scalar
  surface is OPTIMAL-BY-DEFAULT under Bun — `urlEncode`/`urlDecode`
  (`encodeURIComponent`/`decodeURIComponent`), `base64Encode` (Buffer), `httpDate`
  (`Date.toUTCString()`), `crc32`/`xxh3` (`Bun.hash.*`), `hmacSha256`
  (`Bun.CryptoHasher`, hex re-encoded), `randomToken` (`crypto.getRandomValues` +
  hex) and `gzipCompress` (`Bun.gzipSync`) all delegate to Bun built-ins when
  `isBun()`. **`gzipDecompress` is deliberately NOT delegated** (stays native —
  `Bun.gunzipSync` has no decompression-bomb cap; the native 64 MiB cap is kept).
  Keep `src/selection.ts` `BUN_WINS` in sync with the actual surface. The CPU
  bench measures the RAW addon for delegated ops via `src/bench/raw-native.ts`
  (FFI-first/napi) so the report + PROVEN_SURFACE reflect the addon, not the
  delegated built-in. Parity is pinned by `test/unit/features/delegation.test.ts`.

## Testing

- **TS**: `bun test` (~540). Add tests under `test/unit/<area>/` (`ingress/`,
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
