# Rust Core Module Documentation

This document provides detailed documentation for each Rust module in the `rust/` directory, including public API signatures, usage patterns, and performance characteristics.

---

<!-- TOC start -->
- [lib.rs — Crate Root](#librs--crate-root)
- [export.rs — Public Rust API](#exportrs--public-rust-api)
- [runtime.rs — Runtime Abstraction](#runtimers--runtime-abstraction)
- [ingress.rs — NAPI Ingress Class](#ingressrs--napi-ingress-class)
- [method.rs — HTTP Method Enum](#methodrs--http-method-enum)
- [headers.rs — Header Pack/Unpack](#headersrs--header-packunpack)
- [output.rs — Output Buffer Layout](#outputrs--output-buffer-layout)
- [cors.rs — CORS Engine](#corsrs--cors-engine)
- [rate_limit.rs — Rate Limiter](#rate_limitrs--rate-limiter)
- [ip_trust.rs — IP Trust & Proxy Resolution](#ip_trustrs--ip-trust--proxy-resolution)
- [proxy.rs — Proxy Detection](#proxyrrs--proxy-detection)
- [terminal.rs — Terminal Response Builders](#terminalrs--terminal-response-builders)
- [query_parser.rs — Query String Parser](#query_parserrs--query-string-parser)
- [cookie_parser.rs — Cookie Header Parser](#cookie_parserrs--cookie-header-parser)
- [validation.rs — Email/UUID/IP Validation](#validationrs--emailuuidip-validation)
- [hashing.rs — FNV-1a & Fast Hashing](#hashingrs--fnv-1a--fast-hashing)
- [hmac_sha256.rs — HMAC-SHA256](#hmac_sha256rs--hmac-sha256)
- [json_ops.rs — JSON Operations](#json_opsrs--json-operations)
- [json_patch_ops.rs — JSON Patch](#json_patch_opsrs--json-patch)
- [json_schema.rs — JSON Schema](#json_schemars--json-schema)
- [json_ser.rs — JSON Serialization](#json_serrs--json-serialization)
- [url_codec.rs — URL Encode/Decode](#url_codecrs--url-encodedecode)
- [mime_lookup.rs — MIME Type Lookup](#mime_lookuprs--mime-type-lookup)
- [websocket.rs — WebSocket Utilities](#websocketrs--websocket-utilities)
- [random_token.rs — Random Token Generation](#random_tokenrs--random-token-generation)
- [batch.rs — Batch Processing](#batchrs--batch-processing)
- [async_tasks.rs — Async Task Management](#async_tasksrs--async-task-management)
- [http_parser.rs — HTTP Request Parser](#http_parserrs--http-request-parser)
- [util.rs — Core Utilities](#utilrs--core-utilities)
- [ingress_constants.rs — NAPI Constants Export](#ingress_constantsrs--napi-constants-export)
<!-- TOC end -->

---

## lib.rs — Crate Root

**File**: `rust/lib.rs`

The crate root declares all modules and sets the global allocator to mimalloc.

```rust
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;
```

**Key responsibilities**:
- Declare all `pub mod` declarations
- Set the global allocator (mimalloc)
- No business logic

---

## export.rs — Public Rust API

**File**: `rust/export.rs`

Re-exports all public Rust API items for downstream consumers who use the crate as a Rust dependency (not via NAPI).

**Re-exports from**:
- `hashing`: `fnv1a64_bytes`, `fnv1a64_continue`, `fast_hash_bytes`, `fast_hash_seeded`, `fast_hash_cache_key`, `LazyHash`, constants
- `json_ser`: `json_escaped_len`, `write_json_escaped`, `cookie_json_into_slice`, `packed_pairs_to_json_into_slice`, `write_full_body_json`
- `query_parser`: `query_parse_packed_into_slice`, `query_parse_packed_vec`
- `cookie_parser`: `cookie_parse_packed_into_slice`, `cookie_parse_packed_vec`
- `headers`: `HeaderRefs`
- `method`: `MethodKind`
- `validation`: `validate_email_bytes`, `validate_uuid_bytes`, `validate_ipv4_bytes`, `validate_ipv6_bytes`
- `util`: `PackedIter`, `VecWriter`, `read_u32_le`, `trim_ascii_whitespace`, etc.
- `runtime`: `Runtime`, `NativeRuntime`, `JsonEscapeMode`, `KvPair`

---

## runtime.rs — Runtime Abstraction

**File**: `rust/runtime.rs`

Provides a generic runtime abstraction that allows the same Rust code to work under NAPI (Bun/Node) or native (CLI/test) contexts.

```rust
pub trait Runtime {
    type Buffer: AsRef<[u8]> + AsMut<[u8]>;
    fn alloc_buffer(len: usize) -> Self::Buffer;
    fn now_ms() -> u64;
}
```

**Implementations**:
- `NativeRuntime`: Uses `Vec<u8>` for buffers, `SystemTime` for timestamps

**Data structures**:
- `PackedResult<'a>`: Result of parsing a packed batch
- `KvPair<'a>`: A generic key-value pair with `Cow<'a, [u8]>` fields
- `JsonEscapeMode`: Enum for UTF-8 vs Binary escape modes

---

## ingress.rs — NAPI Ingress Class

**File**: `rust/ingress.rs`

The main NAPI class that provides the HTTP request processing pipeline. This is the bridge between TypeScript and Rust for the ingress system.

**NAPI exports**:
- `Ingress` class with `new(options)` constructor and `handleRequestPacked(input, body, output)` method
- `IngressOptions`, `RateLimitOptions`, `TrustedProxyOptions`, `IngressLimitsOptions` structs

**Pipeline stages in `handle_packed()`**:
1. Parse packed input (method, URL, IP, request ID, headers)
2. IP trust resolution
3. HTTPS detection
4. CORS evaluation
5. Rate limiting check
6. Body size guard
7. JSON body validation & schema check
8. Cookie parsing → output buffer
9. Query parsing → output buffer
10. Optional metadata JSON
11. Write output header

**Key design**: Uses packed binary format for input/output to minimize FFI overhead.

---

## method.rs — HTTP Method Enum

**File**: `rust/method.rs`

```rust
pub enum MethodKind {
    Get,     // 0
    Head,    // 1
    Post,    // 2
    Put,     // 3
    Patch,   // 4
    Delete,  // 5
    Options, // 6
    Other,   // 7
}
```

**Methods**:
- `from_u8(v: u8) -> Self`: Convert from byte value
- `to_u8(&self) -> u8`: Convert to byte value
- `may_have_body(&self) -> bool`: Returns `true` for POST, PUT, PATCH

---

## headers.rs — Header Pack/Unpack

**File**: `rust/headers.rs`

Parses the packed binary header format used in the ingress pipeline.

```rust
pub struct HeaderRefs<'a> {
    cookie: Option<&'a [u8]>,
    origin: Option<&'a [u8]>,
    access_control_request_method: Option<&'a [u8]>,
    access_control_request_headers: Option<&'a [u8]>,
    x_forwarded_for: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
    x_forwarded_proto: Option<&'a [u8]>,
}
```

**Methods**:
- `parse(input: &[u8], is_options: bool, max_headers: usize) -> Result<Self>`: Parse packed headers
- Accessors: `cookie()`, `origin()`, `xff()`, `x_real_ip()`, `x_forwarded_proto()`
- `has_cookie()`, `has_origin()`: Check if header is present

**Binary format**:
```
[u16: count] [u16: name_len] [name bytes] [u32: value_len] [value bytes] ...
```

---

## output.rs — Output Buffer Layout

**File**: `rust/output.rs`

Defines the binary output buffer layout and provides writers for it.

**Constants** (byte offsets):
- `OUT_VERDICT`, `OUT_ERROR_CODE`, `OUT_STATUS`, `OUT_FLAGS`
- `OUT_RATE_LIMIT`, `OUT_RATE_REMAINING`, `OUT_RATE_RESET`, `OUT_RETRY_AFTER`
- `OUT_COOKIES_JSON_LEN`, `OUT_QUERY_JSON_LEN`, `OUT_HEADER_VARIANT`, `OUT_BODY_JSON_LEN`
- `OUT_DATA_START` (64 bytes)

**Flags**: `FLAG_HAS_COOKIES`, `FLAG_HAS_QUERY`, `FLAG_BODY_VALID_JSON`, etc.

**Error codes**: `ERR_CODE_NONE` through `ERR_CODE_INTERNAL`

**Functions**:
- `write_output_header(...)`: Write the output header fields
- `compute_header_variant(...)`: Compute the header variant index

---

## cors.rs — CORS Engine

**File**: `rust/cors.rs`

Implements CORS (Cross-Origin Resource Sharing) evaluation.

```rust
pub struct CorsEngine { /* ... */ }

pub struct CorsEvaluation {
    pub allowed: bool,
    pub preflight: bool,
}
```

**Methods**:
- `from_options(opts: Option<CorsOptions>) -> Result<Self>`: Create engine from options
- `evaluate(&self, method: MethodKind, headers: &HeaderRefs) -> CorsEvaluation`: Evaluate a request

**Logic**:
- Determines if request is a CORS preflight (OPTIONS + origin + acrm)
- Validates origin against allowed list
- Wildcard (`*`) matching with credential check

---

## rate_limit.rs — Rate Limiter

**File**: `rust/rate_limit.rs`

Token-bucket rate limiter keyed by client IP.

```rust
pub struct KeyedRateLimiter { /* ... */ }

pub struct RateLimitOutcome {
    pub allowed: bool,
    pub remaining: u32,
    pub reset_ms: u64,
}
```

**Methods**:
- `new(limit: u32, window_ms: u32, max_entries: Option<usize>) -> Self`
- `check_key(&self, key: u64, now: u64) -> RateLimitOutcome`
- `seed() -> u64`: Get the random seed
- `limit() -> u32`: Get the configured limit

**Algorithm**: Token bucket with configurable window, LRU eviction for tracked clients, random seed for hash-based IP routing.

---

## ip_trust.rs — IP Trust & Proxy Resolution

**File**: `rust/ip_trust.rs`

Resolves the real client IP from proxy headers.

```rust
pub enum ProxyTrustMode { None, All, List(Vec<IpNet>) }

pub fn resolve_client_ip(
    mode: &ProxyTrustMode,
    ip_bytes: &[u8],
    xff: Option<&[u8]>,
    x_real_ip: Option<&[u8]>,
) -> (ResolvedIp, bool);
```

Uses `ipnet` crate for CIDR network matching when in `List` mode.

---

## proxy.rs — Proxy Detection

**File**: `rust/proxy.rs`

HTTPS detection and URL path/query extraction utilities.

```rust
pub fn detect_https(
    https_fixed: Option<bool>,
    trust: &ProxyTrustMode,
    url_bytes: &[u8],
    headers: &HeaderRefs,
    peer_trusted: bool,
) -> bool;

pub fn extract_query(url_bytes: &[u8]) -> &[u8];
pub fn extract_path(url_bytes: &[u8]) -> &[u8];
```

Supports: fixed HTTPS config, `X-Forwarded-Proto` header, URL scheme detection.

---

## terminal.rs — Terminal Response Builders

**File**: `rust/terminal.rs`

Writes error responses to the output buffer.

- `terminal_simple(out, verdict, error_code, status)` — Generic error
- `terminal_body_too_large(...)` — 413 Payload Too Large
- `terminal_invalid_json(...)` — 400 Invalid JSON
- `terminal_preflight_ok(...)` — 204 CORS preflight OK
- `terminal_preflight_forbidden(...)` — 403 CORS preflight rejected
- `terminal_rate_limited(...)` — 429 Too Many Requests
- `terminal_schema_validation(...)` — 422 Schema validation failed

---

## query_parser.rs — Query String Parser

**File**: `rust/query_parser.rs`

Parses URL query strings into key-value pairs.

```rust
pub fn query_parse_packed_into_slice(input: &[u8], output: &mut [u8]) -> Result<usize>;
pub fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>>;
```

**Format**: URL-decoded key-value pairs in packed binary format.

---

## cookie_parser.rs — Cookie Header Parser

**File**: `rust/cookie_parser.rs`

Parses HTTP Cookie headers into key-value pairs.

```rust
pub fn cookie_parse_packed_into_slice(input: &[u8], output: &mut [u8]) -> Result<usize>;
pub fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>>;
```

Handles standard cookie format with special character handling.

---

## validation.rs — Email/UUID/IP Validation

**File**: `rust/validation.rs`

High-performance validation functions.

```rust
pub fn validate_email_bytes(input: &[u8]) -> bool;
pub fn validate_uuid_bytes(input: &[u8]) -> bool;
pub fn validate_ipv4_bytes(input: &[u8]) -> bool;
pub fn validate_ipv6_bytes(input: &[u8]) -> bool;
```

- **Email**: Uses `email_address` crate (or `fast_chemail` with the `fast-email` feature)
- **UUID**: Validates standard UUID format (hex with hyphens)
- **IPv4**: Validates dotted-decimal format
- **IPv6**: Validates full IPv6 address format (via `std::net::Ipv6Addr::parse`)

---

## hashing.rs — FNV-1a & Fast Hashing

**File**: `rust/hashing.rs`

Non-cryptographic hashing functions.

```rust
pub fn fnv1a64_bytes(input: &[u8]) -> u64;
pub fn fnv1a64_continue(hash: u64, input: &[u8]) -> u64;
pub fn fast_hash_bytes(input: &[u8]) -> u64;
pub fn fast_hash_seeded(input: &[u8], seed: u64) -> u64;
pub fn fast_hash_cache_key(input: &[u8]) -> u64;
```

- **FNV-1a**: Simple, fast hash suitable for hash tables
- **Fast hash**: Uses xxhash for higher throughput
- **LazyHash**: Wrapper type for lazy hash computation

---

## hmac_sha256.rs — HMAC-SHA256

**File**: `rust/hmac_sha256.rs`

HMAC-SHA256 signing and verification using `aws-lc-rs`.

```rust
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>>;
pub fn hmac_sha256_verify(key: &[u8], data: &[u8], sig: &[u8]) -> Result<bool>;
pub struct HmacSigner { /* ... */ }
```

- **HmacSigner**: Stateful signer with cached key for repeated use

---

## json_ops.rs — JSON Operations

**File**: `rust/json_ops.rs`

JSON validation and data extraction.

```rust
pub fn json_valid_bytes(input: &[u8]) -> bool;
pub fn json_sum_ids_bytes(input: &[u8]) -> i64;
```

Uses `sonic_rs` for fast JSON parsing.

---

## json_patch_ops.rs — JSON Patch

**File**: `rust/json_patch_ops.rs`

Applies JSON Patch (RFC 6902) operations.

```rust
pub fn json_patch(doc: &[u8], patch: &[u8]) -> Result<Vec<u8>>;
```

Uses the `json-patch` crate for RFC 6902 compliance.

---

## json_schema.rs — JSON Schema

**File**: `rust/json_schema.rs`

JSON Schema validation.

```rust
pub struct SchemaValidator { /* ... */ }

impl SchemaValidator {
    pub fn new(schema: &[u8]) -> Result<Self>;
    pub fn validate(&self, instance: &[u8]) -> bool;
}
```

Uses the `jsonschema` crate (v0.48) for JSON Schema draft-07/2019-09/2020-12 support.

---

## json_ser.rs — JSON Serialization

**File**: `rust/json_ser.rs`

Utilities for writing JSON output to slices.

```rust
pub fn json_escaped_len(input: &[u8], mode: JsonEscapeMode) -> usize;
pub fn write_json_escaped(output: &mut [u8], input: &[u8], mode: JsonEscapeMode) -> usize;
pub fn cookie_json_into_slice(input: &[u8], output: &mut [u8], max_pairs: usize) -> Result<usize>;
pub fn packed_pairs_to_json_into_slice(pairs: &[u8], output: &mut [u8], max_pairs: usize) -> Result<usize>;
pub fn write_full_body_json(out: &mut [u8], pos: usize, rid: &[u8], path: &[u8], ...) -> usize;
```

Handles UTF-8 and binary escape modes.

---

## url_codec.rs — URL Encode/Decode

**File**: `rust/url_codec.rs`

```rust
pub fn url_encode(input: &[u8]) -> String;
pub fn url_decode(input: &[u8]) -> Result<String>;
```

Percent-encoding for URL components.

---

## mime_lookup.rs — MIME Type Lookup

**File**: `rust/mime_lookup.rs`

```rust
pub fn mime_from_extension(ext: &[u8]) -> Option<&'static str>;
```

Returns MIME type string for a given file extension using `mime_guess`.

---

## websocket.rs — WebSocket Utilities

**File**: `rust/websocket.rs`

```rust
pub fn ws_accept_key(key: &[u8]) -> String;
```

Generates the `Sec-WebSocket-Accept` value from the client's `Sec-WebSocket-Key` header.

---

## random_token.rs — Random Token Generation

**File**: `rust/random_token.rs`

```rust
pub fn random_token(byte_len: usize) -> Result<Vec<u8>>;
```

Generates cryptographically secure random bytes using `getrandom`.

---

## batch.rs — Batch Processing

**File**: `rust/batch.rs`

Processes multiple inputs in a single FFI call using packed binary format.

Functions: `jsonValidBatchPacked`, `validateEmailBatchPacked`, `validateUuidBatchPacked`, `validateIpv4BatchPacked`, `validateIpv6BatchPacked`, `jsonSumBatchPacked`, `queryParseBatchPacked`, `cookieParseBatchPacked`, `httpParseRequestBatchPacked`.

---

## async_tasks.rs — Async Task Management

**File**: `rust/async_tasks.rs`

Async variant of batch operations using tokio's `spawn_blocking`.

Functions: `jsonValidBatchPackedAsync`, `validateEmailBatchPackedAsync`, etc.

---

## http_parser.rs — HTTP Request Parser

**File**: `rust/http_parser.rs`

Parses raw HTTP request bytes.

```rust
pub fn http_parse_request_packed(input: &[u8]) -> Result<Vec<u8>>;
```

Uses `httparse` crate for zero-copy HTTP header parsing.

---

## util.rs — Core Utilities

**File**: `rust/util.rs`

Shared utility functions used across the crate.

- `PackedIter`: Iterator over packed binary data
- `VecWriter`: Write adapter for `Vec<u8>`
- `read_u32_le`, `write_u32_le`: Little-endian integer helpers
- `trim_ascii_whitespace`: Whitespace trimming
- `ensure_capacity`: Safe buffer growth
- `should_parallelize`: Heuristic for Rayon parallelism
- `cow_decode_url`: URL decoding with `Cow` optimization
- `validation_bitset_chunked`: Chunked validation for batch operations
- `count_batch`, `sum_batch_i64`: Batch aggregation

---

## ingress_constants.rs — NAPI Constants Export

**File**: `rust/ingress_constants.rs`

Exports output buffer layout constants and flag definitions to TypeScript via NAPI. These are consumed by `src/ingress/constants.ts`.

**Exports**: All `OUT_*`, `FLAG_*`, `HV_*`, `ERR_*` constants as NAPI statics.