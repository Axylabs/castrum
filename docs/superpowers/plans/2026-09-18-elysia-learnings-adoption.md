# Elysia → castrum adoption plan (performance, security, stability)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the transferable ideas from Elysia v2 (`~/poc/elysia`) that
close real gaps in castrum — a native-first Rust/Bun HTTP engine — without
touching the two ingress wire formats or the hot-path FFI surface.

**Architecture:** castrum is already *ahead* of Elysia on the data plane
(native packed parsing, pooled/zero-copy output, Bun native `routes`). Elysia's
value is in three places castrum under-invests: (1) **fault containment and
information-leak control** around escaped user code, (2) **bounded, flushable
process-wide caches** and cancellation, and (3) **precomputed static responses**
that never enter JS. This plan ports those three, plus the testing methodology
that proves them.

**Tech Stack:** TypeScript (Bun-first, Node fallback), Rust cdylib via napi-rs +
`bun:ffi`, Biome, `bun test`, `cargo test`, Bun.serve.

**Spec:** this document. Design source: read-only audit of `~/poc/elysia`
(v2.0.0-beta.16) and `~/poc/castrum` (v0.9.8 working tree). Every claim about
either repo is cited `file:line`. Items I could not verify from source are
marked `[verify]`.

---

## Global Constraints

Copied from `AGENTS.md` / `RULES.md`; every task includes them implicitly.

- **Do NOT change the ingress wire formats** (`docs/adr/0001-two-wire-formats.md`):
  success/error body shapes and `ratelimit-*` / `x-ratelimit-*` header names are
  frozen. New error responses must reuse an existing shape.
- **Do NOT change or remove hot-path APIs** (AGENTS.md "Do NOT"); no signature
  churn on `handleRequestPacked`, `handleRequestFullSync*`, scalar `rust.*`.
- **One numeric layout source**: `rust/ingress/output.rs` → `src/ingress/constants.ts`.
- **Runtime seam**: `typeof Bun` lives only in `src/runtime/detect.ts`; env reads
  go through `src/shared/env.ts` (`resolveEnvVar`).
- **Bun-first**: never slow the Bun path for Node; Node falls back, never diverges
  in observable HTTP behavior.
- **Purity boundary**: pure modules must not import `src/native/` or
  `src/shared/buffer-pool.ts` (AGENTS.md "Purity & side-effect policy").
- **Every new `castrum_*` export** routes fallible cores through `panic_guard`,
  is self-tested at bind time, is added to the dlopen map + `ffi/types.ts` + the
  parity test, and uses `u64_fast` for byte counts
  (`docs/FFI_BUN_GUIDE.md`, `docs/HOW_TO_ADD_AN_OP.md`).
- **New public exports** need JSDoc (`bun run check:jsdoc`), and `rust.*` ops need
  a `PROVEN_SELECTION` + `selection.json` entry (`test/unit/contract/proven.test.ts`).
- **Green before start**: `bun run typecheck && bun run lint && bun run check:clean`
  and `cargo test`. Record `bun --version` and the test counts.
- Baseline note: an existing defect-fix plan lives at
  `docs/superpowers/plans/2026-09-18-castrum-hardening-cleanup.md`. That plan is
  **not** duplicated here; where an item overlaps it is referenced, not repeated.

---

## Context — what Elysia does that makes it powerful

Elysia is a JS-first framework whose speed comes from moving work **off the
request path** and its safety from **bounded state + conservative fallback**.
The table maps each mechanism to castrum's current state.

| Elysia mechanism (file:line) | What it buys | castrum today | Verdict |
|---|---|---|---|
| AOT build plugin emits per-route JS, stubs out JIT/TypeBox/sucrose (`src/plugin/aot/core.ts:473-627`, `src/compile/aot.ts`) | No runtime codegen; small bundle; fast cold start | Routes compile once at startup (`src/ingress/server.ts:237-339`); native engine, no runtime codegen | **Already have** (different form) |
| Static routes promoted to `Bun.serve` native table so Bun serves them without JS (`src/adapter/bun/index.ts:184-306`, `compile/handler/index.ts:354-428`) | Removes JS from the request path for static responses | Every route runs the ingress pipeline via JS handler (`src/ingress/routes/read.ts:19-34`) | **Adopt** (C1) |
| Response ownership / `skipClone` to avoid `Response.clone()` (`src/adapter/skip-clone.ts`, `response-ownership.ts:1-10`) | Avoids double-buffering and tee bookkeeping | castrum never clones; pools output buffers (`src/shared/response.ts`, `handlers.ts:501`) | **Already have** |
| `parse-query.ts` single-pass scanner with schema-derived channels (`src/parse-query.ts:19-183`) | Allocation-light URL parsing | Rust zero-alloc packed parsers (`rust/http/query_parser.rs`) | **Already have (stronger)** |
| Validator cache dedupes identical schemas, 1-slot fast path, GC timer (`src/type/validator/validator-cache.ts:263-489`) | N routes with 1 schema compile once | Compiles per instance/route, no cross-route cache (`rust/ingress/api.rs:81-95`, `router.ts:177-200`) | **Adopt** (C2) |
| Immutable default-headers sentinel; skip `Headers` materialization (`src/adapter/default-headers.ts:1`, `adapter/utils.ts:15-20`) | Fewer allocations per response | Memoized `Headers` + origin cache, no clone when no extras (`baked-response.ts:148-176`, `routes/common.ts:62-89`) | **Already have** |
| Bounded caches + generational eviction + `flushMemory()` + `Bun.gc()` (`src/memory.ts:7-14`, `src/utils.ts:42-53`) | Stops slow heap growth; explicit maintenance | Strong pool bounds, but **no global flush API**, unbounded TS metrics/MIME/task queue | **Adopt** (B2/B3) |
| Production error masking, owned-vs-foreign errors, double-fault containment (`src/error.ts:981-1006`, `handler/error.ts:144-153`, `handler/fetch.ts:84-117`) | 5xx never leaks internals; error hook can't crash server | Bun path has **no server-level trap**; escaped errors hit Bun default (`server.ts:347-401`); `onError` is Node-only (`server.ts:115-120`) | **Adopt** (A1) |
| Prototype-pollution defenses: `dangerousKeys`, null-prototype objects, `assignOwn` (`src/utils.ts:498-504`, `adapter/web-standard/utils.ts:133`, `parse-query.ts:25`) | Attacker-controlled keys stay inert | `nativeResponderRoute` does `JSON.parse` into plain objects (`routes/responder.ts:71-81`); audit needed | **Adopt** (A2) |
| Request `AbortSignal` checked between lifecycle stages (`handler/fetch.ts:263-287`) | Cancels work when client disconnects | No `Request.signal` use on the HTTP path | **Adopt** (B1) |
| WebSocket in-flight cap 256 / backpressure / per-message error isolation / drain (`src/ws/route.ts:1126,1213-1220`, `:212-285`) | Bounds memory, isolates errors, clean shutdown | No WS server runtime; handshake helper only (`src/integration/websocket.ts:49-93`) | **Adopt separately** (D1) |
| Differential/metamorphic lane harness byte-compares JIT/precompile/socket/AOT (`test/differential/lanes.ts:217-239`) | Catches lane divergence | proptest + pool-parity, no cross-transport lane harness | **Adopt** (B4) |
| D1 proof-baseline: noise floors + injected-regression self-test (`bench/d1/run.ts:1395-1569`, `README.md`) | Performance claims are statistically gated | ad-hoc benches (`bench/http/run-bench.ts`) | **Adopt later** (D3) |
| Cookie signing with rotation/name-binding/constant-time (`src/cookie/crypto.ts:145-227`) | Safe signed cookies | Primitives exist, not wired into ingress (`rust/crypto/cookie_sign.rs`) | **Adopt separately** (D2) |

**Explicitly NOT ported** (and why): AOT `new Function` codegen (castrum is
native — no runtime JS codegen to eliminate); Memoirist trie matching (Bun's
native router already matches; Node keeps `path-matcher.ts`); response clone
protocol (castrum never clones); `parse-query` JS scanner (native parser is
faster); TypeBox lazy-JIT threshold (native schema compiles once, eagerly — the
right choice for latency); sucrose source analysis (no JS handler analysis
needed).

---

## Phase A — Security / fault containment

### Task A1: Server-level error trap for escaped handlers (Bun + Node parity)

**Why:** `nativeResponderRoute` (`src/ingress/routes/responder.ts:157`) and
`nativeRouteHandler` (`src/ingress/routes/native.ts:129`) call the user
`responder(snapshot)` with **no try/catch**, and a raw `spec.read` function is
wired straight into Bun (`src/ingress/server.ts:261`) and Node
(`server-node.ts:207-211`). A sync throw or async rejection therefore escapes:
on Node it hits the adapter catch-all (`server-node.ts:220-243`, generic 500);
on Bun it hits **Bun's default handler**, which is not castrum-controlled and
may surface stack/internal detail — exactly the class of leak Elysia prevents
with `src/handler/error.ts:144-153`.

**Files:**
- Create: `src/ingress/server-error.ts`
- Modify: `src/ingress/server.ts` (`BuildRouteHandlersOptions` + the three escape
  sites at `:257-261`, `:290-301`, `:303-319`; forward `onError`)
- Modify: `src/ingress/server-node.ts` (reuse the shared error handler)
- Test: `test/unit/ingress/server-error.test.ts`

**Interfaces:**
- Produces:
  - `createServerErrorHandler(opts: ServerErrorOptions): (error: unknown, req?: Request) => Response`
  - `ServerErrorOptions = { onError?: (info: { error: Error; request?: Request }) => void; logger?: (line: string) => void }`
  - `guardRouteHandler(handler: RouteHandler, onServerError: (e: unknown, req?: Request) => Response): RouteHandler`
  - `internalErrorBody` = the existing `ERROR_BODIES.internal` bytes (reuse; do
    not define a new wire shape).
- Consumes: `ERROR_BODIES.internal` (`src/ingress/response/error-bodies.ts:46`),
  `memoizedHeaders` (`src/ingress/headers/memoized-headers.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/ingress/server-error.test.ts
import { expect, test } from 'bun:test'
import { createServerErrorHandler, guardRouteHandler } from '../../../src/ingress/server-error'

test('sync throw becomes a generic 500 with no thrown text', async () => {
  const handler = guardRouteHandler(
    () => { throw new Error('secret-db-password') },
    createServerErrorHandler({}),
  )
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  const body = await res.text()
  expect(body).toBe('{"ok":false,"error":{"code":"internal_error","message":"Internal server error"}}')
  expect(body).not.toContain('secret-db-password')
})

test('async rejection becomes a generic 500', async () => {
  const handler = guardRouteHandler(
    async () => { throw new Error('secret-2') },
    createServerErrorHandler({}),
  )
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain('secret-2')
})

test('onError sees the real error, runs once, and cannot break the response', async () => {
  let calls = 0
  const onServerError = createServerErrorHandler({
    onError: (info) => { calls++; expect(info.error.message).toBe('boom'); throw new Error('hook-broke') },
  })
  const handler = guardRouteHandler(() => { throw new Error('boom') }, onServerError)
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(500)
  expect(calls).toBe(1)
})

test('success path is unaffected (no wrapping overhead semantics change)', async () => {
  const handler = guardRouteHandler(() => new Response('ok'), createServerErrorHandler({}))
  const res = await handler(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/unit/ingress/server-error.test.ts`
Expected: FAIL — module `src/ingress/server-error.ts` does not exist.

- [ ] **Step 3: Implement `src/ingress/server-error.ts`**

Reuse the pre-encoded internal body; **never** put `error.message`/stack in the
response (wire format + info-leak rule). The guard must handle both sync and
async returns:

```ts
// src/ingress/server-error.ts — request-handler fault containment.
import { ERROR_BODIES } from './response/error-bodies'
import { memoizedHeaders } from './headers/memoized-headers'
import type { RouteHandler } from './server'

export interface ServerErrorOptions {
  onError?: (info: { error: Error; request?: Request }) => void
  logger?: (line: string) => void
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Build a masked-500 responder. Never throws; the onError hook is contained. */
export function createServerErrorHandler(
  opts: ServerErrorOptions,
): (error: unknown, req?: Request) => Response {
  const headers = memoizedHeaders([['content-type', 'application/json; charset=utf-8']])
  return (error, req) => {
    const err = toError(error)
    if (opts.onError) {
      try { opts.onError({ error: err, request: req }) } catch { /* swallowed by design */ }
    }
    if (opts.logger) {
      try { opts.logger(JSON.stringify({ level: 'error', msg: 'unhandled_handler_error', error: err.message })) } catch {}
    }
    return new Response(ERROR_BODIES.internal, { status: 500, headers })
  }
}

/** Wrap a route handler so sync throws and async rejections are contained. */
export function guardRouteHandler(
  handler: RouteHandler,
  onServerError: (error: unknown, req?: Request) => Response,
): RouteHandler {
  return (req, srv, params) => {
    try {
      const out = handler(req, srv, params)
      return out instanceof Promise ? out.catch((e) => onServerError(e, req)) : out
    } catch (e) {
      return onServerError(e, req)
    }
  }
}
```

- [ ] **Step 4: Wire it into `server.ts`**

Add `onError` and `logger` to `BuildRouteHandlersOptions` (`server.ts:226-229`),
build `const onServerError = createServerErrorHandler({ onError, logger })`, and
apply `guardRouteHandler` **only to the escape-capable handlers**: raw
`spec.read` (line 261), the `responder` route (line 292-300) and the `native`
route (line 307-318). Built-in factories (`readHandler`, `jsonWriteHandler`,
`echoHandler`, `deleteHandler`, `optionsHandler`, `fallbackHandler`) already
contain their own error handling — do **not** wrap them (keeps the hot path
unchanged). Then pass `onError`/`logger` from `createIngressServer` into
`buildRouteHandlers` (currently omitted, `server.ts:369`).

- [ ] **Step 5: Route Node through the same handler**

In `server-node.ts`, replace the inline catch-all body construction
(`:220-243`) with `createServerErrorHandler({ onError })` so both runtimes emit
the same generic 500 and invoke the same hook. (The adapter still must
`res.destroy()` when headers were already sent; keep that branch.)

- [ ] **Step 6: Verify + commit**

Run:
```bash
bun test test/unit/ingress/server-error.test.ts
bun run typecheck && bun run lint && bun run check:jsdoc
bun run bench:http:smoke
git add src/ingress/server-error.ts src/ingress/server.ts src/ingress/server-node.ts test/unit/ingress/server-error.test.ts
git commit -m "feat(ingress): contain escaped handler errors with a masked 500 on Bun and Node"
```

---

### Task A2: Prototype-pollution audit + guards on JS object materialization

**Why:** Elysia treats `__proto__`/`constructor`/`prototype` as inert data and
builds null-prototype containers (`src/parse-query.ts:25`,
`adapter/web-standard/utils.ts:133`, `utils.ts:498-504`). castrum's native
parsers return packed pairs, but JS turns them into plain objects in the
responder bridge (`routes/responder.ts:71-81` `JSON.parse` → plain object;
`:134-142` casts to `Record`). A query/cookie/body key of `__proto__` must not
mutate an object prototype or reach a responder that then merges it into config.

**Files:**
- Modify: `src/ingress/routes/responder.ts` (`parseSection`, snapshot assembly)
- Modify: `src/ingress/routes/native.ts` (`pairsToRecord`) and audit every
  `Object.fromEntries`/`JSON.parse` on request-derived data
- Modify: any `pairsToRecord` helper it calls
- Test: `test/unit/ingress/prototype-pollution.test.ts`

**Interfaces:**
- Produces: `safeRecord(): Record<string, unknown>` (null-prototype) and
  `assignOwn(target, key, value)` used by all request-derived object builders.
  `__proto__`/`constructor`/`prototype` are assigned as **own** data (or skipped)
  but never as accessors on the prototype chain.

- [ ] **Step 1: Write failing tests**

```ts
// test/unit/ingress/prototype-pollution.test.ts
import { expect, test } from 'bun:test'
import { parseQueryPairsSafe } from '../../../src/ingress/routes/responder' // export for test

test('__proto__ query key is inert own data', () => {
  const rec = parseQueryPairsSafe('__proto__=polluted&a=1')
  expect(({} as any).polluted).toBeUndefined()
  expect(rec.a).toBe('1')
})

test('constructor key does not overwrite the constructor', () => {
  const rec = parseQueryPairsSafe('constructor=evil')
  expect(typeof rec.constructor).not.toBe('string' === 'x' ? 'x' : 'function')
})
```

- [ ] **Step 2: Run — FAIL (helper absent).** `bun test test/unit/ingress/prototype-pollution.test.ts`

- [ ] **Step 3: Implement + audit**

Use `Object.create(null)` for the record root and assign via
`Object.defineProperty(rec, key, { value, enumerable: true, configurable: true, writable: true })`
(or skip `dangerousKeys`), so a `__proto__` key becomes own data. Grep
`Object.fromEntries`, `JSON.parse`, and object literals fed by
`req.headers`/`parseSection`/`pairsToRecord` and route them through the helper.

- [ ] **Step 4: Verify + commit**

```bash
bun test test/unit/ingress/prototype-pollution.test.ts
bun run typecheck && bun run lint
git add -A src/ingress/routes test/unit/ingress/prototype-pollution.test.ts
git commit -m "fix(ingress): make request-derived object keys prototype-safe"
```

---

### Task A3: ReDoS / resource-limit regression test for schema `pattern`

**Why:** Elysia pins a linear-time `${t.Numeric}` check against a 200 KB attack
because a naive numeric regex can backtrack catastrophically
(`test/regression/security.test.ts:6-27`). castrum's `fast_schema` evaluates
**schema-author-supplied** `pattern`/`patternProperties` via `fancy-regex`
(`AGENTS.md` "Ingress schema (fast path)") against **attacker-controlled**
input. A pathological pattern could burn CPU. This is a resource-exhaustion
class defect; the test encodes intent even if the fix is "document the trust
boundary + cap input".

**Files:**
- Test: `test/unit/ingress/regex-dos.test.ts`
- Docs: `SECURITY.md` ("Schema `pattern` is trusted author input") if no code
  change is warranted.

- [ ] **Step 1: Write the test** — build an `IngressSchema` with a
  backtracking-prone `pattern` (e.g. `^(a+)+$`) and validate a 50 KB
  non-matching string under a wall-clock bound; assert it completes under a
  budget (e.g. 50 ms) **or** that the schema was rejected/marked unsupported.
- [ ] **Step 2: Run.**
- [ ] **Step 3: Decide the fix from evidence**: if it backtracks, add a schema
  compile-time pattern-size/`fancy-regex` backtrack limit (or route the pattern
  to the `jsonschema` fallback which has its own limits) and add a compile-time
  guard. If it is already linear, document the trust boundary in `SECURITY.md`
  and keep the test as a regression pin.
- [ ] **Step 4: Verify + commit.**

---

## Phase B — Stability / reliability

### Task B1: Plumb `Request.signal` cancellation through the request path

**Why:** Elysia checks `context['~sig'].aborted` between lifecycle stages and
returns early (`handler/fetch.ts:263-287`), so a disconnected client stops work.
castrum never reads `Request.signal`; a slow body read or a long pipeline keeps
running after the client is gone, and pooled buffers stay held.

**Files:**
- Modify: `src/ingress/body.ts` (`readBodyWithLimit`, `:139-268`) — race the read
  against `req.signal` and reject with a cancellation error; remove the abort
  listener on settle.
- Modify: `src/ingress/handlers.ts` (`run()`, `:456-650`) — check
  `req.signal?.aborted` before the native call and after it, releasing the pooled
  handle on the abort path exactly like the existing early-throw path
  (`:622-630`).
- Modify: `src/ingress/routes/responder.ts` / `native.ts` — treat cancellation
  as no response (or a 499-style no-op) rather than a 500.
- Test: `test/unit/ingress/abort.test.ts`

**Interfaces:**
- Produces: `isAbortError(err): boolean`; body read rejects with
  `{ code: 'REQUEST_ABORTED' }`; `run()` returns/throws for an aborted signal.

- [ ] **Step 1: Write failing tests** — an `AbortController` aborted before and
  during a streamed body read; assert the read rejects promptly and the pooled
  buffer is released (reuse `test/property/pool-parity.test.ts` assertions).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the listener race in `body.ts` + the two
  `req.signal.aborted` checks in `handlers.ts`. Keep the shared watchdog
  (`body.ts:76-137`) untouched — add an abort listener that removes itself.
- [ ] **Step 4: Verify** `bun test test/unit/ingress test/property` + `bun run bench:http:smoke`.
- [ ] **Step 5: Commit.**

---

### Task B2: Bounded caches + public `flushMemory()`

**Why:** Elysia ships `flushMemory()` (clear caches + `Bun.gc()`) and bounds
every cache with generational eviction (`src/memory.ts:7-14`,
`src/utils.ts:42-53`). castrum has **no memory-flush API** and three unbounded
structures:
- TS metrics registry: `values`/`counts`/`sums` Maps grow per distinct label set
  (`src/shared/metrics.ts:73-93`, no cap).
- `mimeStrCache` (`src/rust-ffi/text.ts:71`) and `mimeByText`
  (`src/rust-ffi/context.ts:113`) keyed by caller extension.
- Task runtime work queue is explicitly unbounded
  (`rust/task/runtime.rs:193-206`) — handled in B3.

**Files:**
- Create: `src/shared/memory.ts` (public `flushMemory(opts?)`)
- Modify: `src/shared/metrics.ts` — add `MAX_SERIES_PER_METRIC` (default 10_000)
  with an eviction policy + a `castrum_metrics_series_dropped_total` counter so
  drops are observable rather than silent.
- Modify: `src/rust-ffi/text.ts`, `src/rust-ffi/context.ts` — bound the MIME maps
  (LRU 1024) and export `clearMimeCaches()`.
- Modify: `src/shared/buffer-pool.ts` — add `shrink()` (drop free buffers).
- Modify: `src/loader/index.ts` — expose the existing `clear()` for the flush.
- Modify: `index.ts` (public export) + `test/unit/contract/proven.test.ts` if a
  `rust.*` surface changes.
- Test: `test/unit/shared/memory.test.ts`, `test/unit/shared/metrics.test.ts`

**Interfaces:**
- Produces:
  - `flushMemory(options?: { gc?: boolean }): void` — clears loader LRU, MIME
    caches, buffer-pool free lists, and (after C2) the native schema cache;
    optionally `Bun.gc()` / `globalThis.gc?.()`. **Never clears metrics** (an
    observability registry is not a cache).
  - `clearMimeCaches(): void` (impure boundary module).
- Consumes: `loader.clear()` (`src/loader/index.ts:578`), `BufferPool.shrink()`.

- [ ] **Step 1: Write failing tests** — (a) metrics cardinality cap drops and
  counts; (b) `flushMemory()` clears caches and is idempotent/safe with no addon.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the cap in `metrics.ts` (evict-oldest-half on the
  per-entry `values` map, mirroring Elysia `evictOldestHalf`), the MIME LRUs, the
  pool `shrink()`, and `flushMemory`.
- [ ] **Step 4: Verify** `bun test test/unit/shared test/unit/rust-ffi` + `bun run check:jsdoc` + `bun run check:clean`.
- [ ] **Step 5: Commit.**

---

### Task B3: Bound the task runtime work queue (admission control)

**Why:** `rust/task/runtime.rs:193-206` documents "the queue is unbounded;
admission/backpressure is a later milestone", and the JS `inflight` Map grows
with submissions (`src/task/runtime.ts:226`). Under load this is a memory-growth
path. Elysia bounds analogous in-flight work with a hard cap + close/error
(`src/ws/route.ts:1126,1213-1220`).

**Files:** `rust/task/runtime.rs`, `rust/task/mod.rs`, `rust/ffi/task.rs`,
`src/task/runtime.ts`; tests `rust/task/tests.rs`,
`test/unit/task/runtime.test.ts`.

**Interfaces:** `submit()` returns a distinct "rejected/overloaded" outcome when
the queue depth exceeds `CASTRUM_TASK_QUEUE_MAX` (default e.g. 4096); JS rejects
the promise with a typed `OVERLOADED` error. Existing `submit` return-type
change must be additive (keep the `bool`-returning C ABI shape or add a new
symbol — `[verify]` against `docs/FFI_BUN_GUIDE.md` §14 ABI rule).

- [ ] **Step 1: Failing test** — submit > cap without draining, assert the
  excess reject with `OVERLOADED` and queue depth is bounded.
- [ ] **Step 2–5:** implement ring bound + atomic depth counter; verify
  `cargo test task && bun test test/unit/task`; commit.

---

### Task B4: Differential transport-lane test harness

**Why:** Elysia's strongest assurance mechanism is running one corpus through
every lane (JIT / precompile / real socket / AOT-reconstruct) and byte-comparing
(`test/differential/lanes.ts:217-239`). castrum has proptest + pool-parity but
no single harness proving **the same request produces identical bytes** across
`bun:ffi` vs `napi`, path-1 (`fast.ts`) vs path-2 (`handlers.ts`), Bun vs Node,
and pooled vs zero-copy.

**Files:**
- Create: `test/differential/lanes.ts` — lane definitions:
  `['ffi','napi']` (transport), `['fast','baked']` (wire format — compare
  normalized shape, **not** raw bytes, since the formats intentionally differ),
  `['copy','zero-copy']`, `['bun','node']`.
- Create: `test/differential/corpus.ts` — ~40 requests (valid/invalid/edge:
  empty body, oversized, bad JSON, bad query encodings, duplicate headers,
  `__proto__`, abort).
- Create: `test/differential/differential.test.ts`.
- Modify: `package.json` test script if a separate gate is desired (keep it out
  of the default `test` path if it requires Node's `dist/` — mirror the
  `test:node` split, `AGENTS.md` Testing).

**Interfaces:** `runLane(lane, corpus): Promise<LaneResult>` where each result
normalizes status + headers-of-interest + body; the harness asserts cross-lane
equality and pins known-divergent fields explicitly.

- [ ] **Step 1: Write the harness + a deliberate divergence test** (inject a
  wrong status in one lane; assert the harness fails).
- [ ] **Step 2: Run — expect the deliberate failure, then fix the injection.**
- [ ] **Step 3: Add the corpus; make all lanes agree.**
- [ ] **Step 4: Commit.**

---

## Phase C — Performance

### Task C1: Static route promotion (serve prebuilt `Response`s from Bun's native table)

**Why:** Elysia pre-maps static `Response`/`Error`/HTML routes and hands them to
`Bun.serve.routes`, so Bun serves them **without entering JS**
(`src/adapter/bun/index.ts:184-306`, `compile/handler/index.ts:354-428`).
castrum already uses `Bun.serve.routes` but every value is a JS handler that
runs the ingress pipeline (`src/ingress/server.ts:261-333`). Health probes and
other constant responses (`src/ingress/health.ts:35-67`) can skip JS entirely.

**Files:**
- Modify: `src/ingress/server.ts` — extend `BakedRoute` with
  `static?: Response | (() => Response)` and wire it directly into
  `methods[GET]` when present, bypassing `readHandler`. `[verify]` that Bun
  accepts a static `Response` (not only a handler) as a route value for the
  current Bun floor; if not, keep the handler but return a cached instance.
- Modify: `src/ingress/health.ts` — expose `staticLiveness()` returning a
  prebuilt `Response` so `/livez` needs no JS.
- Modify: `src/ingress/router.ts` if it should honor `static`.
- Test: `test/unit/ingress/static-route.test.ts`, plus
  `bench/http/load.ts` shape guard (`bun run bench:http:smoke`).

**Interfaces:** `BakedRoute.static?: Response | (() => Response)`; when present,
`read`/`write`/`echo` etc. for that path/method are ignored for GET and the
value is placed in the route table verbatim. Fallback: if Bun rejects a `Response`
value, wrap in `() => staticResponse`.

- [ ] **Step 1: Failing test** — a server with `{ '/livez': { static: prebuilt } }`
  responds 200 with the prebuilt bytes and does **not** run a probe handler
  (assert via a side-effect counter / a Response identity check).
- [ ] **Step 2–4:** implement; verify `bun run bench:http:smoke` shows no shape
  failures; commit.

---

### Task C2: Process-wide schema compile cache (dedupe identical schemas)

**Why:** Elysia's `TypeBoxValidatorCache` compiles a schema once and shares it
across routes/apps (`src/type/validator/validator-cache.ts:263-489`), including
a GC timer. castrum compiles an `IngressSchema` per `Ingress`/`NativeRoute`
(`rust/ingress/api.rs:81-95`, `router.ts:177-200`), so N routes with one schema
pay N compiles at startup and N copies at runtime. This is the one performance
mechanism with a clear, bounded win.

**Files (FFI task — follow `docs/HOW_TO_ADD_AN_OP.md` + `castrum-rust-ffi` skill):**
- Create: `rust/ingress/schema_cache.rs` (bounded `LruCache<SchemaKey, Arc<IngressSchema>>`,
  cap e.g. 128; `SchemaKey = (canonical-json hash, flags)`), re-export from
  `rust/ingress/mod.rs`.
- Modify: `rust/ingress/api.rs` (`Ingress::new`) and
  `rust/ingress/native_route.rs` (`NativeRoute::compile`) to call
  `get_or_compile`.
- Modify: `rust/ffi/` — add `castrum_schema_cache_clear` (must be `panic_guard`ed,
  self-tested, added to the dlopen map + `ffi/types.ts` + parity test).
- Modify: `src/rust-ffi/scalar/factories.ts` (+ `src/native/ffi.ts` bindings) to
  expose `rust.clearSchemaCache()`.
- Modify: `src/shared/memory.ts` (`flushMemory` calls it).
- Tests: `rust/ingress/schema_cache.rs` unit tests, `test/unit/native/ffi-symbol-parity.test.ts`,
  `test/unit/ingress/schema-cache.test.ts`.

**Interfaces:** `schema_cache::get_or_compile(bytes, flags) -> Result<Arc<IngressSchema>, SchemaError>`;
`rust.clearSchemaCache(): void`.

**Safety gate (must hold before sharing):** `IngressSchema` must be immutable
after compile (`Arc` shared across routes/threads). `[verify]` there is no
interior mutability in `IngressSchema`, `fast_schema::FastNode`, or the
`jsonschema::Validator` it holds; if any exists, cache the compiled pieces only
and recompile the mutable shell, or abandon C2.

- [ ] **Step 1: Rust unit test** — compiling the same bytes twice returns the
  same `Arc` pointer (`Arc::ptr_eq`), and `clear` empties the cache.
- [ ] **Step 2:** implement Rust cache + clear.
- [ ] **Step 3: FFI wiring test** — parity test sees the new symbol; bind-time
  self-test passes (`CASTRUM_FFI_MODE=ffi bun test test/unit/native`).
- [ ] **Step 4: JS parity test** — two `createIngressHandler` instances with the
  same schema produce identical behavior to distinct-schema handlers.
- [ ] **Step 5:** `cargo test`, `bun run build`, `bun run bench:startup`,
  `bun run bench:http:smoke`; commit.

---

## Phase D — Larger efforts (separate plans)

These are real Elysia strengths but each is its own subsystem; write a dedicated
plan per item using `writing-plans` before implementation.

- **D1 — WebSocket server lifecycle.** Wire a `Bun.serve({ websocket })` runtime
  into `createIngressServer` with: max message size, an in-flight message cap
  (Elysia uses 256, `src/ws/route.ts:1126`), backpressure-aware send
  (`:212-285`), per-message error isolation, upgrade-time validation parity with
  HTTP, strictest-wins option merging (`:1084-1124`), and drain-on-shutdown.
  castrum currently ships only the handshake helper
  (`src/integration/websocket.ts:49-93`) and no Bun `websocket` config
  (`src/ingress/server.ts:347-401`).
- **D2 — Ingress cookie signing/verification + CSRF gate.** Add an opt-in
  `cookies: { secrets, verify: 'lazy'|'eager' }` to `IngressOptions` that reuses
  the native cookie-signer (`rust/crypto/cookie_sign.rs`) and mirrors Elysia's
  rotation/legacy/name-binding semantics (`src/cookie/crypto.ts:145-227`).
  castrum has the primitives but no ingress integration
  (`rust/ingress/pipeline.rs:454-476`).
- **D3 — Benchmark proof-baseline with noise floors + self-test injection.**
  Port the *methodology* of Elysia D1 (`bench/d1/run.ts:1395-1569`,
  `README.md`) to castrum's HTTP/startup benches: paired blocks, percentile
  bootstrap, machine-pinned baselines, and injected regressions that prove each
  gate can fail. This turns castrum's ad-hoc benches into statistically gated
  claims.
- **D4 — `isProduction()` seam (only if/when verbose dev diagnostics are added).**
  Elysia gates error detail on it (`src/universal/is-production.ts:3-4`). Not
  needed for A1 because castrum's error bodies are static by wire-format rule;
  add it when a dev-only diagnostic path is designed, not before.

---

## Self-Review

- **Spec coverage:** every Elysia mechanism in the Context table is either mapped
  to a task (A1, A2, A3, B1, B2, B3, B4, C1, C2) or explicitly deferred (D1–D4)
  or explicitly rejected with a reason. No silent gaps.
- **Placeholder scan:** no TBD/"handle errors"/"similar to Task N" — each task
  names files, interfaces, and test intent. C2 is flagged with a hard safety gate
  rather than a speculative implementation.
- **Type consistency:** `RouteHandler`, `BakedRoute`, `BuildRouteHandlersOptions`,
  `OptimizedIngressHandler.run` signatures match the current source
  (`server.ts:30-94`, `:226-229`); `createServerErrorHandler`/`guardRouteHandler`
  names are used consistently from A1 onward; `flushMemory`/`clearMimeCaches`
  names are consistent between B2 and C2.
- **Constraint check:** no task changes a wire format, a hot-path signature, or a
  layout constant; A1 reuses the frozen internal error body; C2 is gated on
  proving `IngressSchema` immutability before sharing.

## Suggested order

A1 → B2 → A2 → B1 → C1 → A3 → B4 → B3 → C2 → D*.

Rationale: A1 and B2 are the highest value per unit risk (containment + bounded
memory). C1 is a contained perf win. C2 is the largest perf change and carries an
FFI/ABI cost, so it comes after the safety net (A1/B2/B4) exists.
