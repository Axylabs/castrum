# Benchmarks Guide

This document describes the benchmark framework, how to run benchmarks, and how to interpret results.

---

## Overview

The benchmark system compares the Rust implementations against pure JavaScript/Bun baseline implementations. It measures throughput (ops/sec), latency (mean/percentiles), and memory allocation. Under Bun the `rust:*` side runs through the PRIMARY `bun:ffi` transport (NAPI is the fallback); the CPU bench warns — or hard-fails with `CASTRUM_BENCH_FFI=1` — if the ffi transport is not live.

### Benchmark Types

| Type | Description |
|------|-------------|
| **Unit benchmarks** | Individual function comparisons (hashing, validation, JSON, etc.) |
| **HTTP benchmarks** | Full HTTP server comparisons (Bun vs Elysia vs Ingress) |
| **Batch benchmarks** | Throughput for batch operations |
| **Stress benchmarks** | Performance under load |
| **Concurrency benchmarks** | Performance with multiple concurrent requests |

---

## Running Benchmarks

### Unit Benchmarks

```bash
# Run all unit benchmarks
bun bench.ts
```

### Bun built-ins diagnostic set ("don't reinvent the wheel")

`bun run check` also races castrum ops against **Bun's native built-ins**
(`Bun.hash`, `Bun.password`, `Bun.CryptoHasher`, `Bun.gzipSync`,
`Bun.randomUUIDv7`) as a diagnostic set:

- Task names use the **`diag:`** prefix (not `native:`/`rust:`) so they stay out
  of the shipped-op `native:`/`rust:` comparisons — they are informational.
- Sources: `src/baseline/tasks/bun-builtins.ts` (Bun-only baselines, guarded
  with `typeof Bun` so the module still loads under Node),
  `src/bench/tasks/bun-builtins.ts`, comparisons in `src/bench/comparisons.ts`.
- **Runtime honesty guard**: a Bun API must be verified to actually execute real
  work before its result is trusted. The first run produced false "wins"
  (brotli 156x, validators 3-5x) because Bun 1.4 has **no**
  `Bun.brotliCompressSync` and **no** `Bun.validators` — those pairs were
  removed, not reported.
- Results and the keep/delegate/add decisions live in
  `docs/bun-builtins-decision-matrix.md`.

### HTTP Benchmarks

```bash
# Run all HTTP scenarios
bun run bench:http

# Run specific scenario
bun run bench:http:smoke     # Light load, quick health check
bun run bench:http:stress    # High concurrency, short duration
bun run bench:http:heavy     # Heavy JSON payloads
bun run bench:http:crud      # CRUD operations
bun run bench:http:spike     # Burst traffic patterns
bun run bench:http:soak      # Long duration (endurance)
bun run bench:http:storm     # Very high concurrency burst
bun run bench:http:boundary  # Edge case payloads

# Compare specific frameworks
bun run bench:http:elysia    # Run only Elysia vs baseline
bun run bench:http:ingress   # Run only Ingress vs baseline
bun run bench:http:bun-only  # Run only raw Bun vs baseline

# Run all heavy scenarios
bun run bench:http:all-heavy

# Max-throughput cross-check (autocannon — no Bun fetch cap)
bun run bench:http:ac          # all servers, 03-stress weighted mix
bun run bench:http:stress:ac   # 03-stress mix only

# Single-path static comparison (fastest, most stable signal — SERVER-BOUND
# by default with AC_CONNECTIONS=2000; use this for ceiling comparisons):
#   AC_PATH=/api/users AC_RUNS=3 node bench/autocannon-stress.mjs
#   AC_PATH=/api/users AC_METHOD=POST AC_BODY='{"id":1,"name":"x"}' \
#     AC_CONTENT_TYPE=application/json AC_RUNS=3 \
#     node bench/autocannon-stress.mjs
#   # median-of-N (see §Single-core): run-major interleaving — every server is
#   # measured once per round, so the median compares servers over the same
#   # load windows on a noisy host.
#
# The DYNAMIC 03-stress mix (default, no AC_PATH) is CLIENT-bound (~47k here —
# autocannon's setupRequest generation is the cap, identical across servers);
# use it only for shape/behavior validation, not ceiling comparisons.
#
# Multi-core scaling (SO_REUSEPORT — the way to exceed the single-core ceiling):
#   AC_INSTANCES=4 node bench/autocannon-stress.mjs
#   (ingress/router only — they read INGRESS_REUSE_PORT=1)
```

### Bun `fetch()` concurrency cap (read this before interpreting HTTP results)

Bun's `fetch()` limits the number of **simultaneous** requests to **256 by
default** (`BUN_CONFIG_MAX_HTTP_REQUESTS`, max 65,336). When a scenario's
`maxConcurrent` exceeds that cap, the excess requests queue **FIFO client-side**
and the run measures the *generator*, not the server — the classic signature is
a sub-ms `p50` with a multi-second tail and a flat RPS wall across every server.

- All `bench:http:*` scripts set `BUN_CONFIG_MAX_HTTP_REQUESTS=65535` for you.
- `bench/http/run-bench.ts` warns if a selected scenario exceeds the effective cap.
- For **max-throughput** server comparisons use **autocannon**
  (`bench/autocannon-stress.mjs`, run with `node`): it has no such cap, uses a
  real socket pool, scales across worker threads, and reports RPS + latency
  percentiles natively. It replicates the `03-stress` weighted flow mix
  (50% GET /api/users?q=…&page=…, 30% POST /api/users, 20% GET /health).
- **Two autocannon gotchas** (both fixed in the runner):
  1. `requestGenerator` is CLI-ONLY — the library silently ignores it (every
     request then goes to `GET /` → 404 → "0 2xx"). The runner uses the
     library's `requests: [{ setupRequest }]` API instead.
  2. `result.workers` is a count (`opts.workers`), not an array — the report no
     longer treats it as a per-worker array.

### Single-core ceiling & multi-core scaling (measured 2026-08-21)

All four servers are **single-process `Bun.serve`** (one event loop), so they
pin at a per-core ceiling on this machine. The host is load-noisy, so use the
**median-of-N** runner (`AC_RUNS=N`, default 1) with **run-major interleaving** —
every server is visited once per round, so a single slow window affects all
servers' run-`i` equally and the median compares servers over the same load
windows (the old server-major order biased later servers into noisier windows).

> **Methodology (2026-08-21 — replaces the 2026-08-16 snapshot).** Two
> measurement traps were identified and the numbers below use the config that
> avoids both:
>
> 1. **The dynamic `setupRequest` mix is CLIENT-bound, not server-bound.** The
>    03-stress weighted mix caps every server at ~47k RPS on this host because
>    autocannon's per-request `setupRequest` (random string generation + JSON
>    stringify) is the bottleneck — all four servers report the identical
>    ~47k. **Use static-path runs** (`AC_PATH=…`, `AC_METHOD=…`, `AC_BODY=…`)
>    for ceiling comparisons; the mix only validates shape/behavior.
> 2. **`AC_PIPELINING>1` is a client/transport artifact under GET here.**
>    With pipelining 10, even raw Bun collapses to ~8.6k on `GET /health`
>    (autocannon pipelining + Bun's HTTP/1.1 handling), while the same server
>    does 52k at pipelining 1 — so pipelining does NOT expose the ceiling on
>    this stack. The server-bound config is **`AC_PIPELINING=1` + enough
>    connections** (≥2000 on this host) to drive the event loop.
>
> The server-bound snapshot below is **static-path, `AC_CONNECTIONS=2000`,
> `AC_PIPELINING=1`, `AC_RUNS=3`** (median-of-3), single instance.

Current medians (static path, 2000 connections, pipelining 1, single instance):

- `GET /api/users?q=testquery&page=1` (query + cookies + CORS + metadata
  envelope): **bun 52.5k, elysia 52.4k, ingress 95.9k, router 95.8k RPS** —
  ingress/router ~**+83% vs bun**, with a tighter tail (router p99.9 195ms vs
  bun 800ms).
- `POST /api/users` (JSON body, fast-path schema validation):
  **bun 49.5k, elysia 49.5k, ingress 95.8k, router 93.5k RPS** — ~**+89–94%
  vs bun**. The pre-optimization ingress POST gap (≈ −24% vs bun, 2026-08-16)
  is long closed; the current gap is a large WIN (JS hot-path elimination +
  single-pass body validation + copy-mode response default).
- **Response mode matters more than any remaining pipeline cost**: copy mode
  (default) vs zero-copy on `POST /api/users`: **66.4k vs 45.1k RPS (+47%)** —
  per-request `ReadableStream` construction is the cost, not the native body
  write. Both servers default to copy mode; `INGRESS_ZERO_COPY=1` opts back in
  for large-payload deployments.
- Per-request cost breakdown (`bun bench/cost/router-cost.ts` +
  `router-minimal-breakdown.ts`, min-of-5): the router's minimal route `run()`
  is ~310ns (native pruned pipeline ~115ns + response/run machinery ~150ns +
  refresh 25ns + rid 12ns + header gather 4ns). A `syncResponder` experiment
  that threaded a known-sync hint through `run()` was REVERTED as **slower**
  (−6 to −94ns across 3 runs) — the per-request `assertSyncCallback` +
  `instanceof Response` checks are already JIT-inlined and free on JSC; the
  extra param/branch deoptimized the shared hot function. Conclusion: the
  `run()` machinery is NOT real overhead.
- **To exceed the single-core ceiling**, run multiple server processes on the
  same port via SO_REUSEPORT: `AC_INSTANCES=N` (ingress/router only — they read
  `INGRESS_REUSE_PORT=1`; bun/elysia do not set it). On this noisy host the
  scaling signal is unreliable (4 instances: 52.8k median with one run at
  91.9k; 8 instances: 48.5k — the load-noise band swallows the gain), so for
  clean multi-core numbers run autocannon on a separate host. The mechanism
  (N event loops sharing the accept queue) is the documented way to exceed the
  single-process ceiling.

---

## HTTP Benchmark Scenarios

Each scenario targets a specific performance aspect:

### 01-smoke
- **Goal**: Quick health check (health, GET, POST mix)
- **Duration**: ~10 seconds
- **Concurrency**: up to 50

### 02-load
- **Goal**: Sustained mixed load (warm-up → sustain → cool-down)
- **Duration**: ~120 seconds
- **Concurrency**: up to 1,000
- **Traffic**: GET/POST mix with cookies, health

### 03-stress
- **Goal**: Ramp to maximum throughput
- **Duration**: ~100 seconds (5 × 20s ramp phases)
- **Concurrency**: up to 2,000 (higher on a single machine only deepens the
  client-side fetch queue — the generator can't drive 10k usefully; see the
  Bun fetch-cap note above. For true max-throughput use `bench:http:ac`.)

### 04-spike
- **Goal**: Burst resilience (baseline → spike → recovery)
- **Duration**: ~100 seconds
- **Concurrency**: up to 8,000 (spikes up to 5,000 req/s)

### 05-soak
- **Goal**: Endurance/stability
- **Duration**: ~600 seconds (10 minutes)
- **Concurrency**: up to 1,000

### 06-edge-cases
- **Goal**: Malformed / edge-case payloads
- **Duration**: ~30 seconds
- **Concurrency**: up to 200
- **Traffic**: invalid JSON, schema failures, 404/405/415/422, Unicode, oversize query

### 07-cors-preflight
- **Goal**: CORS preflight storm (allowed + disallowed origins)
- **Duration**: ~30 seconds
- **Concurrency**: up to 500

### 08-rate-limit
- **Goal**: Rate limiting (under limit → over limit → recovery)
- **Duration**: ~40 seconds
- **Concurrency**: up to 1,000

### 09-large-payload
- **Goal**: Large payload handling
- **Duration**: ~30 seconds
- **Concurrency**: up to 100
- **Payload**: large binary + large JSON arrays

### 10-mixed-realistic
- **Goal**: Realistic mixed traffic (origins, cookies, auth)
- **Duration**: ~60 seconds (ramp)
- **Concurrency**: up to 5,000

### 11-concurrent-burst
- **Goal**: High-concurrency bursts with pauses
- **Duration**: ~35 seconds
- **Concurrency**: up to 8,000

### 12-slowloris
- **Goal**: Slow clients
- **Duration**: ~60 seconds
- **Concurrency**: up to 500

### Heavy JSON scenarios (`13`–`20`)

`13-heavy-json-nested` … `20-validation-storm` stress schema validation with nested, array-heavy, wide, CRUD-mix, spike, soak, large-body, and storm payloads. Run them with `bun run bench:http:heavy`.

---

## Interpreting Results

### Report Format

Results are saved to `bench/results/<framework>/<scenario>.bench.md` and include:

```md
# Benchmark Report: bun / 01-smoke

| Metric | Value |
|--------|-------|
| Duration | 10.0s |
| Requests | 125,432 |
| Throughput | 12,543 req/s |
| Mean Latency | 0.79ms |
| p50 Latency | 0.72ms |
| p95 Latency | 1.13ms |
| p99 Latency | 2.45ms |
| Max Latency | 15.67ms |
| Errors | 0 |
```

### Comparison Reports

When comparing multiple frameworks, differences are expressed as:

- **Speedup**: `2.45x` (Rust is 2.45x faster than JS)
- **Slowdown**: `0.82x` (Rust is 0.82x the speed of JS, i.e., 18% slower)
- **% Improvement**: `+145%` throughput increase

### Key Metrics

| Metric | What It Measures |
|--------|-----------------|
| **Throughput** | Requests per second — higher is better |
| **Mean Latency** | Average response time — lower is better |
| **p50/p95/p99** | Percentile latencies — lower is better |
| **Max Latency** | Worst-case response time — should be bounded |
| **Error Rate** | Percentage of failed requests — should be 0% |

---

## Benchmark Architecture

```
bench.ts
  └─ Loads benchmark tasks from src/bench/tasks/ (34 tasks)
       ├── hashing.ts       Compare Rust fnv1a64 vs JS TextEncoder + hash
       ├── validation.ts    Compare Rust validation vs validator library
       ├── json.ts          Compare Rust sonic-rs vs JSON.parse
       ├── http.ts          Compare Rust httparse vs manual
       ├── complex.ts       Combined operations
       ├── stress.ts        Concurrent load tests
       └── ...              (aead, accept, compress, cookie-sign, csrf, encoding, etag,
                            form, json-schema, jwt, media-type, multipart, password,
                            streaming, template, url-join, ... — full list in docs/REPO_MAP.md)
```

Each task runs:
1. **Warmup**: 100ms to JIT-compile JavaScript
2. **Measurement**: Fixed duration (default 2000ms) in a tight loop
3. **Operations counted**: Number of function calls completed
4. **Result**: Ops/sec calculated from wall-clock time

### Benchmark controls

| Env / flag | Effect |
|------------|--------|
| `CASTRUM_BENCH_BATCH_SIZE` | Batch size for sub-µs operations (default `64`). Batching amortizes the timer/measurement overhead for very fast ops. |
| `HTTP_NO_SHAPE=1` | The HTTP load generator (`bench/http/load.ts`) skips response-shape `JSON.parse` for pure-throughput runs. |

---

## HTTP Server Architecture

```
bench/http/servers/
├── bun-server.ts       # Raw Bun.serve with manual routing
├── elysia-server.ts    # Elysia framework
├── ingress-server.ts   # Ingress (this project) optimized handler
├── router-server.ts    # Ingress per-route compiled-router variant (createIngressRouter)
└── shared.ts           # Shared route handlers, PORTS, env helpers
```

Each server implements the same routes for fair comparison:

- `GET /` — Plain text hello
- `GET /json` — JSON response
- `POST /json` — Echo JSON body
- `GET /id/:id` — Path parameter
- `POST /users` — User creation

---

## Environment

All benchmarks should be run on a dedicated machine for reproducible results:

- **CPU**: Modern x86_64 (Intel/AMD) or Apple Silicon
- **Memory**: 8GB+ RAM
- **OS**: Linux (recommended) or macOS
- **Bun**: Latest stable
- **Rust**: Latest stable (via rustup)

### Turbo Mode (Linux)

For consistent results on Linux, disable CPU frequency scaling:

```bash
sudo cpupower frequency-set --governor performance
```

Run benchmarks, then restore:

```bash
sudo cpupower frequency-set --governor powersave