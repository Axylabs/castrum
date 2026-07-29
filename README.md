# bun-rust-practical

**Enterprise-Grade Bun + Rust FFI Runtime Benchmark Package**

A high-performance Bun backend framework with Rust-accelerated FFI functions, providing production-grade HTTP ingress pipeline, validation, hashing, JSON processing, and more — all with benchmark-grade performance.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript (Bun) Layer                       │
│                                                                  │
│  index.ts (entry point)                                          │
│    ├── src/rust-ffi/     Raw Rust FFI bindings                   │
│    ├── src/native/       NAPI native addon loader                │
│    ├── src/ingress/      High-performance HTTP ingress pipeline  │
│    ├── src/baseline/     JS baseline (benchmark reference)       │
│    ├── src/data/         Data serialization utilities            │
│    └── src/shared/       Shared constants and helpers            │
│                                                                  │
├─────────────────── NAPI Bridge (napi-rs) ──────────────────────┤
│                                                                  │
│                     Rust (cdylib) Layer                          │
│                                                                  │
│  rust/lib.rs                                                     │
│    ├── Core Pipeline: ingress, cors, rate_limit, ip_trust        │
│    ├── Parsers:       http_parser, query_parser, cookie_parser   │
│    ├── Validation:    validation (email/uuid/IP)                 │
│    ├── JSON:          json_ops, json_patch_ops, json_schema,     │
│    │                  json_ser                                    │
│    ├── Crypto:        hashing, hmac_sha256, random_token         │
│    ├── Data:          url_codec, mime_lookup, websocket          │
│    ├── Batch:         batch, async_tasks                         │
│    ├── Utilities:     util, method, headers, output, terminal    │
│    └── Runtime:       runtime, export                             │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
bun install

# Build Rust native addon (release)
bun run build

# Run benchmarks
bun bench.ts

# Run tests
bun test
```

## Build

```bash
# Production build
bun run build

# Debug build
bun run build:debug
```

## Benchmarks

```bash
# Full benchmark suite
bun bench.ts

# HTTP server benchmarks
bun run bench:http

# Compare with specific frameworks
bun run bench:http:elysia   # vs Elysia
bun run bench:http:ingress  # vs Ingress (native)
bun run bench:http:bun-only # vs raw Bun

# Load patterns
bun run bench:http:smoke    # smoke test
bun run bench:http:stress   # stress test
bun run bench:http:heavy    # heavy JSON
bun run bench:http:crud     # CRUD operations
bun run bench:http:soak     # soak (endurance) test
bun run bench:http:storm    # storm (burst) test
bun run bench:http:boundary # boundary conditions
```

## API Reference

### Core Exports

```ts
import { rust, native } from "bun-rust-practical";

// `rust` — All Rust FFI native implementations
// `native` — JavaScript/Bun baseline implementations for benchmarking
```

### Sub-modules

| Import | Description |
|--------|-------------|
| `import { encoder, decoder } from "bun-rust-practical"` | Text encode/decode utilities |
| `import { packBatch, unpackBitset, unpackByteResults, unpackI64ArrayAsBigInt } from "bun-rust-practical"` | Batch packing utilities |
| `import { jsonRowsBytes, createJsonRows } from "bun-rust-practical"` | JSON row serialization |
| `import { createIngress, createIngressSync, createIngressFast } from "bun-rust-practical"` | HTTP ingress pipeline |

### Ingress Pipeline

The ingress system is a high-performance request processing pipeline that handles:

- **Method routing** — GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS
- **CORS evaluation** — Origin validation, preflight handling
- **Rate limiting** — Token-bucket per IP with configurable window
- **IP trust & proxy** — X-Forwarded-For, X-Real-IP resolution
- **HTTPS detection** — X-Forwarded-Proto based
- **Cookie parsing** — Structured JSON output
- **Query parsing** — Key-value pair extraction
- **JSON body validation** — Syntax + optional schema validation
- **Body size guarding** — Configurable max body size
- **Security headers** — HSTS, CSP, X-Frame-Options, etc.

```ts
// Fast synchronous handler (zero allocations per call)
import { createIngressFast } from "bun-rust-practical";

const handler = createIngressFast({
  cors: { allowOrigin: ["https://example.com"] },
  rateLimit: { limit: 100, windowMs: 60_000 },
  parseCookies: true,
  parseQuery: true,
});

// Inside a Bun server:
Bun.serve({
  port: 3000,
  async fetch(req) {
    return handler.run(req, req.headers.get("x-forwarded-for"), null, "", (result) => {
      if (result.ok) {
        return new Response("OK", { status: 200 });
      }
      return new Response("Error", { status: result.status });
    });
  },
});
```

### Individual Rust Functions

| Function | Description |
|----------|-------------|
| `crc32(input)` | CRC32 checksum |
| `fnv1a64(input)` | FNV-1a 64-bit hash |
| `hmacSha256(key, data)` | HMAC-SHA256 signature |
| `hmacSha256Verify(key, data, sig)` | HMAC-SHA256 verification |
| `jsonValid(input)` | JSON validity check |
| `jsonSumIds(input)` | Sum all numeric `id` fields in JSON |
| `jsonPatch(doc, patch)` | Apply JSON Patch (RFC 6902) |
| `mimeFromExtension(ext)` | MIME type from file extension |
| `randomToken(byteLen)` | Cryptographically secure random token |
| `urlEncode(input)` | URL percent-encoding |
| `urlDecode(input)` | URL percent-decoding |
| `validateEmail(input)` | Email validation |
| `validateUuid(input)` | UUID validation |
| `validateIpv4(input)` | IPv4 address validation |
| `validateIpv6(input)` | IPv6 address validation |
| `wsAcceptKey(key)` | WebSocket accept key generation |

### Batch Operations

All individual operations have batch variants for high-throughput processing:

- `jsonValidBatchPacked`, `validateEmailBatchPacked`, `validateUuidBatchPacked`
- `jsonSumBatchPacked`, `queryParseBatchPacked`, `cookieParseBatchPacked`
- `httpParseRequestBatchPacked`

Async variants available: `jsonValidBatchPackedAsync`, `validateEmailBatchPackedAsync`, etc.

---

## Project Structure

```
bun-rust-practical/
├── index.ts                 # Entry point / public API
├── index.d.ts               # Type declarations
├── bench.ts                 # Benchmark runner
├── build.rs                 # NAPI build script
├── Cargo.toml               # Rust dependencies & build config
├── package.json             # Node/Bun package config
├── tsconfig.json            # TypeScript config
│
├── rust/                    # Rust source (cdylib)
│   ├── lib.rs               # Crate root, module declarations
│   ├── export.rs            # Public Rust API re-exports
│   ├── runtime.rs           # Runtime abstraction trait
│   ├── ingress.rs           # NAPI ingress class
│   ├── cors.rs              # CORS engine
│   ├── rate_limit.rs        # Keyed rate limiter
│   ├── ip_trust.rs          # IP trust & proxy resolution
│   ├── http_parser.rs       # HTTP request parser
│   ├── query_parser.rs      # Query string parser
│   ├── cookie_parser.rs     # Cookie header parser
│   ├── validation.rs        # Email/UUID/IP validation
│   ├── hashing.rs           # FNV-1a & fast hashing
│   ├── hmac_sha256.rs       # HMAC-SHA256
│   ├── json_ops.rs          # JSON operations
│   ├── json_patch_ops.rs    # JSON Patch operations
│   ├── json_schema.rs       # JSON Schema validation
│   ├── json_ser.rs          # JSON serialization utilities
│   ├── url_codec.rs         # URL encode/decode
│   ├── mime_lookup.rs       # MIME type lookup
│   ├── websocket.rs         # WebSocket utilities
│   ├── random_token.rs      # Secure random token generation
│   ├── batch.rs             # Batch processing
│   ├── async_tasks.rs       # Async task management
│   ├── method.rs            # HTTP method enum
│   ├── headers.rs           # Header packing
│   ├── output.rs            # Output buffer layout
│   ├── terminal.rs          # Terminal response writers
│   ├── proxy.rs             # Proxy detection utilities
│   ├── util.rs              # Core utilities
│   └── ingress_constants.rs # NAPI-exported constants
│
├── src/                     # TypeScript source
│   ├── ingress/             # Ingress pipeline (TS layer)
│   │   ├── index.ts         # Public API + async factory
│   │   ├── fast.ts          # Fast synchronous handler
│   │   ├── constants.ts     # Layout constants (from Rust)
│   │   ├── packed-input.ts  # Input buffer packing
│   │   └── smoke.ts         # Smoke test helpers
│   ├── native/              # Native addon loader
│   │   ├── index.ts         # Module loading + type definitions
│   │   └── wrapper.ts       # Wrapper utilities
│   ├── rust-ffi/            # Raw FFI bindings
│   │   ├── index.ts         # Public exports
│   │   └── raw.ts           # Direct FFI calls
│   ├── baseline/            # JS baseline implementations
│   │   ├── index.ts         # Aggregator
│   │   └── tasks/           # Individual baseline implementations
│   ├── bench/               # Benchmark framework
│   ├── data/                # Data serialization
│   └── shared/              # Shared utilities
│
├── bench/                   # HTTP benchmark servers
│   ├── servers/             # Server implementations
│   └── run-bench.ts         # Benchmark runner
│
├── test/                    # Tests (see docs/testing.md)
├── docs/                    # Documentation
└── scripts/                 # Build/utility scripts
```

---

## Performance Characteristics

All Rust FFI functions are designed for **zero-allocation** paths where possible:

- **Ingress pipeline**: Single output buffer written by Rust, read by JS — minimal copies
- **Validation functions**: Pure CPU-bound, 10-100x faster than JS equivalents
- **Hashing**: SIMD-optimized crates under the hood
- **Batch operations**: Packed binary format minimizes NAPI boundary crossings
- **JSON parsing**: Uses `sonic-rs` (Rust) — one of the fastest JSON parsers available

---

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/unit/ingress/fast.test.ts

# Run tests with coverage
bun test --coverage
```

---

## License

MIT

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md).