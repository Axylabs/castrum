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

One cdylib crate (`Cargo [lib] → rust/lib.rs`) decomposed into domain folders.
`lib.rs` is a declaration hub with a module map; `util/mod.rs` re-exports the
shared-infra names so legacy `crate::util::*` call sites keep working.

```
rust/
├── lib.rs                 ── Crate root: folder declarations + module map, global allocator
├── test_support.rs        ── shared #[cfg(test)] helpers (pack_headers, decode_packed_pairs, Rng)
├── unit_tests.rs          ── cross-module test suite
│
├── util/                  ── Shared infrastructure (mod.rs re-exports crate::util::*)
│   ├── bytes.rs           ── byte primitives (word-compare, hex, %XX decode, cookie_pairs)
│   ├── packed.rs          ── zero-alloc packed iterators + byte writers (VecWriter, PackedIter)
│   ├── batch.rs           ── aggregate packed batch napi APIs (bitset/count/sum/direct)
│   ├── batch_core.rs      ── generic rayon-parallel batch helpers
│   ├── threadpool.rs      ── rayon pool init + parallelism heuristic
│   └── validation.rs      ── email / UUID / IPv4 / IPv6 validators
│
├── http/                  ── HTTP wire formats & parsing
│   ├── headers.rs         ── zero-alloc packed-header parser (HeaderRefs)
│   ├── method.rs          ── HTTP method classification
│   ├── http_parser.rs     ── HTTP request line + headers → packed request (httparse)
│   ├── query_parser.rs    ── query/form string → packed pairs
│   ├── cookie_parser.rs   ── cookie header → packed pairs
│   ├── form.rs            ── x-www-form-urlencoded parser + FormParser instance
│   ├── media_type.rs      ── Content-Type parser + MediaTypeParser / MediaTypeMatcher
│   ├── url_codec.rs       ── percent-encoding encode/decode
│   ├── url_join.rs        ── RFC 3986 url_resolve + query builder (UrlBuilder)
│   ├── etag.rs            ── etag / http_date + ConditionalRequest (304)
│   ├── accept.rs          ── Accept-Encoding negotiation (AcceptNegotiator)
│   ├── mime_lookup.rs     ── extension → MIME (phf table)
│   └── multipart.rs       ── multipart/form-data parser (+ limits)
│
├── crypto/                ── Auth & hashing (compiled-once instances)
│   ├── hmac_sha256.rs     ── HMAC-SHA256 (+ HmacSigner)
│   ├── cookie_sign.rs     ── signed cookies (CookieSigner)
│   ├── csrf.rs            ── CSRF tokens (CsrfProtector)
│   ├── jwt.rs             ── HS256 JWT sign/verify (+ JwtSigner, precomputed header)
│   ├── aead.rs            ── AES-256-GCM / chacha20-poly1305 (+ AeadCipher)
│   ├── argon2.rs          ── argon2id password hashing (+ Argon2Hasher)
│   ├── base64.rs          ── base64/base64url/hex codecs (+ Base64Codec)
│   ├── hashing.rs         ── FNV-1a / XXH3 / crc32
│   └── random_token.rs    ── random hex tokens
│
├── json/                  ── JSON & schema
│   ├── json_ops.rs        ── zero-DOM validate/sum + DOM parse
│   ├── json_ser.rs        ── zero-alloc JSON escaping + cookie/query → JSON writers
│   ├── json_patch_ops.rs  ── RFC 6902 JSON patch
│   ├── json_schema.rs     ── SchemaValidator napi class (fast + jsonschema fallback)
│   └── fast_schema/       ── zero-DOM JSON Schema fast path
│       └── mod.rs + types.rs / cursor.rs / compile.rs / validate.rs / tests.rs
│
├── payload/               ── Output & streaming
│   ├── compress.rs        ── gzip (zlib-rs) + brotli + batch
│   ├── sse.rs             ── SSE event framing + batch
│   ├── ws_frames.rs       ── RFC 6455 frame codec + batch
│   ├── websocket.rs       ── WebSocket accept-key
│   └── template.rs        ── minijinja rendering (TemplateRenderer) + batch
│
└── ingress/               ── The ingress pipeline
    ├── mod.rs             ── thin napi boundary: Ingress class + entry points
    ├── pipeline.rs        ── core 8-stage pipeline (IngressInner::handle_packed,
    │                        write_body_sections, BodySections, IngressSchema)
    ├── tests.rs           ── ingress unit tests
    ├── options.rs         ── napi option structs + Limits
    ├── time.rs            ── monotonic/wall-clock helpers
    ├── packed.rs          ── packed-input readers + builder
    ├── cors.rs            ── CORS engine (origin matching, preflight evaluation)
    ├── proxy.rs           ── HTTPS detection, URL extraction
    ├── ip_trust.rs        ── IP resolution (X-Forwarded-For, X-Real-IP)
    ├── rate_limit.rs      ── token-bucket rate limiter (per-IP keyed)
    ├── terminal.rs        ── terminal response builders (errors)
    ├── output.rs          ── SINGLE NUMERIC SOURCE for the output-buffer layout
    └── ingress_constants.rs ── NAPI projection of output.rs (no drift)
```

### TypeScript Modules

```
src/
├── ingress/               ── HTTP ingress pipeline (TS layer), decomposed by task
│   ├── index.ts           ── Public API barrel + async factory
│   ├── fast.ts            ── Thin: createIngressFast (packed input) + re-exports
│   ├── handlers.ts        ── Thin: createIngressHandler (packs frame in JS → handleRequestPacked) + response builders
│   ├── server.ts          ── createIngressServer (Bun.serve builder) + buildRouteHandlers + gracefulShutdown
│   ├── server-node.ts     ── createIngressServerNode (node:http adapter, same route handlers)
│   ├── constants.ts       ── Layout constants (from Rust NAPI)
│   ├── shared.ts          ── JS constants shared by both paths
│   ├── status.ts          ── Status normalization helpers (both paths)
│   ├── errors.ts          ── Fast-path error-code name/message mapping
│   ├── options.ts         ── IngressFast option types + validation + trustProxy warning
│   ├── types.ts           ── Public API types
│   ├── body.ts            ── Streaming request-body reader (size guard + bodyTimeoutMs)
│   ├── context.ts         ── Result snapshot + synthetic/error context builders
│   ├── packing/           ── header-packing, input-packer, gather-raw-headers
│   ├── headers/           ── cors, hsts, fast-templates, baked-templates
│   ├── decode/            ── fast-result, baked-result (two decoders, NOT unified)
│   ├── response/          ── terminal (fast), error-bodies (pre-baked)
│   └── routes/            ── read/head/json-write/echo/fallback factories
│
├── shared/
│   ├── runtime.ts         ── isBun/isNode runtime detection (single seam)
│   ├── log.ts             ── createStructuredLogger (CASTRUM_LOG_LEVEL-gated JSON lines)
│   ├── request-id.ts      ── zero-alloc request ID generator
│   ├── buffer-pool.ts     ── reusable output-buffer pool
│   ├── response.ts        ── pooledBodyResponse (zero-copy response)
│   ├── bytes.ts           ── shared TextEncoder/Decoder singletons
│   ├── packed.ts          ── packed-wire unpackers + packers
│   └── proven.ts          ── PROVEN_SURFACE registry (single source for `proven`)
│
├── native/                ── Native addon loading
│   ├── types.ts           ── NativeAddon interface + instance types
│   ├── loader.ts          ── Path resolution (multi-root + env override) + getAddon/lazyAddon
│   └── index.ts           ── Barrel
│
├── rust-ffi/              ── Rust FFI bindings
│   ├── options.ts         ── RustOptions + input-normalization helpers
│   ├── addon.ts           ── shared lazy addon proxy
│   ├── context.ts         ── per-instance state + namespace helpers
│   ├── text.ts            ── string namespace
│   ├── batch.ts           ── array-of-bytes namespace
│   ├── packed.ts          ── raw packed-wire namespace
│   ├── scalar.ts          ── scalar/feature methods
│   ├── client.ts          ── createRust factory + default `rust`
│   └── index.ts           ── Barrel
│
├── baseline/              ── JS baseline implementations
│   ├── index.ts           ── Aggregator
│   └── tasks/             ── 19 baseline tasks (cookie, hashing, hmac, http, json,
│                              json-patch, mime, query, token, url, validation,
│                              websocket, aead, compress, jwt, multipart, password,
│                              streaming, template) — full list in docs/REPO_MAP.md
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
│   └── tasks/             ── 30 benchmark tasks (complex, concurrent, cookie,
│                              hashing, hmac, http, json, json-patch, mime, query,
│                              stress, token, url, validation, websocket, aead,
│                              compress, jwt, password, streaming, template,
│                              json-schema, media-type, form, etag, accept,
│                              encoding, cookie-sign, csrf, url-join) — see docs/REPO_MAP.md
│
├── data/                  ── Benchmark-fixture data (internal)
│   └── json-rows.ts       ── JSON row serialization
```

> **Two ingress consumption paths** (see `docs/INGRESS.md`):
> 1. `src/ingress/fast.ts` (`createIngressFast`) — JS packs headers
>    (`IngressInputPacker`) → Rust `handle_request_packed`. Wire format from
>    `buildTerminalResponse`: `{"error":{code,status,message,requestId}}`,
>    `x-ratelimit-*`.
> 2. `src/ingress/handlers.ts` (`createIngressHandler` + route factories +
>    `createIngressServer`) — JS packs the request frame (`IngressInputPacker`
>    + `gatherRawHeadersPacked`) and drives the SAME native core as path 1
>    (`handle_request_packed`). Different wire format: success
>    `{"ok":true,...,"requestId":...}`, errors
>    `{"ok":false,"error":{code,message}}`, `ratelimit-*` headers. The
>    benchmark server (`bench/servers/ingress-server.ts`) uses this path and
>    re-exports the pre-baked functions.

## Node.js Compatibility

**Bun is the primary target.** Bun resolves the `bun` exports condition → raw
`index.ts` (native TS execution, zero startup cost). For Node.js consumers, the
package ships a compiled ESM bundle built by `bun run build:js`:

- `package.json` `exports` → `{ types: ./dist/index.d.ts, bun: ./index.ts,
  node: ./dist/index.js, default: ./dist/index.js }`.
- `dist/index.js` is a single-file ESM bundle (all runtime deps inlined); Node
  requires `>= 20.3` (N-API floor).
- The addon loader (`src/native/loader.ts`) resolves `castrum.<platform>-<arch>.node`
  from multiple candidate roots so the same loader works from `src/native/…`
  (Bun, source layout) and `dist/…` (Node, bundled layout), plus the
  `CASTRUM_NATIVE_LIBRARY_PATH` / `NAPI_RS_NATIVE_LIBRARY_PATH` override.
- `src/shared/runtime.ts` is the single runtime-detection seam (`isBun`/`isNode`).
- `createIngressServer` (Bun.serve) is Bun-only; `createIngressServerNode`
  (`src/ingress/server-node.ts`) serves the SAME route handlers over `node:http`,
  sharing `buildRouteHandlers` in `server.ts`. The `BakedServer.server` type is a
  runtime-agnostic `ServerHandle` so Node TS consumers don't need `@types/bun`.
- The benchmark tooling (`bench/`, `bun:test` suites) remains Bun-only by design.

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
│  Rust: SchemaValidator.validateBatchPacked()                  │
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

The output buffer is a binary format shared between Rust and TypeScript. All offsets are defined in `rust/ingress/output.rs` and exported via `rust/ingress/ingress_constants.rs` to `src/ingress/constants.ts`.

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