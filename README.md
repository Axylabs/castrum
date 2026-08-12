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
│    ├── src/native/       bun:ffi (primary on Bun) + NAPI loader  │
│    ├── src/ingress/      High-performance HTTP ingress pipeline  │
│    ├── src/integration/  Framework-agnostic pipeline/WS/SSE      │
│    ├── src/loader/       Higher-order loader (HFC)               │
│    ├── src/baseline/     JS baseline (benchmark reference)       │
│    └── src/shared/       Shared constants and helpers            │
│                                                                  │
├──────── Native Bridge: bun:ffi (Bun, primary) + NAPI (fallback) ────────┤
│                                                                  │
│                     Rust (cdylib) Layer                          │
│                                                                  │
│  rust/lib.rs                                                     │
│    ├── util/       bytes, packed, batch, batch_core, threadpool, │
│    │               validation                                   │
│    ├── http/       headers, method, http_parser, cookie/query    │
│    │               parsers, form, media_type, url_codec/join,    │
│    │               etag, accept, mime_lookup, multipart          │
│    ├── crypto/     hmac_sha256, cookie_sign, csrf, jwt, aead,    │
│    │               argon2, base64, hashing, random_token         │
│    ├── json/       json_ops, json_ser, json_patch_ops,           │
│    │               json_schema, fast_schema/ (zero-DOM)          │
│    ├── payload/    compress, sse, ws_frames, websocket, template │
│    ├── ingress/    mod.rs (napi boundary), pipeline.rs (core),   │
│    │               options/time/packed, cors, proxy, ip_trust,   │
│    │               rate_limit, terminal, output, constants       │
│    └── ffi.rs      extern "C" exports (castrum_*) for bun:ffi     │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
bun install

# Build Rust native addon (release)
bun run build

# Build the compiled ESM entry for Node.js consumers (dist/)
bun run build:js

# Run benchmarks
bun bench.ts

# Run tests
bun test

# Run the Node.js smoke suite (requires `bun run build:js` first)
bun run test:node
```

## Node.js Support

**Bun is the primary target** (raw TypeScript, zero startup cost). The package is
*also* consumable from Node.js via a compiled ESM entry:

- Bun resolves the `bun` exports condition → `index.ts` (native TS execution).
- Node.js resolves the `node`/`default` condition → `dist/index.js` (compiled ESM,
  requires Node.js >= 20.3). The bundled `dist/index.d.ts` covers the full API.
- **One cdylib, two transports.** The addon is built with napi-rs (a standard N-API
  binary) but ALSO exports `extern "C"` symbols (`rust/ffi.rs`) that Bun loads directly:
  - **Bun** — `bun:ffi` is the PRIMARY transport. `src/native/ffi.ts` `dlopen`s the same
    `.node` file and JIT-calls the C ABI exports (~10-20ns crossing), covering the whole
    stateless scalar API + the ingress per-request pipeline + the ingress layout
    constants. NAPI is the fallback (Node, `CASTRUM_FFI_MODE=napi`, or a failed bind-time
    self-test).
  - **Node.js** — the N-API addon (`src/native/loader.ts`) is the fallback transport.
- `rust.transport()` returns `"ffi"` / `"napi"` (the resolved transport) and
  `rust.ffiActive()` reports whether the bun:ffi transport is live; `CASTRUM_FFI_MODE`
  overrides the selection (see docs/ENVIRONMENT.md).

```ts
// Node.js (ESM)
import { rust, createIngressHandler, readHandler, createIngressServerNode } from "castrum";

rust.crc32(new Uint8Array([104, 105])); // native FFI works identically (napi fallback)

// Serve the SAME pre-baked ingress handlers over node:http
const srv = createIngressServerNode({ port: 3000, routes: { "/health": { read: handler } } });
await srv.ready; // resolves once the server is listening
```

`createIngressServer` (Bun.serve) is Bun-only; Node users use `createIngressServerNode`
with the same route handlers.

## Build

```bash
# Production build (native addon)
bun run build

# Debug build
bun run build:debug

# Compiled JS entry for Node (bundle + bundled types -> dist/)
bun run build:js
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
bun run bench:http:smoke    # smoke test (CI wire-format guard)
bun run bench:http:stress   # stress test
bun run bench:http:heavy    # heavy JSON
bun run bench:http:crud     # CRUD operations
bun run bench:http:spike    # spike test
bun run bench:http:soak     # soak (endurance) test
bun run bench:http:storm    # storm (burst) test
bun run bench:http:boundary # boundary conditions
bun run bench:http:all-heavy # heavy-JSON scenarios (substring filter "1": 01-smoke, 10-12, 13-20)
```

### Bun built-ins comparison ("don't reinvent the wheel")

`bun run check` also races castrum ops against Bun's native built-ins
(`Bun.hash`, `Bun.password`, `Bun.CryptoHasher`, `Bun.gzipSync`,
`Bun.randomUUIDv7`) as a **diagnostic** set (`diag:` task names — never
audited by `check:proven`). Findings on Bun 1.4 / release addon:

- **Bun wins → `@flux/native` should prefer Bun**: non-crypto hashing
  (`Bun.hash.crc32` ~3x, `xxHash3` ~4x, wyhash ~1-2x), gzip
  (`Bun.gzipSync`/`gunzipSync` ~1.3-2x), `Bun.randomUUIDv7` (~2x), HMAC
  (`Bun.CryptoHasher` ~1.2x).
- **Rust wins → keep**: argon2id password hashing/verify (~1.8-2x vs
  `Bun.password`), bcrypt verify (~1.5x), and everything with no sync Bun
  equivalent (brotli, PBKDF2, zero-DOM JSON/parsers).

Full table + per-op decisions: [`docs/bun-builtins-decision-matrix.md`](docs/bun-builtins-decision-matrix.md).

### New primitives

| `rust.*` | Description | Benchmark vs |
|---|---|---|
| `xxh3` | XXH3-64 (non-crypto hash) | `Bun.hash.xxHash3` (~4x Bun — prefer Bun under Bun) |
| `passwordHashBcrypt` / `passwordVerifyBcrypt` | bcrypt `$2b$` PHC | `Bun.password` bcrypt (hash parity, verify rust ~1.5x) |
| `pbkdf2Sha256` | PBKDF2-HMAC-SHA256 | `node:crypto.pbkdf2Sync` (parity; only sync option in Bun) |
| `uuidv7()` (TS) | UUIDv7 — delegates to `Bun.randomUUIDv7`, `crypto.randomUUID` on Node | `Bun.randomUUIDv7` |

## API Reference

### Core Exports

```ts
import { rust, proven } from "castrum";

// `rust`    — All Rust FFI native implementations (flat, complete API)
// `proven`  — The same full `rust.*` surface, with performance annotations
```

## Performance-annotated surface

Not every `rust.*` function beats its JavaScript baseline — e.g. `rust.jsonParse`
loses ~5x to Bun's `JSON.parse` (DOM + napi marshaling), and the native schema
validator is slower than `ajv` for small documents. `proven` exposes the **full
`rust.*` surface** (it is literally the same object as `rust`); performance is
communicated by `@performance` / `@deprecated` JSDoc annotations rather than by
filtering, so a function's classification is visible in your editor and in
`PROVEN_SURFACE`:

```ts
import { proven, PROVEN_SURFACE } from "castrum";

proven.jsonValid(bytes);   // ✓ proven — Rust wins vs the JS baseline
proven.fnv1a64(bytes);     // ✓ proven — Rust wins ~9-16x
proven.jsonParse(bytes);   // ✗ @deprecated — loses ~5x to JSON.parse
```

- `proven` is the full `rust.*` client (`export const proven = rust`). Each
  exported function's JSDoc carries its measured performance vs the JS baseline
  (`@performance`) and is marked `@deprecated` when it loses — so the editor
  steers you to the JS/Bun baseline for those. The single source of truth for the
  classifications is `PROVEN_SURFACE` (`src/shared/proven.ts`). Statuses:
  `proven` / `parity` / `not-competitive` / `unmeasured`.
- The full surface is unchanged — `rust.jsonParse`, `rust.createSchemaValidator`,
  etc. remain available for completeness; they just aren't advertised as
  performance wins.
- Classifications are based on the **release build on the shipped baseline CPU**
  (published artifacts are baseline — not the local SIMD `build:perf`).

Keep the registry honest with the audit:

```bash
bun run check                # writes bench/results/cpu/latest.json (release build)
bun run check:proven         # report-only: proves vs loses per function
bun run check:proven:fail    # CI gate: exits 1 if a "proven" function regresses
```

The audit compares each registry entry against the latest benchmark report and
fails (with `--fail`) when a `proven` function loses to its baseline by more
than the tolerance — catching real performance regressions (and wrong
classifications) before they ship.

### Native-vs-JS selection surface

For framework consumers that want to bind each operation to a fixed
implementation at load time (instead of calling `rust.*` directly), castrum
exposes an auto-selected decision surface:

```ts
import { opImpl, isNativeOp, opDecision } from "castrum";

opImpl("gzipCompress");   // "native" | "js" | null
isNativeOp("crc32");      // boolean
opDecision("fnv1a64");    // { impl, note? } | null
```

- The single source of truth is `rust/selection.rs`, which embeds the
  benchmark-generated `src/selection.json` (produced by
  `scripts/select-native.ts --write`, audited by `--check` in CI). Under Bun,
  ops where the Bun built-in beats the Rust addon (gzip, crc32, xxh3, HMAC,
  random tokens — see `docs/bun-builtins-decision-matrix.md`) are selected as
  `"js"` (a JS path that delegates to the Bun built-in); under Node the base
  benchmark decision stands.
- Consumers read `opImpl(op)` **once at startup** and bind each op to a fixed
  implementation — they do not swap native↔js per call.

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
| `jsonParse(input)` | `unknown` — JSON → JS value (native sonic-rs DOM; throws on invalid) |
| `jsonSumIds(input)` | `bigint` — sum of numeric `id` fields |
| `jsonPatch(doc, patch)` | `Uint8Array` — RFC 6902 result |
| `createSchemaValidator(schema)` | `SchemaValidator` — compile a JSON Schema (draft-07); `.validate(doc): boolean`, `.validateDetailed(doc): SchemaError[]`, `.validateFirstError(doc): SchemaError | null`, `.validateBatchPackedCount(packed): number`, … |
| `mimeFromExtension(ext)` | `Uint8Array` — MIME type |
| `randomToken(byteLen)` | `Uint8Array` — CSPRNG token |
| `urlEncode(input)` / `urlDecode(input)` | `Uint8Array` — percent encode/decode |
| `urlDecodeBytes(input)` | `Uint8Array` — strict %-decode (no UTF-8 check) |
| `validateEmail/Uuid/Ipv4/Ipv6(input)` | `boolean` |
| `wsAcceptKey(key)` | `Uint8Array` — WebSocket accept key |

#### Framework actions (HTTP semantics + security)

| Function | Returns |
|----------|---------|
| `formParsePacked(body)` | `Uint8Array` — packed x-www-form-urlencoded pairs |
| `createFormParser(capacity?)` | `FormParser` — reusable-buffer form parser (`.parse`, `.parseInto`) |
| `parseMediaType(header)` | `{ mediaType, charset, boundary, params }` — Content-Type parse |
| `createMediaTypeParser()` | `MediaTypeParser` — `.parse`, `.matches(actual, expected)` (wildcards) |
| `etag(data, weak?)` | `Uint8Array` — strong/weak ETag (crc32-based) |
| `httpDate(secs?)` / `parseHttpDate(input)` | `Uint8Array` / `bigint | null` — IMF-fixdate format/parse |
| `createConditionalRequest(etag, lastModifiedSecs?)` | `ConditionalRequest` — `.isNotModified(ifNoneMatch, ifModifiedSince)` → 304 |
| `parseAcceptEncoding(header)` | `{ encoding, q, order }[]` |
| `createAcceptNegotiator(supported[])` | `AcceptNegotiator` — `.negotiate(header)` → best encoding |
| `base64Encode/Decode(input, urlSafe?, padding?)`, `base64UrlEncode/Decode(input)` | `Uint8Array` |
| `createBase64Codec(urlSafe?, padding?)` | `Base64Codec` — `.encode`, `.decode` |
| `hexEncode(input)` / `hexDecode(input)` | `Uint8Array` — lowercase hex |
| `signCookie(value, secret)` / `verifyCookie(signed, secret)` | `Uint8Array` / `Uint8Array | null` — signed cookies |
| `createCookieSigner(secret)` | `CookieSigner` — `.sign`, `.verify` (HMAC key compiled once) |
| `csrfToken(secret)` / `csrfVerify(token, secret)` | `Uint8Array` / `boolean` |
| `createCsrfProtector(secret)` | `CsrfProtector` — `.create`, `.verify` |
| `urlResolve(base, reference)` | `Uint8Array` — RFC 3986 resolution |
| `urlEncodeQuery(params)` | `Uint8Array` — percent-encoded query (sorted keys) |
| `createUrlBuilder(base)` | `UrlBuilder` — `.resolve(reference)` (base parsed once) |
| `createJwtSigner(secret, ttlSeconds?)` | `JwtSigner` — `.sign(claims, now)`, `.verify(token, now)` (HS256 key + ttl compiled once) |
| `createAeadCipher(key, algorithm?)` | `AeadCipher` — `.encrypt(nonce, pt)`, `.decrypt(nonce, ct)` (key compiled once) |
| `createArgon2Hasher(options?)` | `Argon2Hasher` — `.hash(password, salt)`, `.verify(password, phc)` (params compiled once) |
| `createMediaTypeMatcher(expected)` | `MediaTypeMatcher` — `.matches(actual)` (expected precompiled once) |

Low-level / packed variants: `rust.httpParseRequestPacked`, `rust.queryParsePacked`,
`rust.cookieParsePacked`, `rust.formParsePacked`.

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
rust.batch.formParse(docs);             // Uint8Array[] (packed pairs per doc)
rust.batch.signCookie(docs, secret);    // Uint8Array[] (signed)
rust.batch.verifyCookie(docs, secret);  // Uint8Array bitset (valid?)
rust.batch.csrfVerify(tokens, secret);  // Uint8Array bitset (valid?)
rust.batch.schemaValidate(validator, docs); // bitset

// Hashing / url / mime / ws / base64url
rust.batch.fnv1a64(docs);               // BigUint64Array (unsigned hashes)
rust.batch.etag(docs);                  // Uint8Array[]
rust.batch.urlEncode(docs);             // Uint8Array[]
rust.batch.urlDecode(docs);             // Uint8Array[]
rust.batch.base64UrlEncode(docs);       // Uint8Array[]
rust.batch.wsAcceptKey(keys);           // Uint8Array[]
rust.batch.mimeFromExtension(exts);     // Uint8Array[]

// Backend-framework batches (zipped lists / shared args)
rust.batch.passwordVerify(pwds, phcs);  // Uint8Array bitset (zipped)
rust.batch.urlResolve(bases, refs);     // Uint8Array[] (zipped)
rust.batch.jwtSign(claimDocs, secret);  // Uint8Array[] (sign N JSON claim docs)
rust.batch.jwtVerify(tokens, secret, now); // Uint8Array bitset
rust.batch.sseEncode(items, "event");   // Uint8Array[]
rust.batch.wsFrameEncode(items, 1, false, true); // Uint8Array[]
rust.batch.wsFrameDecode(frames);       // Uint8Array[] (payloads)
rust.batch.multipartParse(bodies, boundary); // MultipartPart[][]
```

Raw packed + metadata variants (advanced): `rust.packed.*` mirrors the native
functions 1:1 (`jsonValidBatchPacked`, `jsonValidBatchCountPacked`,
`queryParseBatchTotalLenPacked`, …).

#### Higher-order data loader (`castrum.loader`)

`loader` is a callable higher-order function over the whole batch surface. It
pre-binds an op so repeated calls skip registry dispatch, and it routes small
vs. large workloads automatically: a single item → one scalar native call, a
bulk → ONE packed batch call, and `load()` coalesces N same-tick calls into one
packed call (DataLoader-style) with a bounded LRU cache.

```ts
import { loader } from "castrum";

const isEmail = loader("validateEmail");
isEmail(emailBytes);                    // scalar → boolean
isEmail([a, b, c]);                     // bulk → Uint8Array bitset (one packed call)
await isEmail.load(a);                  // coalesced + cached (auto batch/strategy)

// Covered op families (44 ops):
//   hash     crc32, fnv1a64
//   json     jsonValid, jsonSumIds, jsonPatch*, schemaValidate
//   validate email, uuid, ipv4, ipv6
//   parse    query, cookie, form, httpParseRequest, urlResolve*
//   encode   hex, base64, base64Url, urlEncode, urlDecode, urlDecodeBytes, etag
//   compress gzip, brotli
//   crypto   hmacSha256, hmacSha256Verify*, signCookie, verifyCookie, csrfVerify,
//            passwordHash, passwordVerify*, aeadEncrypt, aeadDecrypt, jwtSign, jwtVerify
//   web      wsAcceptKey, wsFrameEncode, sseEncode, mimeFromExtension
//   (* = paired: per-item companion array, e.g. loader.run("jsonPatch", docs, patches))

// Paired ops take a companion array:
loader.run("jsonPatch", docs, patches);       // bulk
loader.run("jsonPatch", doc, patch);          // single

// verifyCookie / jwtVerify are boolean-validity ops (valid/invalid);
// use rust.verifyCookie / rust.jwtVerify for the decoded value.

// Bind a schema validator for repeated single/bulk validation + count:
const schema = loader.schema(rust.createSchemaValidator(schemaBytes));
schema(doc);              // boolean
schema(docs);             // Uint8Array bitset
schema.count(docs);       // number of valid docs

// Fine-grained control: createLoader({ adaptive, batchMin, maxCacheKeys, ... })
```

The loader is also surfaced through the integration layer for bulk workloads
(`src/integration/batch.ts`, exported): `validateMany` / `validateCount`
(batch JSON-schema validation) and generic `runMany` / `runOne`. See
`examples/loader-demo.ts` (single / bulk / schema / hash routes against a real
Bun.serve server) for end-to-end usage.

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
| `import { parseQueryString, parseCookieHeader, parseFormBody } from "castrum"` | High-level parsers (no hand-packing) |
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
  // warmOnCreate: true   // prime the hot path once at construction (see below)
});
```

**Cold-start priming**: pass `warmOnCreate: true` to `createIngressFast` /
`createIngressHandler` to run one probe GET at construction so the `run()`
closure + packed pipeline + FFI ingress call are JIT-warmed before the first
real request (cuts cold-invocation tail latency in serverless-style
deployments). For instant execution in fresh processes, compile the server to a
standalone Bun binary (`bun build --compile ./server.ts --outfile server`) or
use Bun's compile cache — see [docs/GETTING_STARTED.md §8](./docs/GETTING_STARTED.md).

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
├── rust/                    # Rust source (one cdylib, domain folders)
│   ├── lib.rs               # Crate root: folder declarations + module map
│   ├── util/                # Shared infra: bytes, packed, batch(+core), threadpool, validation
│   ├── http/                # Wire formats: headers, method, http/query/cookie parsers,
│   │                        #   form, media_type, url_codec/join, etag, accept, mime_lookup, multipart
│   ├── crypto/              # Auth & hashing: hmac, cookie_sign, csrf, jwt, aead, argon2,
│   │                        #   base64, hashing, random_token
│   ├── json/                # JSON & schema: json_ops, json_ser, json_patch_ops, json_schema,
│   │                        #   fast_schema/ (zero-DOM draft-07 engine: types/cursor/compile/
│   │                        #   validate/errors — incl. pattern, enum/const, multipleOf,
│   │                        #   combinators, $ref, uniqueItems, detailed errors)
│   ├── payload/             # Output & streaming: compress, sse, ws_frames, websocket, template
│   ├── ingress/             # The ingress pipeline: mod.rs (napi boundary), pipeline.rs (core),
│   │                        #   tests.rs, options/time/packed, cors, proxy, ip_trust,
│   │                        #   rate_limit, terminal, output, ingress_constants
│   ├── test_support.rs      # Shared test helpers
│   └── unit_tests.rs        # Cross-module test suite
│
├── src/                     # TypeScript source
│   ├── ingress/             # Ingress pipeline (TS layer), decomposed by task
│   │   ├── index.ts         # Public API barrel + async factory
│   │   ├── fast.ts          # Thin: createIngressFast (packed input)
│   │   ├── handlers.ts      # Thin: createIngressHandler (JS-packs frame → handleRequestPacked, pre-baked)
│   │   ├── server.ts        # createIngressServer (Bun.serve builder)
│   │   ├── server-node.ts   # createIngressServerNode (node:http adapter)
│   │   ├── constants.ts     # Layout constants (from Rust)
│   │   ├── shared.ts        # JS constants shared by both paths
│   │   ├── status.ts        # Status normalization helpers
│   │   ├── errors.ts        # Fast-path error-code mapping
│   │   ├── options.ts       # IngressFast option types + validation
│   │   ├── types.ts         # Public API types
│   │   ├── body.ts          # Streaming request-body reader
│   │   ├── context.ts       # Result snapshot + synthetic contexts
│   │   ├── packing/         # header-packing, input-packer, gather-raw-headers
│   │   ├── headers/         # cors, hsts, fast-templates, baked-templates
│   │   ├── decode/          # fast-result, baked-result
│   │   ├── response/        # terminal, error-bodies
│   │   └── routes/          # read/head/json-write/echo/delete/options/fallback factories
│   ├── native/              # Native transport: bun:ffi (primary on Bun) + NAPI fallback
│   │   ├── types.ts         # NativeAddon interface + instance types
│   │   ├── loader.ts        # getAddon/lazyAddon path resolution
│   │   ├── ffi.ts           # bun:ffi C-ABI bindings (Bun-only; bind-time self-test)
│   │   └── index.ts         # Barrel
│   ├── rust-ffi/            # Rust FFI bindings
│   │   ├── options.ts       # RustOptions + input-normalization helpers
│   │   ├── addon.ts         # shared lazy addon proxy
│   │   ├── context.ts       # per-instance state + namespace helpers
│   │   ├── text.ts          # string namespace
│   │   ├── batch.ts         # array-of-bytes namespace
│   │   ├── packed.ts        # raw packed-wire namespace
│   │   ├── scalar/          # scalar/feature methods (interface + per-domain builders)
│   │   ├── client.ts        # createRust factory + default `rust`
│   │   ├── proven.ts        # `proven` client (full surface, annotated)
│   │   └── index.ts         # Barrel
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
│   ├── REPO_MAP.md          # ← START HERE: what is where & why
│   ├── GETTING_STARTED.md   # Intern-friendly tutorial
│   ├── ARCHITECTURE.md      # Deep-dive internals
│   ├── INGRESS.md           # Pre-baked ingress API
│   ├── BENCHMARKS.md        # Benchmark scenarios
│   └── ENVIRONMENT.md       # Env vars
└── scripts/                 # Build/utility scripts
```

---

## Performance Characteristics

All Rust FFI functions are designed for **zero-allocation** paths where possible:

- **Ingress pipeline**: Single output buffer written by Rust, read by JS — minimal copies
- **Validation functions**: Pure CPU-bound, 10-100x faster than JS equivalents
- **Hashing**: SIMD-optimized crates under the hood
- **Batch operations**: Packed binary format minimizes boundary crossings
  (the batch/packed namespaces use the NAPI fallback — no C-ABI batch symbols)
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
git tag v<version> && git push origin v<version>
```

> Run `bun run check:version` first — it verifies `package.json`, `Cargo.toml`,
> and `CHANGELOG.md` agree. See [docs/REPO_MAP.md](./docs/REPO_MAP.md) §6.

### Manual

To build and publish a release by hand (no CI needed; npm logged in or `NPM_TOKEN`
exported):

```bash
bun run publish:manual                            # build + publish current version
bun run publish:manual -- --increment minor       # bump version + tag + push + publish
bun run publish:manual:dry                        # print the plan, change nothing
```

`publish:manual` bumps the version (`--increment`), creates + pushes the `v<version>`
git tag via `bun pm version` (keeping `Cargo.toml`, `Cargo.lock`, and `CHANGELOG.md`
in sync), builds the host addon locally, and runs `npm publish --access public`.

> **Platform note:** because only the current platform can be built locally, the
> manual publish ships a **single-platform tarball** (it sets
> `CASTRUM_PUBLISH_ALLOW_PARTIAL=1` so `prepublishOnly` doesn't fail on the missing
> platforms). For a full multi-platform tarball, push a `v*` tag and let the CI
> workflow build + publish.

---

## License

MIT

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md).