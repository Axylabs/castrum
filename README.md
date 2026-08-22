# castrum

**Rust-accelerated primitives and a production-grade HTTP pipeline for Bun — and Node.js.**

castrum is a hybrid TypeScript + Rust package. A single Rust addon does the
performance-critical work — hashing, JSON validation, parsing, crypto,
compression, and a full HTTP request pipeline — while TypeScript gives you a
small, flat API. Bun talks to the addon through `bun:ffi` (a ~10–20 ns C-ABI
call); Node.js falls back to NAPI automatically.

## Why castrum

- **Native speed without the plumbing** — call `rust.crc32()`, `rust.jsonValid()`,
  `rust.validateEmail()`, … directly from TypeScript. No WASM, no subprocess.
- **A real HTTP server in a few lines** — `createIngressServer` wires CORS, rate
  limiting, body-size guards, JSON-schema validation, and security headers for you.
- **Zero-copy hot paths** — request data travels in packed binary buffers shared
  with Rust, so there's no serialization and no per-request allocation.
- **Honest performance data** — the CPU benchmark (`bun run check`) races every
  `rust.*` op against a pure-JS baseline and writes a machine-readable report, so
  you always know what to reach for.
- **Bun first, Node ready** — the same API runs on Node ≥ 20.3 via a compiled ESM
  entry.

> **Want the full story?** See the [case study](./docs/CASE_STUDY.md) for how
> castrum was built and measured — and where native speed did (and didn't) pay off.

## Quick start

### 1. Install

```bash
bun install
bun run build        # compile the Rust addon (release)
```

### 2. Start a server

```ts
import { createIngressHandler, createIngressServer } from "castrum";

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  cors: { allowOrigin: ["https://app.example.com"] },
  rateLimit: { limit: 1000, windowMs: 60_000 },
});

const server = createIngressServer({
  port: 3000,
  routes: {
    "/health":    { read: ingress },                 // GET + HEAD
    "/api/users": { read: ingress, write: ingress }, // + POST/PUT/PATCH (+OPTIONS)
    "/api/echo":  { echo: ingress },                 // POST echo
  },
});

console.log("listening on", server.port);
```

Run it with `bun`, then `curl http://localhost:3000/health`. A complete
walkthrough lives in [`examples/basic-server.ts`](examples/basic-server.ts) and
the tutorial in [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md).

### 3. Call native primitives

```ts
import { rust, encoder } from "castrum";

rust.crc32(encoder.encode("hello"));          // number
rust.jsonValid(encoder.encode('{"a":1}'));    // boolean (zero-DOM)
rust.validateEmail(encoder.encode("a@b.co")); // boolean
rust.text.mimeFromExtension(".js");           // "text/javascript"
rust.batch.jsonValid([docA, docB]);           // Uint8Array bitset (one packed call)
```

Everything is synchronous. For repeated calls, the higher-order
[`loader`](#api-at-a-glance) batches and caches for you automatically.

## Node.js support

Bun is the primary target — it resolves the `bun` export condition to raw
`index.ts` (zero startup cost). Node.js ≥ 20.3 resolves the `node`/`default`
condition to a compiled ESM bundle (`dist/`, built with `bun run build:js`). It's
the same cdylib either way: Bun uses `bun:ffi`, Node uses the NAPI fallback, so
`rust.*` calls behave identically on both runtimes.

```ts
// Node (ESM) — the same pre-baked handlers over node:http
import { createIngressServerNode } from "castrum";
const srv = createIngressServerNode({ port: 3000, routes: { "/health": { read: ingress } } });
await srv.ready; // resolves once listening
```

The public `createIngressServer` is runtime-adaptive — it picks `Bun.serve` on
Bun and `node:http` on Node; `createIngressServerNode` stays available for pinned
Node users with the same route handlers. `rust.transport()` /
`rust.ffiActive()` report which transport is live, and `CASTRUM_FFI_MODE` forces
one (see [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md)).

## How it works

TypeScript is the API; a Rust cdylib (`rust/`, one crate) is the engine. Bun
`dlopen`s the addon and JIT-calls its `extern "C"` exports — that's `bun:ffi`,
the primary transport (~10–20 ns per crossing). On Node, or if the bind-time
ffi self-test fails, the same addon loads through napi-rs (NAPI). Request data is
packed into shared, length-prefixed buffers so hot paths allocate nothing per
request. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full deep
dive.

## Benchmarks

Two suites ship with the repo:

- **CPU benchmark** — `bun run check` races every `rust.*` op against a pure-JS
  baseline (and Bun's built-ins) and writes a machine-readable report to
  `bench/results/cpu/`.
- **HTTP benchmark** — `bun run bench:http` compares raw `Bun.serve`, Elysia,
  and the castrum ingress server across ~20 load scenarios (smoke, stress,
  soak, spike, heavy JSON, slowloris, …).

```bash
bun run check             # CPU benchmark + correctness (writes latest.json)
bun run bench:http        # HTTP benchmark, all servers
bun run bench:http:smoke  # fast HTTP sanity — the CI wire-format guard
```

For scenario details, how to read the reports, and the benchmark-specific env
controls, see [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md). The keep/delegate
decisions for ops where Bun's built-ins win (gzip, crc32, xxh3, `randomUUIDv7`,
…) live in [`docs/bun-builtins-decision-matrix.md`](./docs/bun-builtins-decision-matrix.md).

## API at a glance

The complete, verified reference lives in [`docs/API.md`](./docs/API.md). This
is the map:

| Export | What it is |
|--------|-----------|
| `rust` | The flat native surface: hashing, JSON, validation, URL/cookie/query/form parsing, MIME, WebSocket/SSE, crypto (HMAC, JWT, AEAD, argon2, bcrypt, PBKDF2), signed cookies, CSRF, gzip/brotli, and more. |
| `rust.text.*` | String-in / string-out ergonomics over `rust.*`. |
| `rust.batch.*` | Array-of-bytes → native results (bitsets, typed arrays, byte arrays) in one packed call. |
| `rust.packed.*` | Raw packed-wire low-level variants + metadata. |
| `loader` / `createLoader` | Higher-order loader: pre-bound ops, automatic scalar-vs-bulk dispatch, DataLoader-style coalescing, LRU cache. |
| `opImpl` / `isNativeOp` / `opDecision` | Benchmark-driven native-vs-JS selection hints for framework consumers. |
| `createIngressHandler` + route factories | Pre-baked HTTP pipeline: CORS, rate limit, body guard, schema validation, security headers. |
| `createIngressServer` / `createIngressServerNode` | Server builders — the runtime adapter picks `Bun.serve` on Bun and `node:http` on Node. |
| `createIngress` / `createIngressFast` / `createIngressSync` | Lower-level ingress entry points. |
| `createPipeline` / `createWebSocketUpgrade` / `sseResponse` | Framework-agnostic integration helpers. |
| `createMetrics` / `createIngressMetrics` / `livenessHandler` / `readinessHandler` / trace helpers | Zero-dependency observability. |
| `uuidv7` / `AdaptiveEstimate` / packing & parsing utilities | Shared utilities (`encoder`, `decoder`, `packBatch`, `parseQueryString`, …). |

```ts
import { rust, loader } from "castrum";

rust.jsonValid(bytes);            // scalar boolean
const isEmail = loader("validateEmail");
isEmail([a, b, c]);               // one packed batch call
```

> **The selection surface** — framework consumers that want to bind each op to
> a fixed implementation at load time use `opImpl(op)` / `isNativeOp(op)` /
> `opDecision(op)` (source of truth: `rust/selection.rs` + `src/selection.json`,
> audited by CI). They read it once at startup — they don't swap native↔js per
> call. See [`docs/API.md`](./docs/API.md) and
> [`docs/bun-builtins-decision-matrix.md`](./docs/bun-builtins-decision-matrix.md).

## Testing

```bash
bun test                  # TypeScript unit tests (~760)
bun run test:rust         # Rust unit tests (cargo test)
bun run typecheck         # TypeScript typecheck
bun run test:node         # Node.js integration tests (run `bun run build:js` first)
bun run bench:http:smoke  # HTTP smoke — the CI wire-format guard
```

For coverage floors, the typecheck/test configs, and the full test matrix, see
[`docs/REPO_MAP.md`](./docs/REPO_MAP.md).

## Publishing

The package ships **all platform addons in a single tarball**. Push a `v*` tag
and CI builds + publishes every platform to npm; or use `bun run publish:manual`
for a quick single-platform release:

```bash
bun run publish:manual -- --increment minor  # bump + tag + build + publish
bun run publish:manual:dry                   # print the plan, change nothing
```

Run `bun run check:version` before tagging (it verifies `package.json`,
`Cargo.toml`, and `CHANGELOG.md` agree). See [`docs/REPO_MAP.md`](./docs/REPO_MAP.md)
§6 for the full flow.

## Documentation

| Doc | Read it for |
|-----|-------------|
| [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) | First-time walkthrough: install → server → bench → test. |
| [`docs/API.md`](./docs/API.md) | The complete public API reference. |
| [`docs/INGRESS.md`](./docs/INGRESS.md) | The ingress pipeline: options, route factories, servers, framework integration. |
| [`docs/CASE_STUDY.md`](./docs/CASE_STUDY.md) | Data-driven case study: how castrum was built and measured. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Internals: modules, data flow, wire layout, memory, concurrency. |
| [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) | Benchmark scenarios + how to interpret reports. |
| [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md) | Every `CASTRUM_*` / `INGRESS_*` env var. |
| [`docs/REPO_MAP.md`](./docs/REPO_MAP.md) | Where everything lives + how to build/test/publish. |
| [`docs/bun-builtins-decision-matrix.md`](./docs/bun-builtins-decision-matrix.md) | Bun built-in vs castrum keep/delegate decisions. |
| [`examples/`](examples/README.md) | Runnable examples. |

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) (AI-agent
guidance) for contribution and testing requirements.