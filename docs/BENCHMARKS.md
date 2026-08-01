# Benchmarks Guide

This document describes the benchmark framework, how to run benchmarks, and how to interpret results.

---

## Overview

The benchmark system compares Rust FFI implementations against pure JavaScript/Bun baseline implementations. It measures throughput (ops/sec), latency (mean/percentiles), and memory allocation.

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
```

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
- **Concurrency**: up to 10,000

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
  └─ Loads benchmark tasks from src/bench/tasks/
       ├── hashing.ts       Compare Rust fnv1a64 vs JS TextEncoder + hash
       ├── validation.ts    Compare Rust validation vs validator library
       ├── json.ts          Compare Rust sonic-rs vs JSON.parse
       ├── cookie.ts        Compare Rust cookie parser vs cookie-es
       ├── query.ts         Compare Rust query parser vs manual parse
       ├── hmac.ts          Compare Rust HMAC vs Web Crypto API
       ├── mime.ts          Compare Rust mime_guess vs mime-types
       ├── token.ts         Compare Rust getrandom vs crypto.randomBytes
       ├── url.ts           Compare Rust URL codec vs encodeURIComponent
       ├── websocket.ts     Compare Rust ws accept key vs manual
       ├── json-patch.ts    Compare Rust json-patch vs fast-json-patch
       ├── http.ts          Compare Rust httparse vs manual
       ├── complex.ts       Combined operations
       └── stress.ts        Concurrent load tests
```

Each task runs:
1. **Warmup**: 100ms to JIT-compile JavaScript
2. **Measurement**: Fixed duration (default 2000ms) in a tight loop
3. **Operations counted**: Number of function calls completed
4. **Result**: Ops/sec calculated from wall-clock time

---

## HTTP Server Architecture

```
bench/servers/
├── bun-server.ts       # Raw Bun.serve with manual routing
├── elysia-server.ts    # Elysia framework
├── ingress-server.ts   # Ingress (this project) optimized handler
└── shared.ts           # Shared route handlers
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