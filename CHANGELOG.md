# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Node.js backward compatibility (Bun remains the primary target).** A compiled ESM
  entry (`dist/index.js` + bundled `dist/index.d.ts`) is built by `bun run build:js` and
  shipped in the tarball; `package.json` `exports` now has `types` / `bun` / `node` /
  `default` conditions so Bun keeps running raw TypeScript (zero startup cost) while Node
  consumers get a ready-to-import ESM bundle. `engines` now requires `node >= 20.3`
  alongside `bun >= 1.1.0`.
- `createIngressServerNode` — a `node:http` adapter that serves the SAME pre-baked route
  handlers as `createIngressServer` (Bun.serve). Returns a `NodeIngressServer` with an
  async `ready` promise and graceful `stop()` (drain then close).
- `gracefulShutdown(handles, { timeoutMs, signals })` — wires SIGTERM/SIGINT to a
  soft-drain-then-force stop for both Bun and Node server handles.
- New `src/shared/runtime.ts` (`isBun`/`isNode`) and `src/shared/log.ts`
  (`createStructuredLogger`, gated by `CASTRUM_LOG_LEVEL`).
- Observability hooks on the ingress paths: `onRequest` / `onError` on
  `BakedIngressRuntime` (alongside the existing `onResponse`), an `onError` option on
  `createIngressFast`, and an opt-in `structuredLog` runtime flag. Native failures are no
  longer silent — they surface via `onError`.
- Request-body hardening: `readBodyWithLimit` supports an overall deadline
  (`bodyTimeoutMs`, REQUEST_TIMEOUT) and `jsonWriteHandler` now stream-reads with the
  `maxBodyBytes` guard enforced BEFORE the body is fully buffered. `createIngressServer`
  applies a server-level `maxRequestBodySize` default of 16 MiB.
- Rust security hardening: AEAD batch APIs derive a unique per-item nonce (no more nonce
  reuse), the rate-limiter config registry is bounded (LRU, capped at 16 distinct configs,
  `max_entries` clamped), `jwt_verify` enforces an `alg` allowlist + `nbf`/`iat` checks,
  and the multipart parser enforces part/count/byte limits (`MultipartLimitsInput`).
- `trustProxy: true` (legacy boolean) now emits a one-time deprecation warning directing
  users to the `trustedProxies` network-list API.
- CI: new `node` job (Node 20 + 22) builds `dist/`, runs the Node smoke suite, and
  validates the tarball.

### Fixed

- **Fast-path header corruption >8 KB** (`src/ingress/packing/header-packing.ts`):
  `writeHeaderPair` grew the buffer locally and never returned it, silently dropping
  headers on large requests. The grown buffer/view are now threaded back to the caller.
- **JSON-escape length undercount** (`rust/json_ser.rs`): `\r`/`\t`/`\x08`/`\x0c` were
  counted as +0 but written as 2-byte escapes, overflowing tightly-sized output buffers
  (panic → 500). Length accounting now matches the writer.
- `nativeWsAcceptKey` no longer uses `Bun.CryptoHasher` (works under Node), and
  `resolveRayonThreads` no longer uses `navigator.hardwareConcurrency` (ReferenceError on
  Node < 21).

### Changed

- The npm tarball no longer ships the `rust/` source tree or `Cargo.toml` (only prebuilt
  `.node` artifacts + `src` + `dist`).
- `prepublishOnly` now runs `bun run build:js` before staging native artifacts.

## [0.7.0] — 2026-08-04

### Changed

- **Renamed the project to `castrum`** (was `bun-rust-practical` / `rust_bench`): npm
  package name, napi binary name (`castrum.<platform>-<arch>.node`), Rust crate name, and
  all docs now use `castrum`. Runtime env vars use the new `CASTRUM_*` prefix; the legacy
  `RUST_BENCH_*` / `RUST_*` names are kept as aliases for backward compatibility.

### Added

- npm publishing setup: publish metadata (`description`, `license` MIT, `repository`,
  `keywords`, `publishConfig`), `*.node` artifacts included in the package `files`, a
  `scripts/prepublish.mjs` guard that verifies every napi platform artifact is present
  before publish, and a CI publish workflow that uploads all platform artifacts and
  publishes to npm on `v*` tags.
- Manual release command: `bun run publish:manual` — simple, no CI: bumps the version
  (`--increment <patch|minor|major|...>` via `bun pm version`, syncing `Cargo.toml`,
  `Cargo.lock`, `CHANGELOG.md`), creates + pushes the `v<version>` git tag (and the
  current branch), builds the host addon, and publishes to npm. It sets
  `CASTRUM_PUBLISH_ALLOW_PARTIAL=1` so `prepublishOnly` ships a single-platform
  tarball locally instead of requiring every `napi.targets` artifact.
  `bun run publish:manual:dry` (`--dry-run`) prints the plan without changing anything.

## [0.6.0] — 2026-07-31

### Removed (breaking)

- Deprecated async/tokio FFI surface: `batchAsync`/`RustBatchAsync`, `jsonValidAsync`,
  `jsonSumIdsAsync`, and the `AsyncIngress` native class. All native calls are now synchronous.
- Back-compat aliases: `rustRaw`, `createRawRustClient`, `RawRustClient`, and `fnv1A64`
  (use `rust`, `createRust()`, `RustClient`, and `fnv1a64`). `rustBatch` is retained.
- Low-level zero-copy wrappers: `urlEncodeInto`, `urlDecodeInto`, `httpParseRequestPackedInto`,
  `queryParsePackedInto`, `cookieParsePackedInto`.
- Dead Rust modules: `rust/core/` duplicate tree, `async_tasks.rs`, `ingress_async.rs`,
  `export.rs`, `runtime.rs`. Dropped the `tokio` dependency and napi `tokio_rt` feature.
- Dead/orphan TS files: `src/rust-ffi/raw.ts`, `src/ingress/smoke.ts`, `check-native.ts`,
  `bench/servers/ingress-cluster.ts`, and stale generated `index.js`/`index.d.ts`.
- Stale doc `docs/RUST_CORE.md` and repo artifacts (repomix outputs, old backup).

### Changed

- `bench/servers/ingress-server.ts` now imports the wire-format constants from
  `src/ingress/constants.ts` (single source of truth) instead of re-declaring them.
- Removed unused `*PackedInto` wrappers and dead ingress types
  (`RateLimitOptions`, `TrustedProxyOptions`, `IngressLimitsOptions`).
- Cleaned stale file lists in `package.json`/`tsconfig.json` and corrected docs
  (`ARCHITECTURE.md`, `BENCHMARKS.md`, `README.md`).

## [0.5.0] — 2026-07-29

### Added

- High-performance ingress pipeline with CORS, rate limiting, IP trust, proxy detection
- Fast synchronous ingress handler (`createIngressFast`) with zero-alloc per request
- Async ingress handler (`createIngress`) with body size guarding
- Counter-based request ID generation (no crypto overhead)
- Pre-encoded header name buffers for zero-allocation header packing
- Lazy-decoded result parsing (`FastIngressResult`)
- Header template system with pre-computed variant sets
- Configurable security headers (HSTS, CSP, X-Frame-Options, etc.)
- JSON schema validation integration via `jsonschema` crate
- Batch processing for validation, JSON, query, cookie, HTTP parse operations
- Async batch variants for concurrent workloads
- CRT-based cryptography via `aws-lc-rs` for HMAC-SHA256
- WebSocket accept key generation
- Comprehensive baseline benchmark suite (JS vs Rust)

### Changed

- Refactored Rust crate structure into modular composable modules
- Extracted ingress pipeline into separate `Ingress` NAPI class
- Consolidated output buffer layout constants as NAPI exports
- Replaced `crypto.randomUUID` with counter-based ID generation
- Moved from manual header packing to packed binary format

### Performance

- Zero-alloc request ID generation
- Zero-alloc header packing
- Single output buffer reused across requests
- Batch operations minimize NAPI boundary crossings
- Lazy JSON decode avoids unnecessary string allocations

## [0.4.0] — 2026-06-15

### Added

- URL encode/decode Rust implementations
- MIME type lookup from file extensions
- Random secure token generation

### Changed

- Upgraded to napi-rs v3 with napi10 features
- Switched to tokio runtime for async operations
- Optimized JSON operations with sonic-rs

## [0.3.0] — 2026-05-01

### Added

- JSON Patch (RFC 6902) support
- JSON Schema validation
- HMAC-SHA256 sign and verify
- Email, UUID, IPv4, IPv6 validation functions

### Changed

- Restructured TypeScript source into modular directories
- Added native addon loader with cross-platform path resolution

## [0.2.0] — 2026-04-01

### Added

- CRC32 and FNV-1a 64-bit hashing functions
- JSON validation and sum-by-keys operations
- Query string and cookie header parsers
- HTTP request parser
- Baseline JavaScript implementations for benchmarking

## [0.1.0] — 2026-03-01

### Added

- Initial project structure with Rust cdylib and TypeScript entry point
- NAPI-rs build pipeline
- Basic FFI function scaffolding
- Benchmark framework with comparison reporting