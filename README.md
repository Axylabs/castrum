# castrum

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
│    ├── Batch:         batch                                       │
│    ├── Utilities:     util, method, headers, output, terminal    │
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
import { rust, native, rustBatch } from "castrum";

// `rust`      — All Rust FFI native implementations (flat, complete API)
// `native`    — JavaScript/Bun baseline implementations for benchmarking
// `rustBatch` — Back-compat alias === rust.batch
```

### Rust Utility API

`rust` is a single flat object exposing **every** native Rust utility with
optimized defaults baked in. Text-oriented operations also have ergonomic
string variants under `rust.text`.

| Namespace | Description |
|-----------|-------------|
| `rust.crc32(...)`, `rust.jsonValid(...)`, … | Scalar utilities (bytes in → typed out) |
| `rust.text.mimeFromExtension(".js")`, … | String ergonomics (string in → string/bool out) |
| `rust.batch.jsonValid(docs)`, … | High-throughput batch (arrays → unpacked results) |
| `rust.packed.jsonValidBatchPacked(p)`, … | Raw packed low-level variants + metadata |
| `rust.configure({ ... })` | Override defaults on the shared instance |

#### Scalar utilities

| Function | Returns |
|----------|---------|
| `crc32(input)` | `number` — CRC32 checksum |
| `fnv1a64(input)` | `bigint` — FNV-1a 64-bit hash |
| `hmacSha256(key, data)` | `Uint8Array` — HMAC-SHA256 signature |
| `hmacSha256Verify(key, data, sig)` | `boolean` |
| `jsonValid(input)` | `boolean` — JSON validity check |
| `jsonSumIds(input)` | `bigint` — sum of numeric `id` fields |
| `jsonPatch(doc, patch)` | `Uint8Array` — RFC 6902 result |
| `mimeFromExtension(ext)` | `Uint8Array` — MIME type |
| `randomToken(byteLen)` | `Uint8Array` — CSPRNG token |
| `urlEncode(input)` / `urlDecode(input)` | `Uint8Array` — percent encode/decode |
| `urlDecodeBytes(input)` | `Uint8Array` — strict %-decode (no UTF-8 check) |
| `validateEmail/Uuid/Ipv4/Ipv6(input)` | `boolean` |
| `wsAcceptKey(key)` | `Uint8Array` — WebSocket accept key |

Low-level / packed variants: `rust.httpParseRequestPacked`, `rust.queryParsePacked`,
`rust.cookieParsePacked`.

#### String ergonomics (`rust.text`)

```ts
rust.text.mimeFromExtension(".js");  // "text/javascript"
rust.text.mimeFromExtension("html"); // "text/html"
rust.text.urlEncode("a b");         // "a%20b"
rust.text.urlDecode("a%20b");       // "a b"
rust.text.wsAcceptKey(keyBase64);    // base64 accept key
rust.text.validateEmail("a@b.co");   // true
```

#### Batch operations (`rust.batch`)

All batch helpers accept `Uint8Array[]` and return unpacked, ready-to-use results:

```ts
const docs = [encoder.encode('{"id":1}'), encoder.encode('{"id":2}')];

rust.batch.jsonValid(docs);             // Uint8Array bitset (1 per doc)
rust.batch.crc32(docs);                 // Uint32Array
rust.batch.jsonSumIds(docs);            // BigInt64Array
rust.batch.queryParse(docs);            // Uint8Array[]
rust.batch.schemaValidate(validator, docs); // bitset
```

Raw packed + metadata variants (advanced): `rust.packed.*` mirrors the native
functions 1:1 (`jsonValidBatchPacked`, `jsonValidBatchCountPacked`,
`queryParseBatchTotalLenPacked`, …).

#### Configuring defaults

Defaults are selected automatically, and can be overridden:

```ts
// Defaults:
//   rayonThreads = max(1, hardwareConcurrency - 1)
//                  (env override: CASTRUM_RAYON_THREADS / RUST_RAYON_THREADS)
//   mimeCache    = true
//   hmacCache    = true

// Override per-instance options on the shared instance:
rust.configure({ mimeCache: false, hmacCache: false });

// Or create an isolated instance with custom defaults:
import { createRust } from "castrum";
const myRust = createRust({ mimeCache: false });
```

> **Thread pool note**: the rayon pool is process-wide and initialized **once**
> (native `OnceLock`) — the first initialization wins. Because importing the
> module initializes it with the default, set
> `CASTRUM_RAYON_THREADS` / `RUST_RAYON_THREADS` (or call
> `rust.configure({ rayonThreads })` / `createRust({ rayonThreads })` before any
> other pool use) to tune it. `mimeCache` / `hmacCache` are per-instance and can
> be toggled any time.

### Sub-modules

| Import | Description |
|--------|-------------|
| `import { encoder, decoder } from "castrum"` | Text encode/decode utilities |
| `import { packBatch, packPairs, unpackBitset, unpackByteResults, unpackI64ArrayAsBigInt, unpackU32Array } from "castrum"` | Batch/pair packing + unpacking utilities |
| `import { readPairsPacked, pairsToObject, readHttpPacked } from "castrum"` | Decode packed pairs / parsed HTTP buffers |
| `import { parseQueryString, parseCookieHeader } from "castrum"` | High-level string parsers (no hand-packing) |
| `import { jsonRowsBytes, createJsonRows } from "castrum"` | JSON row serialization |
| `import { createIngress, createIngressSync, createIngressFast } from "castrum"` | HTTP ingress pipeline (low-level) |
| `import { createIngressHandler, createIngressServer, readHandler, jsonWriteHandler, echoHandler, fallbackHandler } from "castrum"` | **Pre-baked** ingress handlers — route factories + Bun.serve builder |

```ts
import { parseQueryString, parseCookieHeader } from "castrum";

parseQueryString("a=1&b=2&tag=a&tag=b"); // { a: "1", b: "2", tag: ["a", "b"] }
parseCookieHeader("session=abc; theme=dark"); // { session: "abc", theme: "dark" }
```

> **Environment variables**: See [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) for the
> full reference of `INGRESS_*`, `CASTRUM_*` and `RUST_*` runtime variables.

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
import { createIngressFast } from "castrum";

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

#### Pre-baked handlers (recommended for servers)

`src/ingress/handlers.ts` provides ready-to-use route handlers and a `Bun.serve`
builder so **any system can consume the optimized ingress pipeline in a few
lines** — no need to hand-build responses or manage header templates:

```ts
import { createIngressHandler, createIngressServer } from "castrum";

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  cors: { allowOrigin: ["https://app.example.com"] },
  rateLimit: { limit: 1000, windowMs: 60_000 },
});

createIngressServer({
  port: 3000,
  routes: {
    "/health":    { read: ingress },                  // GET + HEAD
    "/api/users": { read: ingress, write: ingress },  // + POST/PUT/PATCH
    "/api/echo":  { echo: ingress },                  // POST echo
  },
});
```

The route factories (`readHandler`, `headHandler`, `jsonWriteHandler`,
`echoHandler`, `fallbackHandler`) are runtime-agnostic — use them with any
fetch-style server. The benchmark server (`bench/servers/ingress-server.ts`)
is built entirely from these and re-exports them. See
[docs/INGRESS.md](./docs/INGRESS.md) for the full pre-baked API reference.


---

## Project Structure

```
castrum/
├── index.ts                 # Entry point / public API
├── AGENTS.md                # AI agent instructions (commands, constraints, gotchas)
├── bench.ts                 # Benchmark runner
├── build.rs                 # NAPI build script
├── Cargo.toml               # Rust dependencies & build config
├── package.json             # Node/Bun package config
├── tsconfig.json            # TypeScript config
│
├── rust/                    # Rust source (cdylib)
│   ├── lib.rs               # Crate root, module declarations
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
│   │   ├── fast.ts          # Fast synchronous handler (packed input)
│   │   ├── handlers.ts      # PRE-BAKED handlers + createIngressServer
│   │   ├── constants.ts     # Layout constants (from Rust)
│   │   └── packed-input.ts  # Input buffer packing
│   ├── native/              # Native addon loader
│   │   └── index.ts         # Module loading + type definitions
│   ├── rust-ffi/            # Rust FFI bindings
│   │   └── index.ts         # Flat, complete FFI API
│   ├── baseline/            # JS baseline implementations
│   │   ├── index.ts         # Aggregator
│   │   └── tasks/           # Individual baseline implementations
│   ├── bench/               # Benchmark framework
│   ├── data/                # Data serialization
│   └── shared/              # Shared utilities
│
├── bench/                   # HTTP benchmark servers
│   ├── servers/             # bun-server.ts, elysia-server.ts, ingress-server.ts (+ shared.ts)
│   ├── load.ts              # HTTP load generator & scenarios
│   └── run-bench.ts         # Benchmark runner
│
├── test/                    # Tests (see CONTRIBUTING.md → Testing Requirements)
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

## Publishing

The package ships **all platform native addons in a single tarball**, so a release
needs every `napi.targets` platform artifact present (see `scripts/prepublish.mjs`).

### Automatic (recommended)

CI builds every platform addon and publishes to npm when you push a `v*` tag.
Bump `version` in `package.json` (and `Cargo.toml`), add a `CHANGELOG.md` entry,
then:

```bash
git tag v0.6.0 && git push origin v0.6.0
```

### Manual

To build and publish a release by hand, on a clean checkout of the exact tag
(with the GitHub CLI `gh` installed/authenticated and npm logged in):

```bash
bun run publish:manual            # build host addon, download CI addons, publish
bun run publish:manual:dry        # same, but verify only (no publish)
```

`publish:manual` builds the host addon locally, downloads the CI-built `addon-*`
artifacts for the current `v<version>` tag, verifies every platform is present, and
runs `npm publish --access public`. It still requires the CI `build` job to have
succeeded for that tag.

---

## License

MIT

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md).