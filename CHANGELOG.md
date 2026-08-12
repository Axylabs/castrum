# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Loader-backed bulk helpers** (`src/integration/batch.ts`, exported from the
  package): `validateMany` / `validateCount` (batch JSON-schema validation via
  `loader.schema`), and generic `runMany` / `runOne` (packed batch / single
  loader dispatch). These wire the higher-order loader into the integration
  layer — the loader was previously exported + benchmarked but had no
  production call sites. `LoaderScalar` is now re-exported from the loader
  barrel. See `examples/loader-demo.ts` for single/bulk/schema/hash usage.
- **`enableLoader` option on the pre-baked write routes** (`BakedHandlerOptions`):
  when set, the JSON-validity fallback check routes through
  `loader("jsonValid")` instead of the direct native call — exercising the
  loader's dispatch + counters on the real request path. Default off (the
  direct call is marginally faster for a single request).
- **`warmOnCreate` option** on `createIngressFast` / `createIngressHandler`:
  runs one probe GET at construction so the `run()` closure + packed pipeline +
  FFI ingress call are JIT-warmed before the first real request — cuts
  cold-invocation tail latency in serverless-style deployments.
- **Startup benchmark baseline persisted** to `bench/results/startup/latest.json`
  (`bun run bench:startup`) so cold-start regressions are catchable like the
  CPU report.
- **`AdaptiveEstimate`** (`src/shared/adaptive.ts`, exported): a bounded EWMA
  adaptive-estimate utility (generalized from the loader's cost model) for
  runtime self-optimization decisions, plus a `BufferPool` `adaptive` option
  that learns the observed request size to pre-size future buffers.

### Security

- **Decompression-bomb cap**: `rust.gzipDecompress` / `rust.brotliDecompress`
  (and their `batch.*` variants) now cap decompressed output at 64 MiB by
  default (new `maxDecompressed?: number` param; exceeding it errors). A few
  hundred compressed bytes could previously expand to gigabytes (zero-run
  deflate/brotli), OOM-aborting the process.
- **`fast_schema` nesting-depth cap**: the zero-DOM JSON Schema fast path now
  bounds recursion at 128 levels (`MAX_DEPTH`, matching sonic-rs/serde_json).
  `SchemaValidator.validate` on a ~100K-deep hostile document previously
  overflowed the native stack — an UNCATCHABLE process abort (`panic = "unwind"`
  + napi `catch_unwind` do not catch stack overflow). Both the schema walk and
  the structural `skip_value` path are guarded; deeper documents are rejected
  (byte-parity with the DOM reference, which also caps at 128).

### Fixed

- **Metrics `in_flight` gauge desync**: `createIngressMetrics` double-decremented
  the gauge on native pipeline failures (both `onError` and `onResponse` fire
  for the same request) and the latency histogram always read 0 (`result.startTime`
  was never set). Request accounting is now exactly-once, keyed by the request
  id, with the start time recorded in `onRequest`. A throwing route callback now
  also reports via `onError` (previously neither hook fired, leaking the gauge).
- **`zeroCopyResponse`-then-throw pooled-buffer leak**: a route callback that
  borrowed the pooled output buffer and then threw left the buffer in flight
  forever (the owning Response was never delivered). `run()` now releases the
  handle on the throwing path.
- **`full_sync` output-buffer clamp**: `handle_request_full_sync` now clamps
  `outputBufferSize` to `[OUT_DATA_START, 64 MiB]` — a misconfigured huge value
  (e.g. `u32::MAX` ≈ 4 GiB) previously triggered a multi-GB allocation (OOM).
- **Option-value validation**: `createIngressFast` / `createIngressHandler` now
  fail-fast on non-finite/negative numeric option values (`maxBodyBytes`,
  `bodyTimeoutMs`, `outputBufferSize`, `rateLimit.*`, `limits.*`) — a negative
  value previously silenced the pipeline. `outputBufferSize` is also clamped to
  the safe range in both factories.
- **Raw C-ABI panic containment (whole-process crash fix)**: the `bun:ffi`
  `extern "C"` exports had no `catch_unwind` — unlike the napi path (where
  napi-rs turns a Rust panic into a JS exception/500), a panic in any
  `castrum_*` FFI function unwound through the C ABI into Bun = UB =
  whole-process crash. This is what took the ingress HTTP server down under
  burst load (`11-concurrent-burst` → the process died at ~2.5 s and stayed
  down, yielding 91% network errors). Every fallible/allocating FFI export
  (`castrum_ingress_handle_packed`, gzip/brotli compress+decompress,
  `jsonPatch`, `multipart`, `jwtSign`, argon2/bcrypt, AEAD) now routes its core
  through `panic_guard` (`catch_unwind`), reporting the error sentinel (`0` /
  `None`) on panic — so a panic becomes a JS 500, never a crash. `handle_packed`
  borrows `&self` with no interior mutability on the hot path, so the instance
  stays consistent after an unwind.
- **Fixed a latent "panic on any input" in `fast_schema`**: `is_multiple_of`
  passed non-finite numbers (`1e999` → `f64::INFINITY` via `Cursor::number`) to
  `fraction::BigFraction::from`, which panics — a crash vector via the raw
  C-ABI for any schema with `multipleOf`. It now guards `is_finite()` and
  reports "not a multiple" (consistent with the DOM validator, whose serde
  parse of such a body fails). Pinned by a new parity test.
- **FFI ingress entry now guards `input↔out` aliasing**: `castrum_ingress_handle_packed`
  only copied the body when it overlapped `out`; the packed input frame was
  passed as a shared `&[u8]` even when it aliased the `&mut [u8]` output (instant
  UB). It now mirrors the napi path (`util::run_packed_into`) and copies the
  input too. Covered by a new C-ABI unit test.
- **Bind-time self-test now exercises `castrum_ingress_handle_packed`**: a null
  (0) inner handle must throw — a signature/ABI drift surfaces at bind time
  (→ napi fallback) instead of crashing under load. The bind-time self-test
  previously covered `castrum_ingress_layout` but not the ingress handle call.
- **`passwordHash` double-run from salt-size miscalc**: `argon2PhcLength`
  hardcoded a 22-char salt base64 (a 16-byte salt). Any other salt length
  (the ffi bench uses a 19-byte salt) made the pre-sized buffer too small, so
  `growExact` re-ran the whole argon2 hash — `passwordHash(m=8)` measured
  **0.52x** vs napi. It now derives the salt b64 from the actual `salt.length`
  → single native pass (measured **1.04x**).
- **gzip/brotli compress double-run from the 16 KiB initial cap**: the streaming
  core writes directly into the caller buffer, so the old `min(len+64, 16 KiB)`
  cap caused a grow-retry re-run of the whole compression whenever the output
  exceeded 16 KiB (any large/incompressible payload). The initial is now
  `len + len/8 + 64` (single-pass; verified on a 64 KiB incompressible input
  at ~1.1x vs napi instead of ~2x).
- **`jsonSumIds` legit zero-sum no longer re-dispatches to napi**: the scalar-
  i64 C ABI returned `0` for BOTH a zero-sum and invalid input, so every legit
  `0n` result triggered a second napi crossing. The C ABI now writes a packed
  `[u8 ok][i64 sum LE]` output (9 bytes) that disambiguates; the builder only
  re-dispatches to napi on actual invalid input (preserving the exact error
  message). Measured `jsonSumIds(200 rows)` 0.90x → 0.99x.
- **Repeated same-secret HMAC/CSRF/cookie FFI calls no longer rebuild the key**: a
  per-thread bounded LRU (`rust/ffi.rs` `HMAC_KEY_CACHE`) caches the compiled
  `hmac::Key` — the C-ABI equivalent of the compiled-once `HmacSigner` NAPI
  instance, without an opaque-handle lifetime hazard (the cache owns the keys
  and LRU-evicts). Zero lock contention across Bun Worker threads
  (`hmac_sha256_concurrent_*`).

### Changed

- **`bun:ffi` is now the PRIMARY transport under Bun; NAPI is the fallback.**
  The public `rust.*` scalar API, the ingress per-request pipeline, and now the
  ingress binary-layout constants all route through `bun:ffi` on Bun — NAPI is
  used only as the fallback (Node, a failed bind-time self-test, or an explicit
  opt-out). New `rust.transport()` / `rust.ffiActive()` report the resolved
  transport, and the CPU bench harness asserts the ffi transport is live under
  Bun (`CASTRUM_BENCH_FFI=1` turns the warning into a hard failure).
  `import "castrum"` no longer dlopens the napi addon on Bun: the ingress
  layout constants are read through a new `castrum_ingress_layout` C-ABI blob
  (single numeric source `rust/ingress/output.rs`; drift pinned by a Rust unit
  test + the bun:ffi bind-time self-test).
- **New `CASTRUM_FFI_MODE=auto|ffi|napi` env var** (legacy alias
  `RUST_FFI_MODE`) selects the native transport: `auto` (default) = bun:ffi on
  Bun with a silent napi fallback; `ffi` = force bun:ffi and throw if the
  bind/self-test fails; `napi` = always use the napi addon (exercises the
  fallback on Bun). See `docs/ENVIRONMENT.md`.
- `write_output_header` now asserts the output buffer is at least
  `OUT_DATA_START` bytes (defense-in-depth; a too-small buffer fails loudly
  instead of an out-of-bounds store).
- `readBodyWithLimit`'s body-timeout timer is `unref()`ed (Node) so a pending
  timeout no longer holds the event loop open.
- **`rust.hmacSha256` / `rust.hmacSha256Verify` now route through `bun:ffi` on
  Bun** (previously they always went through the NAPI `HmacSigner` instance).
  The C ABI builds the HMAC key per call but skips the NAPI instance
  construction + crossing; the precompiled-key `HmacSigner` instance remains
  the napi fallback (identity semantics unchanged). The `ffi-all.ts` HMAC rows
  therefore now measure the real FFI path (they previously measured NAPI as
  "ffi").
- **`rust.packed.*` / `rust.batch.*` resolve native fns through a shared
  first-use cache** (`resolvePoolNative`, context.ts) instead of the
  `withPoolInit` per-access Proxy + a duplicate batch cache — the packed
  namespace no longer pays a Proxy `get` on every call, and the rayon pool
  still initializes on first use so `rust.configure({ rayonThreads })` keeps
  working.
- **FFI-active guard added to the HTTP bench**: `bench/run-bench.ts` warns (or
  hard-fails under `CASTRUM_BENCH_FFI=1`) when bun:ffi is not live on Bun, so
  HTTP measurements are never silently taken on the napi fallback (mirrors
  `src/bench/run.ts`).
- **FFI-backed `create*` instances** — the codec/crypto/form instance methods
  no longer cross NAPI on Bun. `createHmacSigner`, `createBase64Codec`,
  `createCookieSigner`, `createCsrfProtector`, `createArgon2Hasher`,
  `createAeadCipher`, and `createFormParser` now return wrappers that drive the
  existing stateless C-ABI ops (`castrum_hmac_sha256`, `base64`, `sign/verify`
  cookie, `csrf`, `password_hash`, `aead`, `form_parse_packed`) — a ~20ns
  crossing instead of ~300ns per method call. Byte-for-byte parity with the
  NAPI instances is pinned by the ffi cross-check suite; NAPI instances remain
  the fallback. The `createAeadCipher` wrapper mirrors the constructor's
  algorithm validation (`resolve_algorithm`) so an unsupported algorithm still
  throws at construction. Instances with genuinely stateful precompiled cores
  (SchemaValidator, TemplateRenderer, AcceptNegotiator, ConditionalRequest,
  MediaTypeMatcher/Parser, UrlBuilder, RateLimiter) stay NAPI — they need
  opaque handles (deferred). Measured (release build, noisy host):
  `csrf_create` ~11x, `cookie_verify` ~2x, `form_parse` ~5x faster vs the JS
  baseline.

### Performance

- **FFI-vs-NAPI regression sweep** (the fixes above, measured on `bench/ffi-all.ts`
  before/after on the same noisy host): `passwordHash(m=8)` **0.52x → 1.04x**,
  `jsonSumIds(200 rows)` **0.90x → 0.99x**, `aeadEncrypt` 0.84x → 1.08x
  (confirmed noise), and gzip/brotli compress on a 64 KiB incompressible input
  single-pass at ~1.1x (was ~2x from the grow-retry re-run). The post-fix run
  reports **3** ops slower than napi (all compression rows on a 1.2 KiB
  medium input — already single-pass before/after, host noise) vs **6** before;
  `check:proven --fail` is clean, with hmacSha256 1.31x, passwordHash 20.95x,
  aeadEncrypt 2.29x, hmacSha256Verify 2.77x.
- **FFI-primary tuning closes the remaining Bun regressions** (the fast path is
  now the primary transport — see Changed):
  - gzip/brotli `growWrite` pre-sizes its output buffer: gzip decompress reads
    the ISIZE trailer (exact size for a single-member stream), brotli
    decompress starts at 32× (capped 4 MiB), and compress initial buffers are
    capped at 16 KiB (the C ABI builds the compressed output internally, so a
    full-size JS buffer was pure overhead). Measured on Bun: gzipDecompress
    0.54x → 1.09x, brotliDecompress 0.36x → 1.01x, gzipCompress(64 KiB)
    0.64x → ≥0.95x.
  - `jwtSignBytes` initial buffer is now `2 × claims + 128` with a 256-byte
    floor — the old `claims.length + 128` under-sized a typical token
    (168 B for a 30 B claim) and paid a grow-retry double-run. Measured on
    Bun: 0.73x → 1.28x.
- **Ingress per-request hot-path trim** (pre-baked handler path):
  - The `Origin` header is fetched ONCE in `run()` (for `ctx.origin`) and the
    value is passed into `gatherRawHeadersPacked`, removing a second
    `req.headers.get('origin')` native→JS string conversion per Origin-bearing
    request (same `MAX_SMALL_HEADER_BYTES` guard still applies).
  - The single-slot CORS Origin header memo in `responseHeaders` is replaced
    with a per-`(variant, origin)` cache: clients that alternate between
    allowed origins (e.g. the benchmark's two configured origins) no longer
    allocate a fresh header array on every switch — each distinct origin is
    reused after its first hit, and the cache stays bounded by the allowed
    origin list (the native pipeline gates the CORS variant on approval).
  - `readBodyWithLimit` skips the redundant `reader.cancel()` await on the
    normal `done` path (the stream is already closed), saving an async
    round-trip per POST; the timeout/error path still cancels (the documented
    reject-then-cancel race is preserved).
- **Bun `bun:ffi` C-ABI fast path covers the entire stateless scalar API + the
  ingress request handler** — the N-API crossing + output-marshaling cost is
  cut on ~35 functions when running under Bun:
  - The cdylib now exports 46 `extern "C"` symbols (`rust/ffi.rs`, incl. the
    `castrum_gzip_isize` trailer-size probe): hashing,
    validators, hex/base64/url codecs, HMAC / signed-cookies / CSRF / password
    hashing / PBKDF2 / AEAD, WebSocket accept-key + frames, ETag, gzip/brotli,
    JSON sum/patch, the packed parsers, JWT sign, WS frame decode, multipart /
    form packed parsing, AND `castrum_ingress_handle_packed` (the whole ingress
    pipeline in one call) — loadable via `bun:ffi` `dlopen` alongside the napi
    registration. Node is unaffected (it keeps using the napi addon).
  - `src/native/ffi.ts` binds these lazily (first use) with a **bind-time
    self-test** against known vectors — if any check fails (ABI mismatch,
    platform quirk, a future Bun regression) the whole ffi layer is disabled
    and every call falls back to the napi addon. The public API never observes
    a wrong result.
  - Wired into the `rust.*` scalar surface (`hashing`/`json`/`crypto`/`http`/
    `payload` builders): validators, `jsonSumIds`, decoders, cookies/CSRF/
    passwords/PBKDF2/AEAD, compression, WS frames, the packed-parser `Into`
    variants, `jwtSignBytes`, `wsFrameDecode` (via a packed `[flags][opcode]
    [len][payload]` C-ABI + JS decode), `multipartParsePacked`, and
    `formParsePacked` (shares the query core). The allocating variants reuse
    the `Into` path with an `input.length * 9 + 16` buffer, matching the Rust
    allocator's bound.
  - Output writers use fixed worst-case buffers where possible and a
    **needed-size** helper (`growExact`: exact one-buffer retry on a too-small
    output, immediate throw on a real error — no doubling re-run loop) for
    variable-size outputs (gzip/brotli decompress, jsonPatch, argon2). Error
    semantics mirror napi: decoders throw on a `0`
    write for non-empty input; `verifyCookie`/`aeadDecrypt` return `null`;
    `jsonPatch`/`jsonSumIds` re-dispatch to napi on ambiguity to preserve the
    exact contextual messages (`"invalid document"`, `"expected an array"`);
    `urlDecode` re-applies napi's UTF-8 validation on high-byte output, while
    `urlDecodeBytes`/`urlDecodeInto` (which napi leaves unchecked) stay
    byte-faithful.
  - **Ingress handler**: `createIngressFast` / `createIngressHandler` now run
    the native pipeline through `bun:ffi` under Bun, via an opaque handle from
    the new `Ingress.ingressInnerPtr()` napi method (valid only while the
    instance is alive — the wrapper holds it for the handler's lifetime). The
    per-request `handleRequestPacked` N-API crossing is eliminated; output is
    byte-identical to napi (pinned by a cross-check test). Falls back to napi
    when ffi is unavailable or the addon lacks the pointer method.
  - Measured (Bun, min-of-trials): crc32 0.37→0.17µs, fnv1a64 0.34→0.08µs,
    xxh3→0.04µs, hexEncode 1.0→0.11µs, jsonPatch 1.85→1.27µs.
    `check:proven` now flags hexEncode / urlEncode / urlDecode PROMOTABLE.
  - The bind-time self-test is the safety net for the PRIMARY `bun:ffi`
    transport — on any failure the napi addon remains the fallback, so the
    public API never observes a wrong result.
- **Ingress per-request cost down ~10%** (native `handle_request_packed`):
  - The socket IP is no longer parsed (`str::parse::<IpAddr>`) on the hot path
    when rate limiting is disabled — the resolved IP is only consumed by the
    rate limiter, so a cheap `socket_is_trusted` (immediate `false` when no
    trusted-proxy mode is configured) replaces the full `resolve_client_ip`
    walk (`pipeline.rs` + `ip_trust.rs`). `peer_trusted` semantics are unchanged.
  - `write_output_header` does ONE upfront `OUT_DATA_START` bounds check and
    then uses unchecked `write_unaligned` stores for the whole 48-byte header,
    instead of seven per-field capacity asserts (`output.rs`). Behavior is
    identical; the removed `write_u16/32/64` helpers were only used here.
- **gzip/brotli decompress faster** (measured -20% brotli, -78% on the
  Bun-diag gzip comparison vs the prior release report): the decompressed
  output `Vec` is pre-sized (`data.len() * 8`/`*16`, capped by
  `max_decompressed`) so `read_to_end` no longer realloc-copies through
  doubling growth. The decompression-bomb cap is unchanged.
- **FFI marshal reduction** (`src/rust-ffi`): scalar/packed/text wrappers now
  resolve native addon functions through a shared first-use cache
  (`resolveNative` in context.ts), skipping the lazy-addon Proxy `get` trap (a
  branch + `Reflect.get`) on every call — the same pattern the batch namespace
  already used. `cachedMime` no longer returns a per-call defensive copy
  (documented aliasing contract, matching `generateRequestId`), and
  `rust.text.mimeFromExtension` memoizes the decoded string (0 allocs on hit).
  Measured (release build): MIME lookup flipped from noisy parity to a
  consistent ~1.4x Rust win; media-type parse narrowed its loss (~0.71-0.81x →
  ~1.1-1.5x baseline).
- **C-ABI "needed"-size convention kills grow-retry re-runs** (the largest
  remaining FFI-vs-napi gap). Variable-size ops (`gzip/brotli` compress +
  decompress, `jsonPatch`, `multipartParsePacked`, `jwtSignBytes`,
  `passwordHash`) now return the EXACT required byte count on a too-small
  buffer (`0` stays a real error), so the JS wrapper allocates exactly once and
  retries at most once — no doubling loop that re-ran the whole (de)compression
  on every miss, and invalid compressed input now throws immediately instead of
  grow-allocating up to 64 MiB per bad call. `passwordHash` pre-sizes with the
  exact PHC string length (computable from m/t/p/out_len); `gzipDecompress`
  pre-sizes from the new `castrum_gzip_isize` C probe (replaces the JS
  `DataView` trailer read).
- **Zero-alloc C-ABI output** (`rust/ffi.rs`): `base64Encode`/`base64Decode`
  now use the existing `encode/decode_into_slice` cores (no intermediate `Vec`
  + copy), and `wsAcceptKey`, `signCookie`/`verifyCookie`, `wsFrameEncode`
  write directly into the caller buffer via new `*_into` cores in
  `websocket.rs` / `cookie_sign.rs` / `ws_frames.rs`.
- **Streaming gzip/brotli cores** (`rust/payload/compress.rs`): the C-ABI path
  now compresses/decompresses DIRECTLY into the caller's buffer — no internal
  `Vec` + memcpy. A too-small buffer reports the exact `needed` size in a
  single pass (a `CountingWriter` for compress; a scratch-read overflow count
  for decompress), preserving the needed-size retry with no re-run. Measured
  (release build): `gzipCompress` flipped from a ~1.19x LOSS to a ~1.5x WIN
  vs the native baseline; `gzipDecompress` also improved. brotli stays
  CPU-bound (the `brotli` crate is slower than Bun's native codec — a
  transport-independent property, not a marshaling cost).
- **New reusable-output `*Into` variants** (pooled buffers, no per-call alloc):
  `rust.hmacSha256Into`, `rust.signCookieInto`, `rust.aeadEncryptInto`,
  `rust.wsFrameEncodeInto`, `rust.gzipCompressInto`, `rust.brotliCompressInto`
  — FFI-first with a napi allocate+copy fallback. Lets hot loops reuse a
  caller-provided buffer (the same escape hatch as the existing
  `hexEncodeInto`/`base64EncodeInto`), cutting GC churn under sustained load.
- **Ingress CORS steady state**: `responseHeaders` memoizes the Origin-augmented
  header array (per-handler, read-only contract), removing a per-request array
  alloc + copy when an `Origin` header is present (the common browser/bench
  case).

## [0.9.0] — 2026-08-11

### Fixed

- **Runtime seam was dead + unguarded**: `createIngressServer` called `Bun.serve`
  unconditionally (raw `ReferenceError` on Node) and `src/shared/runtime.ts`
  (`isBun`/`isNode`) had no production callers. It now guards on `isBun()` and
  throws a friendly Bun-only error; `BakedServer.port` returns the ACTUAL bound
  port (was `options.port`, wrong for `port: 0`).
- **Node keep-alive body-drain hazard**: early terminal responses (413 at the
  socket, 400/413/415 route guards) left the request body unread, corrupting the
  next request on a keep-alive socket. The adapter now drains the unread body
  after writing any response.
- **`clientError` always 400**: Node header-overflow parse failures now map to
  **431** (`HPE_HEADER_OVERFLOW`), other parse failures stay 400.
- **Loader silently ignored a bad override**: a set-but-misconfigured
  `CASTRUM_NATIVE_LIBRARY_PATH` fell through to the package roots (masking a
  typo). It now throws with the expected override locations.
- **Path-2 `run()` missing the sync-callback guard**: an async callback on
  `createIngressHandler().run()` observed an invalidated (zeroed) result — it
  now throws (parity with the fast path).
- **`zeroCopyResponse` outside a live `run()`** silently served an empty body —
  it now throws.
- **Fast-path `bodyTruncated` omitted the body section**: the fast decoder now
  flags any overran section (cookies/query/body), matching the baked decoder.
- **WebSocket accept key (RFC 6455 violation)**: `WS_MAGIC` was
  `258EAFA5-E914-47DA-95CA-5AB5DC11BE85` (transposed GUID) — the resulting
  `Sec-WebSocket-Accept` was non-standard. Corrected to the RFC 6455 GUID
  `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` in `rust/payload/websocket.rs` and the
  JS baseline; the unit-test vector now asserts the canonical
  `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` value.

### Added

- **New primitives (performance-proven vs Bun built-ins — "don't reinvent the
  wheel")**: public `rust.xxh3` (XXH3-64; `Bun.hash.xxHash3` is ~4x faster, so
  prefer Bun under Bun — classified `not-competitive`), `rust.passwordHashBcrypt`
  / `rust.passwordVerifyBcrypt` (bcrypt `$2b$` PHC; verify ~1.5x vs
  `Bun.password`), `rust.pbkdf2Sha256` (PBKDF2-HMAC-SHA256; parity with
  `node:crypto.pbkdf2Sync` and the only synchronous option in Bun), and the
  `uuidv7()` helper (delegates to `Bun.randomUUIDv7`, `crypto.randomUUID` on
  Node). Full measured results + keep/delegate decisions in
  `docs/bun-builtins-decision-matrix.md`.
- **Bun built-ins diagnostic benchmark set**: `bun run check` now races castrum
  ops against `Bun.hash` / `Bun.password` / `Bun.CryptoHasher` / `Bun.gzipSync` /
  `Bun.randomUUIDv7` under `diag:` task names (never audited by `check:proven`).
  Sources: `src/baseline/tasks/bun-builtins.ts` + `src/bench/tasks/bun-builtins.ts`.
- **Zero-dep observability** (`src/shared/metrics.ts`, `src/shared/trace.ts`,
  `src/ingress/metrics.ts`, `src/ingress/health.ts`):
  - `createMetrics()` — counters / gauges / histograms with Prometheus text
    rendering (exported from the package root).
  - `createIngressMetrics()` + `metricsHandler()` — wire the ingress
    `onRequest`/`onResponse`/`onError` hooks into a `castrum_http_*` metric set
    and serve it at a `/metrics` endpoint (Prometheus text).
  - `livenessHandler()` / `readinessHandler(check?)` / `healthHandler(check?)`
    — Kubernetes-style health-probe route factories (200/503).
  - W3C trace context: `parseTraceParent()`, `createTraceId()`, `createSpanId()`,
    `serializeTraceParent()` for cross-service `traceparent` correlation.
- **`uuidv7()`** — UUIDv7 helper that delegates to `Bun.randomUUIDv7` and falls
  back to `crypto.randomUUID` on Node (measured Bun ~2x faster than the FFI path
  — deliberately not reimplemented in Rust).
- **DELETE route factory** (`deleteHandler`) + **OPTIONS preflight on every
  route**: `createIngressServer` now wires `DELETE` via `BakedRoute.delete` and
  serves CORS preflight (204/403) for ALL routes with a handler — read-only
  routes previously 404'd on `OPTIONS`.
- **Node WebSocket upgrade support**: `createIngressServerNode` now listens for
  `upgrade`; a route returning a 101 (`createWebSocketUpgrade`) completes the
  RFC 6455 handshake on the hijacked socket and hands it to the new
  `CreateIngressServerOptions.onUpgrade` hook (frame codec is caller-owned).
- **`BakedIngressResult.cookiesJson()` / `queryJson()`**: the pre-baked decoder
  now exposes the cookie/query JSON sections (parity with the fast decoder).
- **Pooled-body abandonment guard**: `pooledBodyResponse` accepts an optional
  `timeoutMs` that releases the pooled buffer (and closes the stream) when a
  zero-copy body is never pulled/cancelled.
- **Zero-DOM JSON Schema coverage + detailed errors**: `fast_schema` now
  implements the full draft-07 validation keyword surface — `pattern` /
  `patternProperties` (fancy-regex, the same ECMA-262 engine jsonschema uses,
  incl. lookaheads), `enum`/`const` (exact cross-type number equality via
  num-cmp), `multipleOf` (exact rational divisibility via fraction), `allOf` /
  `anyOf` / `oneOf` / `not`, `if`/`then`/`else`, `contains`, `uniqueItems`,
  draft-07 tuple `items` + `additionalItems`, `dependencies`, and in-document
  `$ref` (`#`, `#/definitions/*`, `#/$defs/*`, any object/bool subschema).
  Still-fallback keywords: `propertyNames`, `dependencies` with a schema value,
  draft-04/06 boolean exclusive bounds, formats other than `email`, and
  remote/dynamic/anchor refs. New `SchemaValidator.validateDetailed(doc)` and
  `validateFirstError(doc)` return jsonschema-style errors (instance + schema
  RFC 6901 JSON pointers, keyword, message) from the zero-DOM path. Schema
  validation (fast + DOM fallback) is now consistently **draft-07** (jsonschema
  0.48's default draft is 2020-12); a schema's declared `$schema` still
  overrides the default.

- **flux-core compatibility contract** (v0.8.0): castrum is now pinned by
  flux-core's `@flux/native` package (`optionalDependencies`). The new
  `test/compat/flux-contract.test.ts` guards the exact surface flux depends
  on — entry normalization (`mod.rust ?? mod`), the scalar/class/factory
  exports, and the packed-pairs wire format — in castrum's own CI, so a
  change to the addon can never silently break flux's native acceleration.

- **Public `loader` + `integration` surfaces**: `createLoader`/`loader` (HFC)
  and `createPipeline`/`createWebSocketUpgrade`/`sseResponse` are now exported
  from the package entry (`index.ts`) — previously tested + documented but
  unreachable by consumers. The broken `docs/INGRESS.md` import example is now
  valid.
- **Test typechecking**: `tsconfig.test.json` + `bun run typecheck:test`
  typechecks `test/` and `bench/` (unused locals/params on). Wired into
  `test:all` and CI. Fixed ~20 pre-existing test type errors this surfaced.
- **CI**: Node 24 added to the `node` matrix (locally caught a real `node
  --test` directory-argument regression); a `typecheck:test` step runs in the
  `typescript` job.
- **New docs**: `docs/REPO_MAP.md` (the "what is where and why" navigation
  map), `docs/GETTING_STARTED.md` (intern-friendly tutorial), and a MIT
  `LICENSE`.
- **Tooling**: Biome for lint/format (`bun run lint` / `bun run format`), a
  version-consistency check (`bun run check:version` — package.json ↔
  Cargo.toml ↔ CHANGELOG), and hardened CI: per-job least-privilege
  `permissions`, job `timeout-minutes`, an HTTP-smoke wire-format gate, a JS
  dependency audit step, a Dependabot config, and `setup-node` in the publish
  job.
- **Rust unit tests** for previously uncovered modules: `mime_lookup`,
  `json_patch_ops`, `websocket` (RFC 6455 accept-key vector), `terminal`, and
  `time` (+16 tests).
- **JSON Patch batch API**: `rust.batch.jsonPatch(docs, patches)` / raw
  `rust.packed.jsonPatchBatchPacked` — zips two packed lists, applies each
  pair in parallel via rayon, returns packed results. Fail-fast with
  index-bearing errors (JSON patch output is data, so dropping items would
  risk silent data loss).

### Fixed

- **Silent no-op security options** (`fast.ts`): `createIngressFast` now throws
  a clear `TypeError` when `security`/`enableSecurityHeaders` are set — the raw
  fast path returns a decoded result (not a Response) and previously accepted
  and ignored them. `createIngress` still applies them (strips them before
  forwarding to the fast handler).
- **Header-size guard divergence**: `packHeaders` (fast path) now applies the
  same per-header size guards as `gatherRawHeadersPacked` (baked path), so an
  oversized cookie/origin/xff is dropped consistently instead of pushing the
  packed block past the native `max_headers_bytes` and 500-ing. Guards moved to
  `src/ingress/packing/scratch.ts` (single source of truth).
- **Reconstructed incomplete `src/rust-ffi/scalar/` split**: `hashing.ts`,
  `json.ts`, `http.ts`, `crypto.ts` were empty files (the split landed but the
  builders were never populated) — the package would not typecheck or load.
  Rebuilt from the original `scalar.ts` and removed the stale `rustBatch` alias
  re-export (removed upstream in 0.8.0).
- **Working-tree `rust/lib.rs` regression**: the file had reverted to the old
  flat module layout (E0583 — 71 compile errors against the domain-folder
  tree); restored to the committed domain-folder declaration hub.
- **`buildRouteHandlers` over-broad param type**: it required `port`, which it
  never uses — narrowed to `BuildRouteHandlersOptions` (Pick of what it
  consumes), fixing 6 latent test type errors.
- **Ingress proxy-header plan divergence** (`handlers.ts`): the pre-baked path
  only forwarded X-Forwarded-For / X-Real-IP when rate limiting was ALSO
  enabled and ignored `trustedProxies`. Both paths now share a single
  `buildHeaderPlan` (`src/ingress/shared.ts`) driven by trust config alone —
  proxy extraction no longer depends on rate limiting.
- **Stale-buffer hazard** (`fast.ts`): `handleRequestPacked`'s written-byte
  count is now honored — the fast path decodes only the exact written prefix of
  the reused output buffer, mirroring `handlers.ts`.
- **multipart Content-Disposition parsing** is now quote-aware: a `;` inside a
  quoted `filename` (e.g. `b;c.txt`) is data, not a separator, and `\"`
  escapes no longer break quote tracking (`rust/http/multipart.rs`).

### Changed

- **Dead Rust code removed**: `jwt::hmac_sha256` (unused scalar wrapper),
  test-only `verify_signature` / `packed_pairs_to_json_into_slice` are now
  `#[cfg(test)]` (the latter with an inline reader, so `util::read_u32_le` is
  gone), unused `util/mod.rs` re-export shims, and dead branches (rate-limit
  `NonZeroUsize` fallback, `output.rs` 101 case). `json_ser::is_ascii` no longer
  `expect()`s on the hot path.
- **Deduped batch writers**: `hex_encode_batch_bytes` uses the shared
  `util::bytes::hex_encode`; `crc32_batch_packed` delegates to
  `util::packed::write_u32_batch_into` (the allocating variant now shares the
  `_into` twin's validation + parallelism).
- **Shared rate-limiter eviction now throws**: `shared_limiter` refuses a 17th
  distinct config instead of silently evicting a live limiter (which reset
  per-IP budgets — a rate-limit bypass vector).
- **Rust `CorsOptions` dropped `expose_headers`/`max_age`**: the engine only
  evaluates origin/method/header/credentials; the emitted
  `access-control-expose-headers`/`access-control-max-age` come from the TS
  header templates (both paths).
- **Dead code / dead flows removed**: `HeaderRefs::has_cookie`/`has_acrh`,
  provably-dead `unreachable!` arms in `json_ser.rs`, an `Option` dance in
  `ip_trust.rs`, the empty `src/ffi/` dir, and the unregistered loader bench
  tasks (now wired into `createComplexTasks` + the async loader benchmarks run
  in `bun run check`).
- **Named constant for the ingress body default**: `1_048_576` in `mod.rs` is
  now `options::DEFAULT_MAX_BODY_BYTES` (mirrors `src/ingress/shared.ts`).
- **Centralized env-var alias resolution**: `src/shared/env.ts`
  (`resolveEnvVar`) + a Rust `read_env` helper in `threadpool.rs` replace five
  duplicated/asymmetric `CASTRUM_*` + legacy alias chains.
- **napi types pushed out of pure-core Rust**: `headers.rs`, `packed.rs`,
  `ip_trust.rs`, `json_ser.rs` and `terminal.rs` now use `std::result::Result`
  / plain return values (mapped at the napi boundary). Behavior unchanged
  (callers only match Ok/Err).
- **DRY packed-batch routing**: the copy-pasted `PackedIter::new →
  count_and_total_bytes → should_parallelize → unpack` prelude in
  `util/batch.rs` is now one `packed_routing` helper used by all 7 batch
  functions.
- **Typed `Bun.serve` config**: `createIngressServer` builds a typed
  `BunServerOptions` instead of a `Record<string, unknown>` + `as any` (narrow
  bridge to Bun's Serve type only).
- **Path-2 ingress input marshaling** (`handlers.ts`): the pre-baked path now
  packs the request frame in JS (`IngressInputPacker` + packed headers with the
  same per-header size guards) and drives the identical native core as
  `handleRequestPacked`. This eliminates the per-request `[name, value][]` →
  napi `Vec<Vec<String>>` header marshaling, the intermediate Rust packed-frame
  build, and the request-id string re-encode. `handleRequestFullSync` /
  `handleRequestFullSyncInto` remain as compatible allocating/`_into` wrappers.
  Response wire format is unchanged (both entries run the same `handle_packed`).
- **Zero-copy terminal headers**: `cache-control: no-store` is baked into a
  second variant-indexed template set (`buildBakedHeaderTemplates` → `{regular,
  terminal}`), so terminal/error responses return a frozen array with no
  per-response allocation/copy (extras path preserved byte-identical).
- **`query_to_json_into_slice` single-pass decode**: each query component is
  percent-decoded once (previously twice — a length pass and a write pass, four
  decodes per pair); one reused scratch holds `[key][value]`.
- **Fast-path input encoding**: `IngressInputPacker.packFromStrings` encodes
  url/ip/requestId directly into the packer buffer via `encodeInto` — three
  fewer intermediate `Uint8Array` allocations + copies per request.
- **fast_schema `validate_object`** is allocation-free for `minProperties` /
  `maxProperties`: distinct-key tracking is a stack array (heap fallback only
  for pathological objects), byte-parity with the jsonschema crate preserved.
- **Decoder unification**: the `+`/`%XX` form-component decode loop is
  centralized in `util/bytes.rs` (`decode_form_component_into`) and shared by
  `query_parser::write_decoded_form_component` and `json_ser::decode_query_component`.
- **http_parser dedup**: `http_parse_request_packed_vec` delegates to
  `http_parse_request_packed_into_slice` (removes ~60 duplicated lines; guarded
  by a new byte-parity test).
- **Clippy-clean**: fixed all pre-existing clippy warnings (was ~29 warnings +
  1 error) across crypto/http/json/ingress/util — zero warnings now.

### Performance

- **Loader bulk path FFI friction cut** (`rust.batch.*`): packed inputs now go
  through a reusable scratch pool (`withPackScratch`/`withPackScratch2`) and
  native fns are resolved once and cached (`nativeFn`), eliminating the
  per-call `packBatch` allocation and the lazy-addon/`withPoolInit` Proxy gets.
  Public `rust.batch` return shapes unchanged.
- **Zero-alloc coalesced `load()` flush**: boolean/number/bigint ops
  (validateEmail/Uuid/Ipv4/Ipv6, jsonValid, jsonSumIds, crc32, fnv1a64) now
  pack the coalesced group straight into a reusable scratch, write the native
  result into a reusable output buffer via new `_into` batch variants, and read
  each element out of it — no intermediate unpack array, no per-call native
  `Vec`/JS allocation. Wire format and semantics identical to `rust.batch`.
- **Reusable-output `_into` packed batch variants** (new native surface):
  `*BatchPackedInto(input, output) -> u32` for the 8 scalar-kind ops above,
  backed by bounds-checked generic writers (`write_bitset_batch_into`,
  `write_sum_batch_into`, `write_u32_batch_into` in `util/packed.rs`) that
  route through `run_packed_into` (input/output aliasing-guarded). Allocating
  variants kept as compat wrappers.
- **ETag batch direct-write**: `etag_batch_packed` writes the fixed 10/12-byte
  ETags straight into the shared output (no per-item `String` allocation).
- **Loader async benchmark persistence**: the 6 `load()` microbenchmarks now
  persist to `bench/results/loader/latest.json` (gitignored) so coalescing /
  cache-hit performance is comparable across runs.
- **Zero-DOM `format: "email"` fast path** (`fast_schema`): the schema fast
  path now compiles `format: "email"` (byte-parity replica of jsonschema
  0.48.5's validator — `email_address` local-part parse + RFC 1034 hostname +
  RFC 5891 A-label/punycode + RFC 5892 PVALID/contextual unicode-label rules)
  instead of falling back to the serde_json DOM path. The ingress
  `USER_SCHEMA` (which uses `format: "email"`) now validates every JSON-body
  POST zero-DOM. **Behavior fix**: jsonschema 0.48 disables format validation
  by default, so `format:` keywords were silently ignored before; both
  `SchemaValidator` and `IngressSchema` now build the reference with
  `should_validate_formats(true)` so `format: "email"` is actually enforced
  (invalid emails → 422) and the fast path stays byte-parity with the
  reference. Backed by a comprehensive email parity corpus + a 3000-case
  property test cross-checking fast vs the authoritative validator.
- **Byte-JSON overloads flip two losing scalar ops to wins**: `jwtSignBytes`
  (claims as JSON bytes — skips the napi `serde_json::Value` marshal) and
  `JwtSigner.signBytes` flip JWT sign from a ~1.3x loss to ~parity; `renderBytes`
  on `TemplateRenderer` flips template render from a ~1.5x loss to a ~1.37x win.
- **Pooled-output + string overloads** (additive, no breaking changes):
  `httpDateInto` (fixed 29-byte write into a reused buffer), `urlEncodeStr`/
  `urlDecodeStr` (string-in/string-out, no Uint8Array round-trip — the `rust.text`
  layer now uses them), plus new benchmark comparisons for the pooled
  `urlEncodeInto`/`urlDecodeInto`/`hexEncodeInto`/`httpDateInto` paths.
- **Scalar hot-path allocation cuts**: `hex_encode` writes bytes directly via
  the `HEX_LOWER` table (no per-nibble `char::push`; ~20% faster, pooled path
  ~1.5x faster); `url_decode` exact-size decode + jitter-tail elimination
  (~44% faster avg); `url_encode` exact-size allocation; `url_encode_query`
  reuses one scratch buffer instead of a fresh `vec` per key/value;
  `media_type` match uses `memchr`; `json_escaped_len` now validates UTF-8 in
  the SAME pass as the memchr3 escape scan (was two full passes) with a
  `len == bytes written` invariant corpus.

### Added

- **Real-world Rust test coverage** (+75 tests, `cargo test` 273 → 348):
  json_patch RFC 6902 gaps (`test`/`move`/`copy` edge cases, invalid `~2`
  escape) + the rayon **parallel** batch path (order-preserving success and
  deterministic single-failure index); `http_parser` wire-edge tests (incomplete
  requests, HTTP/1.0, >64 headers, obs-fold/duplicate headers, absolute-form,
  null bytes — previously untested); ingress pipeline end-to-end (schema → 422,
  rate-limit → 429, CORS preflight 204/403, header/query `Limits` → 431/414,
  https flag, cookie/query JSON output, unicode + truncated-multibyte query);
  multipart edge cases (quoted semicolons, boundary-like data, epilogue, missing
  `name`, empty filename, field-count limits, CRLF-only headers); fast_schema
  invalid-UTF-8/malformed bytes + `min/maxProperties` distinct parity; direct
  unit tests for `util/packed`, `util/batch_core`, `crypto/hashing`,
  `ingress/options` (`Limits` defaults/merge).
- **TS tests** (+9): runtime-detection seam (`runtime.test.ts`),
  `buildRouteHandlers` route wiring incl. a live end-to-end GET
  (`server.test.ts`), `gatherRawHeaders` vs `gatherRawHeadersPacked` parity and
  shared size guards, json-patch batch index-bearing errors.
- **Node enterprise tests** (+4): HTTP/1.0 requests (connection closes),
  413 with `Connection: close`, concurrent multi-socket requests, and
  `idleTimeout` closing idle keep-alive sockets.

### Removed (breaking)

- Public benchmark-only exports: `native` (JS baselines), `jsonRowsBytes` /
  `createJsonRows` / `JsonRow`, and the deprecated `rustBatch` alias (use
  `rust.batch`).

### Changed

- **Ingress TS layer**: broke the `handlers.ts ↔ routes/*` import cycle by
  moving `BakedContext` + `OptimizedIngressHandler` into `types.ts`;
  deduplicated the synchronous-callback guards into `assertSyncCallback`;
  named the method-kind magic numbers (`METHOD_KIND_UNKNOWN`,
  `METHOD_KIND.OPTIONS`); moved the bench-only `sortKeys` out of `shared/`;
  added JSDoc to the four ingress factories and the `rust` const; documented
  the eager dlopen in `constants.ts`.
- **Rust hardening**: removed dead symbols (`hex_encode_upper`,
  `fast_hash_seeded`, `VecWriter::{push,len}`); replaced request-path `expect`s
  with proper `Result` handling (`rate_limit.rs` `get_or_insert_mut`,
  `ip_trust.rs` error propagation); added SAFETY docs at the `unsafe`
  output-slice sites; added `//!` module docs; corrected stale file-header
  paths after the domain-folder restructure.
- **JSON Patch hardening** (`json_patch_ops.rs`): rewrote the module with a
  pure-Rust core (`apply_json_patch_bytes` / `run_json_patch_batch`) separated
  from the `#[napi]` boundary; bounded input/output guards (a chained RFC 6902
  `copy` can grow output exponentially — oversized results are now rejected
  rather than returned); output capacity heuristic ≈ document size (was
  `doc + patch + 32`); and context-rich errors (`invalid document` /
  `invalid patch` / `apply failed`). Expanded the test suite to 27 cases
  covering all six patch operations, real-world documents, Unicode,
  nested/escaped paths, size guards, and batch parity.

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
- **Performance-annotated surface.** Added `castrum.proven` — an export of the FULL
  `rust.*` surface (`export const proven = rust`) whose JSDoc carries each function's
  measured performance vs its JS baseline via `@performance`/`@deprecated` annotations
  (generated by `bun run check:annotate`). `PROVEN_SURFACE` (`src/shared/proven.ts`)
  is the single source of truth for the classifications (statuses
  proven/parity/not-competitive/unmeasured). Functions that lose to their JS baseline
  (e.g. `jsonParse` vs `JSON.parse`, schema validation vs `ajv`, `urlEncode`/`urlDecode`
  on the baseline CPU, `jwtSign`, `brotliCompress`, `templateRender`) are marked
  `@deprecated` rather than filtered out. New `scripts/check-proven.ts` audits the
  registry against `bench/results/cpu/latest.json` (`bun run check:proven`, with
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