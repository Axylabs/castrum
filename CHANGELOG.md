# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`ws_frames` masking is now word-at-a-time** (u32 XOR over the RFC 6455 §5.3
  4-byte mask, with a byte tail for the last 1–3 bytes) in `encode_frame` /
  `decode_frame`, replacing the per-byte `b ^ mask[i & 3]` loop. Byte-parity is
  preserved (new property tests for every length 0–64 + a 10 KiB payload, and
  `bun run check` ws-frame checksums still match). Measured ~1.8 GiB/s masked
  decode on 1 MiB payloads; scalar single-call timings are unchanged because the
  single-call bottleneck is the NAPI crossing, not the mask loop.
- **Rust source restructure + hardening (behavior-preserving):**
  - **Domain folders**: the flat `rust/` module list is now grouped into
    `util/` (bytes/packed/batch/batch_core/threadpool/validation),
    `http/` (headers/method/parsers/form/media_type/url/etag/accept/mime/multipart),
    `crypto/` (hmac/cookie_sign/csrf/jwt/aead/argon2/base64/hashing/random_token),
    `json/` (json_ops/json_ser/json_patch_ops/json_schema/fast_schema),
    `payload/` (compress/sse/ws_frames/websocket/template), and the expanded
    `ingress/` (mod.rs napi boundary + pipeline.rs core + tests.rs +
    options/time/packed + cors/proxy/ip_trust/rate_limit/terminal/output/ingress_constants).
    `lib.rs` is now a declaration hub with a module map; the `util` barrel keeps
    legacy `crate::util::*` call sites working.
  - **Monolith splits**: `fast_schema.rs` → `json/fast_schema/`
    (`mod.rs`/`types.rs`/`cursor.rs`/`compile.rs`/`validate.rs`/`tests.rs`);
    `ingress.rs` → `ingress/{mod,pipeline,tests}.rs`.
  - **Memory / precompute (hot path)**:
    - Ingress schema validation now precompiles the zero-DOM `fast_schema`
      engine alongside the jsonschema validator **once at construction**
      (`IngressSchema`), removing the per-request `serde_json::Value` DOM build
      (~95% of validation cost) — DOM fallback preserved for unsupported keywords.
    - Query→JSON serialization is now a direct single-pass writer
      (`json_ser::query_to_json_into_slice`), eliminating the per-request
      9× intermediate packed buffer and the second parse on the ingress path
      (malformed `%XX` → 400 and buffer-too-small → truncated are preserved).
    - `JwtSigner`/`jwt_sign`/batch sign reuse one lazily-precomputed HS256
      header segment; `jwt_verify` fast-paths the canonical header without a DOM.
    - `AeadCipher` decrypt returns the in-place truncated buffer (one copy
      instead of two); `fast_schema` distinct-key tracking uses an inline Vec;
    - `multipart` field counting is O(1) per part (was O(n²)); media-type
      parse lowercases in a single pass; `http_parser` header lowercase is
      one pass; hex encode uses the shared `HEX_LOWER` table.
  - No public API / wire-format / benchmark-surface changes. Verified:
    `cargo test` 214, `bun test` 223, `tsc` clean, `check:proven:fail` OK,
    HTTP smoke 0 shape failures, startup unchanged.

### Added

- **Reusable-output (`*_into`) scalar APIs restored** (blocked by a Bun N-API bug
  that silently dropped in-place writes to `<1024`-byte buffers — now fixed in Bun;
  the 0.6.0 removal rationale is obsolete). New `rust.*` methods write into a
  caller-provided (poolable) `Uint8Array` and return the number of bytes written:
  `hexEncodeInto` / `hexDecodeInto`, `base64EncodeInto` / `base64DecodeInto`,
  `etagInto`, `urlEncodeInto` / `urlDecodeInto`, and packed
  `httpParseRequestPackedInto` / `queryParsePackedInto` / `cookieParsePackedInto`.
  They throw when the output buffer is too small, and are safe against input/output
  buffer aliasing. Measured vs the allocating scalars on 10 KiB payloads: hexEncode
  1.42x, hexDecode 1.88x, base64Encode 1.68x (parity at sub-µs scale, where the
  NAPI crossing dominates). Complements the batch APIs for pooled hot loops.
- **Packed batch byte-codec APIs** (`rust.batch`): `hexEncode`, `hexDecode`,
  `base64Encode` (url-safe/padding configurable), and `base64Decode` — pack N
  items into one buffer, cross the NAPI boundary once, and return per-item byte
  results. Measured on a 100-item batch: hexEncode 2.1x, base64Encode 3.1x,
  hexDecode 1.5x vs a scalar loop.
- **Production-hardening pass (instance-time precompute, correctness, Node compat):**
  - **New precompiled higher-order instances** (key/params compiled ONCE at construction,
    no per-call derivation): `createJwtSigner(secret, ttlSeconds?)` (HS256),
    `createAeadCipher(key, algorithm?)` (AES-256-GCM / chacha20-poly1305),
    `createArgon2Hasher(options?)` (argon2id), and `createMediaTypeMatcher(expected)`.
    `TemplateRenderer` gained `renderBatchPacked` (reuses the compiled template).
  - **Optimized existing instances**: `AcceptNegotiator.negotiate` is now allocation-free
    (stack-buffer parse, exact heap fallback for oversized headers); `MediaTypeParser`/
    `Base64Codec` no longer re-parse/re-select config per call; `etag`/`httpDate` write into
    fixed stack buffers (no `format!`).
  - **Ingress hot path**: JSON body validation is DOM-free when no schema is configured
    (`jsonValidBytes`/IgnoredAny instead of a thrown-away `serde_json::Value`), removing the
    largest per-request allocation.
  - **Correctness fix**: `json_ser` now escapes control chars (`\t \r \x08 \x0c`, others)
    everywhere, including before a `"`/`\`/`\n` — previously they were emitted raw,
    producing RFC-8259-invalid JSON for cookies/queries (e.g. `?q=%09%22`).
  - **Body hardening**: non-zero default body-read deadline (30s) on the async
    `createIngress` path and the `echo`/`jsonWrite` route handlers; `echoHandler` stream-reads
    chunked bodies via `readBodyWithLimit` (guard + deadline, never fully buffers first);
    fixed a timeout race where canceling a pending web-stream read could swallow
    `REQUEST_TIMEOUT`. `onError` is now accepted by `createIngressFast`.
  - **Resource guards**: `random_token`/`FormParser` capacities clamped; the `unsafe`
    ingress output writers self-check (bounds panic → clean JS 500 instead of OOB write);
    `hex_encode` guards are release-checked.
  - **Node adapter hardening** (`createIngressServerNode`): `requestTimeout`/`headersTimeout`/
    `maxRequestsPerSocket` mapped, socket-level `maxRequestBodySize` rejection (413 before
    buffering), DELETE/OPTIONS-with-body preserved, `clientError` → castrum JSON 400,
    keep-alive reuse verified.
  - **Loader fix**: a directory-valued `CASTRUM_NATIVE_LIBRARY_PATH`/`NAPI_RS_NATIVE_LIBRARY_PATH`
    now resolves to `dir/<name>.node` instead of `require(<dir>)` failing.
  - **Node test matrix**: new `test/integration/node-enterprise.test.mjs` (Buffer interop,
    new instances, `node:crypto` cross-checks incl. chacha20-poly1305, keep-alive, 413,
    `clientError`, slowloris 408) + `scripts/verify-install.mjs` installed-tarball e2e.
    `test:node` now lists files explicitly (Node 24-safe). `@types/node` declared as an
    optional peer dep; `dist/` added to `.gitignore`.
  - **Robustness**: `init_thread_pool` treats a rayon pool already auto-initialized by a
    direct `par_iter` as success (was a permanently poisoned error).

- **Eight new Rust-backed "framework action" modules** (all exported on the `rust`
  client, each with a compiled-once higher-order instance + scalar + bench task +
  correctness check):
  - **Form-urlencoded body parser** (`formParsePacked`, `createFormParser`).
  - **Media-type / Content-Type parser** (`parseMediaType`, `createMediaTypeParser`
    with wildcard `matches`).
  - **HTTP cache semantics** (`etag`, `httpDate`, `parseHttpDate`,
    `createConditionalRequest` → If-None-Match / If-Modified-Since 304 decisions).
  - **Accept-Encoding negotiation** (`parseAcceptEncoding`, `createAcceptNegotiator`
    — q-values, wildcards, specificity-first).
  - **Base64 / hex** (`base64Encode/Decode`, `base64UrlEncode/Decode`, `hexEncode/Decode`,
    `createBase64Codec`).
  - **Signed cookies** (`signCookie`, `verifyCookie`, `createCookieSigner`).
  - **CSRF tokens** (`csrfToken`, `csrfVerify`, `createCsrfProtector`).
  - **URL building** (`urlResolve`, `urlEncodeQuery`, `createUrlBuilder`).
  - New batch helpers: `rust.batch.formParse`, `signCookie`, `verifyCookie`, `csrfVerify`.
  - New high-level helper `parseFormBody(body)`.
- Benchmark coverage + proven-registry entries for all of the above (release-build
  classifications: proven = form parse, conditional request, accept-negotiate, cookie
  sign/verify, CSRF create/verify; parity = media-type, ETag, base64/hex decode, URL
  resolve; not-competitive = base64/hex encode, HTTP-date, URL query build).
- Reclassified `createSchemaValidator` from `not-competitive` → **parity** based on
  release-build numbers (scalar wins ~1.6x; per-doc batch loses ~1.17x).
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
- **JSON parse + JSON schema validation benchmarks.** Added `rust.jsonParse` (native
  sonic-rs → JS value; throws on invalid) and a scalar `SchemaValidator.validate(doc)`
  (alongside the existing batch methods). The CPU benchmark now includes
  `native:json_parse` / `rust:json_parse` and `native:json_schema_validate[_batch]` /
  `rust:json_schema_validate[_batch]` (JS baseline = `JSON.parse` / `ajv`), with
  correctness checks and comparison entries. Findings: Bun's `JSON.parse` beats the
  Rust DOM+marshaling path (~5x), and `ajv` beats the jsonschema path for small docs —
  Rust's wins are in the zero-DOM workloads (`jsonValid`/`jsonSum`/ingress).
- **Performance-proven surface.** New curated `proven` export (`castrum.proven`) that
  exposes ONLY the `rust.*` functions whose status is `proven` in `PROVEN_SURFACE`
  (`src/shared/proven.ts` — the single source of truth, statuses
  proven/parity/not-competitive/unmeasured). Functions that lose to their JS baseline
  (e.g. `jsonParse` vs `JSON.parse`, schema validation vs `ajv`, `urlEncode`/`urlDecode`
  on the baseline CPU, `jwtSign`, `brotliCompress`, `templateRender`) are excluded from
  `proven` but remain on the full `rust` surface. New `scripts/check-proven.ts` audits
  the registry against `bench/results/cpu/latest.json` (`bun run check:proven`, with
  `--fail` for CI) — it fails if a proven function regresses past the tolerance. New CI
  `proven` job builds the release addon, runs the benchmark, and gates on the audit.

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