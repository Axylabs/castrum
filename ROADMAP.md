# castrum Roadmap

**Status**: pre-0.10.0 (v0.9.1 shipped). The engine (Rust cdylib via napi-rs)
is feature-complete for its surface; the roadmap is dominated by hardening,
observability, distribution, and governance.

Legend: ✅ done · 🔜 planned · ⏳ in progress · 💤 not started

## 1. Fix broken tooling (✅ v0.9.0)
- ✅ `check:version` — CHANGELOG released-section alignment (0.9.0).
- ✅ Dual-binary v3 loader — `build:v3` ships a `castrum.linux-x64-v3-gnu.node`
  SIMD variant; the loader CPU-detects AVX2+BMI2+FMA+SSE4.2 from `/proc/cpuinfo`.
- ✅ Native route stack (`rust/ingress/native_route.rs`) — the route-wire v3
  contract consumed by `@ignex/native` (per-route compiled ingress).
- ✅ Runtime adapter seam (`src/runtime/`) — runtime detection, builtin delegation,
  and the runtime-adaptive public `createIngressServer`.

## 2. Don't reinvent the wheel — Bun built-ins audit (✅ v0.9.0)
- ✅ Diagnostic benchmark set (`diag:` tasks) racing castrum vs `Bun.hash`,
  `Bun.password`, `Bun.CryptoHasher`, `Bun.gzipSync`, `Bun.randomUUIDv7`.
- ✅ `docs/bun-builtins-decision-matrix.md` — keep/delegate/add decisions.
- ✅ New primitives: `rust.xxh3`, `rust.passwordHashBcrypt`/`verifyBcrypt`,
  `rust.pbkdf2Sha256`, `uuidv7()` (TS delegate).
- ✅ Selection layer (`opImpl` / `isNativeOp` / `opDecision`, `src/selection.ts`)
  applies the keep/delegate decisions at load time.

## 3. Enterprise observability (✅ v0.9.0)
- ✅ Zero-dep metrics registry (`createMetrics`) + Prometheus render.
- ✅ Ingress metrics wiring (`createIngressMetrics`) + `/metrics` route factory.
- ✅ Health probes (`livenessHandler` / `readinessHandler` / `healthHandler`).
- ✅ W3C trace context (`parseTraceParent` / `createTraceId` / `createSpanId`).
- ✅ Wire `/metrics` + `/healthz` `/readyz` `/livez` into the benchmark server
  and the example app.
- 🔜 Optional OpenTelemetry exporter adapter over the same registry.

## 4. Security hardening (🔜)
- 💤 cargo-fuzz targets for the wire parsers (headers, multipart, JSON
  fast-schema cursor, URL percent-decode, query/cookie, packed iterators).
- ✅ proptest property tests (`rust/proptest_suite.rs`) — adversarial bytes
  must never panic across the header/query/percent-decode/fast-schema parsers.
- 💤 Sanitizer (ASan) + Miri CI jobs on the zero-copy/`unsafe` paths.

## 5. Distribution & supply chain (🔜)
- ✅ musl targets added to `napi.targets` + CI build matrix.
- ✅ SLSA build-provenance attestation + SBOM on the publish job (CI config).
- ✅ Cut v0.9.0 (tag + publish dry-run), flip local consumers' `file:` dev deps
  to a real version range, verify the installed-tarball native path in CI.

## 6. Governance (🔜)
- ✅ CODE_OF_CONDUCT, issue/PR templates, ROADMAP.
- ✅ ADRs (two-wire-format, zero-DOM fast path, Bun-builtins delegation) —
  see `docs/adr/` (0001-two-wire-formats, 0002-zero-dom-fast-schema,
  0003-bun-builtins-delegation).
- 🔜 API-reference site generated from `dist/index.d.ts`.

## 7. Runtime self-optimization (🔜)
- ✅ Higher-order loader (44 ops) wired into the integration layer
  (`validateMany` / `validateCount` / `runMany` / `runOne`) + `examples/loader-demo.ts`.
- ✅ `warmOnCreate` first-request priming + persisted startup baseline
  (`bench/results/startup/`).
- ✅ `AdaptiveEstimate` (bounded EWMA) + `BufferPool` adaptive sizing.
- 🔜 **Worker-thread offload for CPU-heavy ops** — a persistent Bun Worker pool
  behind a NEW additive async surface (e.g. `rust.offload.*`: compression,
  big batches, schema) that keeps the existing synchronous contracts
  unchanged. The loader's coalescing + the worker pool in
  `src/bench/concurrent-worker.ts` are the reference patterns. Deferred: it is
  the largest additive surface and must not perturb the sync hot path or the
  wire format (AGENTS.md).
- 🔜 Runtime-managed multi-process scaling (`SO_REUSEPORT`): auto-spawn N
  workers keyed to core count (per-worker `INGRESS_WORKER_ID`), currently
  manual — see docs/INGRESS.md.

## Out of scope (deliberate)
- Live `npm publish` (manual gate; requires `NPM_TOKEN`).
- Removing/deprecating any hot-path napi API (see AGENTS.md — hard constraint).
- Distributed rate-limit/jobs stores in the engine itself (per-process documented
  behavior preserved; pluggable stores belong to the framework layer).
