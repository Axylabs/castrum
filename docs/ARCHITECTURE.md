# Architecture Guide

## Overview

castrum is a **hybrid Bun + Rust** runtime benchmark package that provides high-performance backend primitives through a NAPI (Native API) bridge. The architecture is designed for zero-copy data transfer between TypeScript and Rust, with batching support for high-throughput scenarios.

---

## Two-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript Layer                          │
│                                                             │
│  Purpose: API ergonomics, runtime safety, async handling    │
│  Runtime: Bun (JavaScriptCore)                               │
│  Pattern: Factory functions, lazy evaluation, batching       │
└──────────────────↕ NAPI Bridge (napi-rs) ↕─────────────────┘
│                                                             │
│                    Rust Layer (cdylib)                       │
│                                                             │
│  Purpose: Performance-critical computation, I/O handling     │
│  Allocator: mimalloc (global)                                │
│  Pattern: Stateless functions, pre-allocated buffers         │
└─────────────────────────────────────────────────────────────┘
```

### NAPI Bridge

The bridge between TypeScript and Rust is provided by [napi-rs](https://napi.rs/) v3. Key characteristics:

- **Zero-copy buffer sharing**: `Uint8Array` objects are passed by reference to Rust, avoiding serialization
- **Synchronous calls**: All functions are synchronous, running on the main JS thread
- **Thread pool**: Rayon is available for parallel CPU-bound work

---

## Module Architecture

### Rust Modules

```
rust/
├── lib.rs                 ── Crate root: module declarations, global allocator
│
├── Core Pipeline:
│   ├── ingress.rs         ── Main NAPI Ingress class, pipeline orchestration
│   ├── cors.rs            ── CORS engine (origin matching, preflight evaluation)
│   ├── rate_limit.rs      ── Token-bucket rate limiter (per-IP keyed)
│   ├── ip_trust.rs        ── IP resolution (X-Forwarded-For, X-Real-IP)
│   └── proxy.rs           ── HTTPS detection, URL extraction
│
├── Parsers:
│   ├── http_parser.rs     ── HTTP request header parsing (via httparse)
│   ├── query_parser.rs    ── Query string → key-value pairs
│   └── cookie_parser.rs   ── Cookie header → key-value pairs
│
├── Validation:
│   └── validation.rs      ── Email, UUID, IPv4, IPv6 validation
│
├── JSON:
│   ├── json_ops.rs        ── JSON validity check, sum-by-keys
│   ├── json_patch_ops.rs  ── JSON Patch (RFC 6902) operations
│   ├── json_schema.rs     ── JSON Schema validation (via jsonschema crate)
│   └── json_ser.rs        ── JSON serialization helpers (cookies, query, body)
│
├── Crypto:
│   ├── hashing.rs         ── FNV-1a, fast hashing (xxhash)
│   ├── hmac_sha256.rs     ── HMAC-SHA256 sign & verify (via aws-lc-rs)
│   └── random_token.rs    ── Cryptographically secure random tokens
│
├── Data:
│   ├── url_codec.rs       ── URL percent-encode/decode
│   ├── mime_lookup.rs     ── MIME type from file extension
│   └── websocket.rs       ── WebSocket accept key generation
│
├── Batch:
│   └── batch.rs           ── Batch processing engine
│
├── Utilities:
│   ├── method.rs          ── HTTP method enum + kind mapping
│   ├── headers.rs         ── Header pack/unpack with limits
│   ├── output.rs          ── Output buffer layout constants & writers
│   ├── terminal.rs        ── Terminal response builders (errors)
│   └── util.rs            ── Core utilities (PackedIter, VecWriter, etc.)
│
└── Constants:
    └── ingress_constants.rs ── NAPI-exported layout constants
```

### TypeScript Modules

```
src/
├── ingress/               ── HTTP ingress pipeline (TS layer)
│   ├── index.ts           ── Public API + async factory
│   ├── fast.ts            ── Fast synchronous handler (packed input)
│   ├── handlers.ts        ── Pre-baked handlers + createIngressServer (full_sync)
│   ├── constants.ts       ── Layout constants (from Rust NAPI)
│   └── packed-input.ts    ── Input buffer packing
│
├── native/                ── Native addon loading
│   └── index.ts           ── Module loader + type definitions
│
├── rust-ffi/              ── Rust FFI bindings
│   └── index.ts           ── Flat, complete FFI API
│
├── baseline/              ── JS baseline implementations
│   ├── index.ts           ── Aggregator
│   └── tasks/             ── Individual baseline tasks
│       ├── cookie.ts      ── Cookie parsing baseline
│       ├── hashing.ts     ── Hashing baseline
│       ├── hmac.ts        ── HMAC baseline
│       ├── http.ts        ── HTTP parsing baseline
│       ├── json.ts        ── JSON baseline
│       ├── json-patch.ts  ── JSON patch baseline
│       ├── mime.ts        ── MIME lookup baseline
│       ├── query.ts       ── Query parsing baseline
│       ├── token.ts       ── Token generation baseline
│       ├── url.ts         ── URL codec baseline
│       ├── validation.ts  ── Validation baseline
│       └── websocket.ts   ── WebSocket baseline
│
├── bench/                 ── Benchmark framework
│   ├── index.ts           ── Benchmark orchestrator
│   ├── assert.ts          ── Result assertions
│   ├── checks.ts          ── Correctness checks
│   ├── checksum.ts        ── Checksum verification
│   ├── comparisons.ts     ── Comparison reports
│   ├── concurrent-worker.ts ── Concurrent worker pool
│   ├── fixtures.ts        ── Test fixtures
│   ├── measure.ts         ── Measurement utilities
│   ├── now.ts             ── High-resolution timer
│   ├── report.ts          ── Report generation
│   ├── run.ts             ── Benchmark runner
│   ├── types.ts           ── Type definitions
│   └── tasks/             ── Benchmark task implementations
│       ├── complex.ts     ── Complex operation benchmarks
│       ├── concurrent.ts  ── Concurrency benchmarks
│       ├── cookie.ts      ── Cookie benchmarks
│       ├── hashing.ts     ── Hashing benchmarks
│       ├── hmac.ts        ── HMAC benchmarks
│       ├── http.ts        ── HTTP benchmarks
│       ├── index.ts       ── Task aggregator
│       ├── json.ts        ── JSON benchmarks
│       ├── json-patch.ts  ── JSON patch benchmarks
│       ├── mime.ts        ── MIME benchmarks
│       ├── query.ts       ── Query benchmarks
│       ├── stress.ts      ── Stress benchmarks
│       ├── token.ts       ── Token benchmarks
│       ├── url.ts         ── URL benchmarks
│       ├── validation.ts  ── Validation benchmarks
│       └── websocket.ts   ── WebSocket benchmarks
│
├── data/                  ── Data utilities
│   └── json-rows.ts       ── JSON row serialization
│
└── shared/                ── Shared utilities
    ├── bytes.ts           ── Text encoder/decoder
    ├── json.ts            ── JSON helpers
    └── packed.ts          ── Binary packing utilities
```

> **Two ingress consumption paths** (see `docs/INGRESS.md`):
> 1. `src/ingress/fast.ts` (`createIngressFast`) — JS packs headers
>    (`IngressInputPacker`) → Rust `handle_request_packed`. Wire format from
>    `buildTerminalResponse`: `{"error":{code,status,message,requestId}}`,
>    `x-ratelimit-*`.
> 2. `src/ingress/handlers.ts` (`createIngressHandler` + route factories +
>    `createIngressServer`) — Rust packs internally via
>    `handle_request_full_sync`. Different wire format: success
>    `{"ok":true,...,"requestId":...}`, errors
>    `{"ok":false,"error":{code,message}}`, `ratelimit-*` headers. The
>    benchmark server (`bench/servers/ingress-server.ts`) uses this path and
>    re-exports the pre-baked functions.

---

## Data Flow

### Ingress Pipeline (Request Processing)

```
Request
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  TypeScript: packHeaders()                                    │
│  - Pre-encoded header names (cookie, origin, xff, etc.)      │
│  - Binary packing with length-prefixed (u16 + u32) format    │
│  - TLS header buffer (8KB, recycled across calls)            │
└──────────────────┬───────────────────────────────────────────┘
                   │ packed headers + URL bytes + method kind
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Rust: Ingress::handle_request_packed()                       │
│                                                               │
│  1. Parse packed input (method, url, ip, rid, headers)       │
│  2. IP trust resolution                                       │
│  3. HTTPS detection                                           │
│  4. CORS evaluation                                           │
│  5. Rate limiting check                                       │
│  6. Body size guard                                           │
│  7. JSON validation & schema check                            │
│  8. Cookie parsing → output buffer                             │
│  9. Query parsing → output buffer                              │
│  10. Optional metadata JSON                                    │
│  11. Write output header (verdict, status, flags, ...)        │
└──────────────────┬───────────────────────────────────────────┘
                   │ output buffer
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  TypeScript: FastIngressResult.refresh()                      │
│  - Read output header fields from binary buffer              │
│  - Store slices for lazy decode (cookies, query, body)       │
│  - Caller inspects result and builds Response                │
└──────────────────────────────────────────────────────────────┘
```

### Batch Processing

```
Multiple Inputs
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  TypeScript: packBatch()                                      │
│  - Pack each input into binary format with length prefix     │
│  - Single Uint8Array sent to Rust                             │
└──────────────────┬───────────────────────────────────────────┘
                   │ packed batch
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Rust: Validator::validateBatchPacked()                       │
│  - Iterate over packed inputs in a tight loop                │
│  - Process each through validation pipeline                   │
│  - Write results as packed output (bitset or length-prefixed)│
└──────────────────┬───────────────────────────────────────────┘
                   │ packed results
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  TypeScript: unpackBitset() / unpackByteResults()             │
│  - Extract individual results from packed output             │
│  - Map back to original inputs                                │
└──────────────────────────────────────────────────────────────┘
```

---

## Output Buffer Layout

The output buffer is a binary format shared between Rust and TypeScript. All offsets are defined in `rust/output.rs` and exported via `rust/ingress_constants.rs` to `src/ingress/constants.ts`.

```
Offset (bytes)
├─  0: OUT_VERDICT          (u8)    0=pass, 1=terminal
├─  1: OUT_ERROR_CODE       (u8)    Error code enum
├─  2: OUT_STATUS           (u16)   HTTP status code (LE)
├─  4: OUT_FLAGS            (u32)   Bitfield of FLAG_* values (LE)
├─  8: OUT_RATE_LIMIT       (u32)   Rate limit ceiling (LE)
├─ 12: OUT_RATE_REMAINING   (u32)   Remaining requests (LE)
├─ 16: OUT_RATE_RESET       (u64)   Rate limit reset timestamp ms (LE)
├─ 24: OUT_RETRY_AFTER      (u64)   Retry-After duration ms (LE)
├─ 32: OUT_COOKIES_JSON_LEN (u32)   Cookie JSON length (LE)
├─ 36: OUT_QUERY_JSON_LEN   (u32)   Query JSON length (LE)
├─ 40: OUT_HEADER_VARIANT   (u8)    Header variant index
├─ 44: OUT_BODY_JSON_LEN    (u32)   Body metadata JSON length (LE)
├─ 48: OUT_DATA_START       ─── Variable-length data starts here
│      ├── Cookie JSON string (if present)
│      ├── Query JSON string (if present)
│      └── Body metadata JSON (if emitMetadataJson enabled)
```

### Flags (bitfield)

| Flag | Bit | Description |
|------|-----|-------------|
| `FLAG_HAS_COOKIES` | 0 | Cookie data present in output |
| `FLAG_HAS_QUERY` | 1 | Query data present in output |
| `FLAG_BODY_VALID_JSON` | 2 | Body is valid JSON |
| `FLAG_SCHEMA_VALID` | 3 | Body passes JSON Schema validation |
| `FLAG_CORS_ALLOWED` | 4 | CORS origin allowed |
| `FLAG_IS_PREFLIGHT` | 5 | Request is a CORS preflight |
| `FLAG_RATE_LIMITED` | 6 | Rate limit exceeded |
| `FLAG_HTTPS` | 7 | Request is HTTPS (detected or configured) |
| `FLAG_TRUSTED_PROXY` | 8 | Request from trusted proxy |
| `FLAG_BODY_TRUNCATED` | 9 | Output data truncated due to buffer size |

### Error Codes

| Code | Value | Description |
|------|-------|-------------|
| `ERR_CODE_NONE` | 0 | No error |
| `ERR_CODE_CORS_PREFLIGHT` | 1 | CORS preflight rejected |
| `ERR_CODE_RATE_LIMITED` | 2 | Rate limit exceeded |
| `ERR_CODE_BODY_TOO_LARGE` | 3 | Request body exceeds maxBodyBytes |
| `ERR_CODE_INVALID_JSON` | 4 | Invalid JSON in body |
| `ERR_CODE_SCHEMA_VALIDATION` | 5 | Schema validation failed |
| `ERR_CODE_BAD_REQUEST` | 6 | Malformed request |
| `ERR_CODE_REQUEST_TOO_LARGE` | 7 | Request headers/URL too large |
| `ERR_CODE_INTERNAL` | 8 | Internal server error |

---

## Memory Management

1. **Global allocator**: mimalloc (`MiMalloc`) for fast, scalable allocation
2. **Buffer reuse**: Output buffers are recycled across requests where possible
3. **Zero-copy**: `Uint8Array` passed to Rust functions are used in-place, not copied
4. **Slice overlap detection**: Rust checks for input/output buffer overlap and copies if needed
5. **Thread-local caches**: Header buffers use thread-local recycling to reduce allocation pressure

---

## Concurrency Model

- **Synchronous calls**: Run on the main JS thread (Bun's event loop)
- **Rayon**: Available for parallel CPU-bound work (e.g., batch validation)
- **Rate limiter**: Uses `parking_lot::Mutex` for low-contention access

---

## Dependency Graph

```
[ingress] ────┬─── [cors] ──── [headers] ──── [method]
              ├─── [rate_limit] ─── [ip_trust]
              ├─── [proxy]
              ├─── [output] ──── [terminal]
              ├─── [json_ser] ──── [util]
              ├─── [query_parser]
              └─── [cookie_parser]
              [hashing] ──── [hmac_sha256]
              [validation]
              [json_ops] ──── [json_patch_ops]
              [json_schema]
              [url_codec]
              [mime_lookup]
              [websocket]
              [random_token]
              [batch]
              [http_parser]