# castrum Roadmap

**Status**: v0.9.0 (working tree), pre-1.0. The engine (Rust cdylib via napi-rs)
is feature-complete for its surface; the roadmap is dominated by hardening,
observability, distribution, and governance.

Legend: ✅ done · 🔜 planned · ⏳ in progress · 💤 not started

## 1. Fix broken tooling (✅ v0.9.0)
- ✅ `check:version` — CHANGELOG released-section alignment (0.9.0).
- ✅ Proven registry cleanup (misplaced `createSchemaValidator` banner).
- ✅ Annotation `fileForName` map — extended for new primitives.

## 2. Don't reinvent the wheel — Bun built-ins audit (✅ v0.9.0)
- ✅ Diagnostic benchmark set (`diag:` tasks) racing castrum vs `Bun.hash`,
  `Bun.password`, `Bun.CryptoHasher`, `Bun.gzipSync`, `Bun.randomUUIDv7`.
- ✅ `docs/bun-builtins-decision-matrix.md` — keep/delegate/add decisions.
- ✅ New primitives: `rust.xxh3`, `rust.passwordHashBcrypt`/`verifyBcrypt`,
  `rust.pbkdf2Sha256`, `uuidv7()` (TS delegate).
- 🔜 `@flux/native` prefer-Bun delegation table (flux-core repo).

## 3. Enterprise observability (✅ core primitives, 🔜 wiring)
- ✅ Zero-dep metrics registry (`createMetrics`) + Prometheus render.
- ✅ Ingress metrics wiring (`createIngressMetrics`) + `/metrics` route factory.
- ✅ Health probes (`livenessHandler` / `readinessHandler` / `healthHandler`).
- ✅ W3C trace context (`parseTraceParent` / `createTraceId` / `createSpanId`).
- 🔜 Wire `/metrics` + `/healthz` `/readyz` `/livez` into the benchmark server
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
- 🔜 Cut v0.9.0 (tag + publish dry-run), flip flux-core's `file:` dep to a real
  version range, verify the installed-tarball native path in CI.

## 6. Governance (🔜)
- ✅ CODE_OF_CONDUCT, issue/PR templates, ROADMAP.
- 🔜 ADRs (two-wire-format, zero-DOM fast path, Bun-builtins delegation) —
  see `docs/adr/`.
- 🔜 API-reference site generated from `dist/index.d.ts`.

## Out of scope (deliberate)
- Live `npm publish` (manual gate; requires `NPM_TOKEN`).
- Removing/deprecating any hot-path napi API (see AGENTS.md — hard constraint).
- Distributed rate-limit/jobs stores in the engine itself (per-process documented
  behavior preserved; pluggable stores belong to the flux-core framework layer).
