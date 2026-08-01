# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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