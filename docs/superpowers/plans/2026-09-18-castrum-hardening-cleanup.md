# castrum hardening & maintainability sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verified safety, security, and correctness defects in castrum,
finish/repair the in-flight performance WIP, and remove maintainability traps —
without changing the two ingress wire formats.

**Architecture:** Changes are grouped by risk: (P0) native handle/lifecycle
safety, (P1) WIP correctness + ingress security, (P2) crypto hardening +
maintainability. Each task is independently testable and leaves the run green.
No task may alter the success/error body shapes or `ratelimit-*` header names
(`docs/adr/0001-two-wire-formats.md`, AGENTS.md).

**Tech Stack:** TypeScript (Bun-first, Node fallback), Rust cdylib via napi-rs +
`bun:ffi`, Biome, `bun test`, `cargo test`.

**Spec:** This plan is its own spec — it was produced from a read-only audit of
the working tree at commit `adc5d8f` plus uncommitted WIP in
`bench/cost/ingress-cost.ts`, `src/ingress/handlers.ts`,
`src/ingress/packing/gather-raw-headers.ts`, `src/shared/buffer-pool.ts`.
Findings were verified line-by-line against source; anything unverified is
marked `[verify]`.

## Global Constraints

- Bun-first; never slow or complicate the Bun path for Node compatibility.
- One numeric layout source: `rust/ingress/output.rs` → `src/ingress/constants.ts`. Never hardcode.
- Do NOT unify the two ingress wire formats.
- Every fallible `extern "C"` export routes through `panic_guard`; needed-size
  convention `0` = error, `w > out_cap` = exact required size.
- No `static mut`; cross-thread state via atomics/mutex; thread-local scratch only.
- New public exports need JSDoc (`bun run check:jsdoc`) and a `PROVEN_SELECTION` /
  `selection.json` entry if they are `rust.*` ops.
- Docs must match code (RULES.md §7).
- Baseline at plan time: `bun run typecheck`, `bun run lint`, `check:clean`,
  `check:jsdoc` (501/502) pass; 823 TS tests pass. Record `bun --version` and
  `cargo test` count before starting.

---

## Phase 0 — Baseline capture

### Task 0: Record the green baseline and bun version

**Files:** none (evidence only)

- [ ] **Step 1: Capture runtime + test baseline**

Run:
```bash
bun --version
cargo test 2>&1 | tail -20
```
Expected: all Rust tests pass. Save the pass count and bun version in the task log.

- [ ] **Step 2: Commit the plan (and any pre-existing WIP in a separate commit)**

```bash
git add docs/superpowers/plans/2026-09-18-castrum-hardening-cleanup.md
git commit -m "docs(plan): hardening & maintainability sweep"
```
Leave the four WIP source files uncommitted here; Task 7–10 finish them.

---

## Phase 1 — P0: native lifecycle & memory safety

### Task 1: Task-runtime doorbell use-after-free + restart-after-shutdown (CRITICAL)

**Files:**
- Modify: `rust/task/completion.rs` (add `clear_doorbell`)
- Modify: `rust/task/runtime.rs` (shutdown latch; refuse submit after shutdown)
- Modify: `rust/ffi/task.rs:160-166` (`castrum_task_shutdown` clears the doorbell first)
- Modify: `rust/task/mod.rs` (re-export)
- Modify: `src/task/runtime.ts:554-564` (zero the native doorbell before `close()`)
- Test: `rust/task/tests.rs`, `test/unit/task/runtime.test.ts`

**Interfaces:**
- Produces: `rust::task::completion::clear_doorbell()`; `runtime::submit` returns
  `false` once `shutdown()` has run (until an explicit `init`).

**Why:** `push()` (`completion.rs:62-77`) calls the registered trampoline.
`shutdown()` closes the JS `JSCallback` but `DOORBELL` is never reset, and
`runtime::submit` auto-restarts the pool (`runtime.rs:199-203`), so a later
completion can call a freed trampoline.

- [ ] **Step 1: Add a failing JS lifecycle test**

```ts
// test/unit/task/runtime.test.ts
test('shutdown is terminal: a later submit rejects, never restarts the pool', async () => {
  const runtime = createTaskRuntime()
  await runtime.gzipCompress(new Uint8Array([1, 2, 3]))
  runtime.shutdown()
  await expect(runtime.gzipCompress(new Uint8Array([1, 2, 3]))).rejects.toThrow()
})
```

- [ ] **Step 2: Run it to confirm it currently hangs/restarts**

Run: `bun test test/unit/task/runtime.test.ts -t terminal`
Expected: FAIL (resolves instead of rejecting, or restarts the pool).

- [ ] **Step 3: Implement the Rust latch + doorbell clear**

In `rust/task/completion.rs` add:
```rust
/// Disable the doorbell trampoline (`0`). Called on shutdown so a late
/// completion can never call a freed JS callback.
pub fn clear_doorbell() {
    DOORBELL.store(0, Ordering::Release);
}
```
In `rust/task/runtime.rs` add:
```rust
use std::sync::atomic::AtomicBool;
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

pub fn shutdown() {
    SHUTDOWN.store(true, Ordering::Release);
    if let Some(p) = POOL.get() { p.shutdown(); }
}

pub fn submit<F>(job: F) -> bool where F: FnOnce() + Send + 'static {
    if SHUTDOWN.load(Ordering::Acquire) { return false; }
    let p = POOL.get_or_init(TaskPool::new);
    if !p.running.load(Ordering::Acquire) { p.start(default_threads()); }
    p.enqueue(Box::new(job));
    true
}
```
Reset `SHUTDOWN` in `init()` (`init` is the explicit restart path).
In `rust/ffi/task.rs`:
```rust
#[no_mangle]
pub extern "C" fn castrum_task_shutdown() -> u32 {
    task::completion::clear_doorbell(); // BEFORE stopping: no late ring
    task::shutdown();
    task::completion::clear();
    0
}
```
Re-export `clear_doorbell` from `rust/task/mod.rs`.

- [ ] **Step 4: Update the JS runtime**

In `src/task/runtime.ts` `shutdown()`:
```ts
shutdown() {
  for (const [id, deferred] of inflight) { ffi.taskCancel(id); deferred.reject(cancelledError()) }
  inflight.clear()
  ffi.taskSetDoorbell(0)   // native side can no longer call the trampoline
  ffi.taskShutdown()
  release()
  doorbell?.close()
  doorbell = null
}
```
Make the `submit`/`submitInto`/`submitSlice` helpers treat a `false` return as
an error: reject with `new Error('task runtime: pool is shut down')`.

- [ ] **Step 5: Run tests**

Run: `cargo test task && bun test test/unit/task/runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/task rust/ffi/task.rs src/task/runtime.ts test/unit/task/runtime.test.ts
git commit -m "fix(task): clear doorbell + latch shutdown to prevent callback use-after-free"
```

---

### Task 2: `NativeRoute` double-free / use-after-free (HIGH)

**Files:**
- Modify: `src/ingress/native-route.ts:66-159`
- Test: `test/unit/ingress/native-route.test.ts`

**Why:** `ffiHandle` is `const`; `destroy()` frees unconditionally and is
documented "idempotent" but is not; `runFrame()` after destroy passes a freed
handle into Rust (`&*(handle …)`).

- [ ] **Step 1: Add failing tests**

```ts
test('destroy is idempotent and run-after-destroy throws', () => {
  const route = createNativeRoute({ parseQuery: true })
  route.destroy()
  route.destroy() // must not double-free
  expect(() => route.run('a=1', '', null)).toThrow()
})
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/unit/ingress/native-route.test.ts`
Expected: FAIL (throws on second destroy / does not throw on run).

- [ ] **Step 3: Make the handle mutable and guarded**

```ts
let ffiHandle = bunFFI !== null ? compileFfi(bunFFI, descriptor) : 0
// Fall back to napi when FFI is absent OR compile failed (0 = invalid plan).
const napiRoute =
  bunFFI === null || ffiHandle === 0 ? compileNapi(descriptor) : null

const ensureLive = (): void => {
  if (ffiHandle === 0 && napiRoute === null) throw new Error('native route: destroyed')
}
```
In `runFrame` call `ensureLive()` first; in `destroy()`:
```ts
destroy() {
  if (ffiHandle !== 0 && bunFFI !== null) { bunFFI.routeDestroy(ffiHandle); ffiHandle = 0 }
  napiRoute?.destroy?.()
}
```
Update the JSDoc to describe the real contract (idempotent, run-after-destroy throws).

- [ ] **Step 4: Run tests**

Run: `bun test test/unit/ingress/native-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingress/native-route.ts test/unit/ingress/native-route.test.ts
git commit -m "fix(native-route): idempotent destroy + guard run-after-destroy"
```

---

### Task 3: `MetricsRegistry` double-free (MEDIUM)

**Files:**
- Modify: `src/rust-ffi/scalar/factories.ts:381-383`
- Test: `test/unit/rust-ffi/metrics.test.ts` (add case)

- [ ] **Step 1: Add a failing idempotency test**

```ts
test('MetricsRegistry.destroy is idempotent', () => {
  const m = createMetricsRegistry()
  m.destroy()
  expect(() => m.destroy()).not.toThrow()
})
```

- [ ] **Step 2: Implement the guard**

Make `handle` a `let`; in `destroy()`: `if (handle !== 0) { ffi.metricsDestroy(handle); handle = 0 }`.
Give `record`/`render`/`snapshot` a `if (handle === 0) throw new Error('metrics: destroyed')` guard.

- [ ] **Step 3: Run + commit**

```bash
bun test test/unit/rust-ffi
git add src/rust-ffi/scalar/factories.ts test/unit/rust-ffi
git commit -m "fix(metrics): idempotent destroy + use-after-destroy guard"
```

---

### Task 4: Missing `panic_guard` on fallible exports (MEDIUM)

**Files:**
- Modify: `rust/ffi/crypto.rs` (`castrum_password_verify`, `castrum_password_verify_bcrypt`)
- Modify: `rust/ffi/http.rs` (`*_parse_packed` ×4)
- Modify: `rust/ffi/hashing.rs` (`castrum_json_sum_ids`, `castrum_hex_validate_batch`, `castrum_regex_escape`)
- Modify: `rust/ffi/payload.rs` (`castrum_ws_accept_key`, `castrum_ws_frame_encode`, `castrum_ws_frame_decode_packed`)
- Modify: `rust/ffi/task.rs` (`castrum_task_submit*`)
- Test: existing per-module tests (`cargo test`)

**Why:** a panic through `extern "C"` aborts the process. Wrap each body in
`panic_guard(|| core, <safe-fallback>)` where the fallback is `0` for byte
counts, `1` for the `password_verify` u32 protocol (verify: confirm 0 is the
"fail" sentinel), and `std::ptr::null()` for cstring returns.

- [ ] **Step 1: Wrap each export** (read the exact return type first; never guess the fallback).
- [ ] **Step 2: `cargo test` and `cargo clippy`** — expected PASS/clean.
- [ ] **Step 3: `bun run build:all`** (rebuild baseline + v3; stale `.node` segfaults).
- [ ] **Step 4: `bun test test/unit/native`** then commit.

```bash
git commit -am "fix(ffi): panic_guard the remaining fallible extern \"C\" exports"
```

---

### Task 5: `cstring` NUL truncation on rate-limit + accept-negotiation keys (MEDIUM)

**Files:**
- Modify: `src/native/ffi/build/instances.ts:82-88,196-206`
- Test: `test/unit/native/cstring-nul.test.ts`

**Why:** `rateLimiterCheck(inner, key, …)` and
`acceptNegotiatorNegotiateServer` pass user-reachable strings to a `cstring` arg
with no `hasNul` guard (`hasNul` is already imported in this file). A NUL
truncates the key → distinct keys share one bucket.

- [ ] **Step 1:** Check whether a `_bytes` Rust sibling exists for each symbol. If
  yes, route to it. If no, guard with `hasNul` and throw a clear error (fail
  closed) rather than silently truncating.
- [ ] **Step 2:** Add tests asserting a NUL-containing key does not silently
  collide with the NUL-free key.
- [ ] **Step 3:** `bun test test/unit/native` + commit.

```bash
git commit -am "fix(ffi): reject/route NUL-containing rate-limit and accept keys"
```

---

### Task 6: Native route fails open on `validateBody` without `requireJsonBody` (MEDIUM)

**Files:**
- Modify: `rust/ingress/native_route.rs:224-254`
- Modify: `src/ingress/native-route.ts` and/or `src/ingress/routes/native.ts`
- Test: `rust/ingress/native_route.rs` tests + `test/unit/ingress/native-route.test.ts`

**Why:** an absent/oversized body with `validate_body && !require_json_body`
leaves `error_code == 0`, so the JS handler (which only checks `!== 0`) reports
success and the schema is never applied.

- [ ] **Step 1: Add a failing Rust test** where `validate_body=true`,
  `require_json_body=false`, empty frame body → expect `ERR_BODY_NOT_JSON`.
- [ ] **Step 2: Fail closed in `run()`**

```rust
if self.require_json_body || self.validate_body {
    if !has_body || body.len() > self.max_body_bytes {
        body_valid_json = false;
        if self.require_json_body || self.validate_body {
            error_code = ERR_BODY_NOT_JSON;
        }
    } else { /* unchanged */ }
}
```
- [ ] **Step 3: Make the TS handler also check `ROUTE_FLAG.OK`** rather than only
  `errorCode !== 0` (defense in depth), or document that `errorCode` is now the
  single source.
- [ ] **Step 4:** `cargo test` + `bun test test/unit/ingress` + commit.

```bash
git commit -am "fix(native-route): fail closed when validateBody has no body"
```

---

## Phase 2 — P1: finish the WIP correctly + ingress security

### Task 7: Unbounded per-origin header cache under wildcard CORS (MEDIUM)

**Files:**
- Modify: `src/ingress/handlers.ts:330-339` (comment is wrong) and
  `src/ingress/response/baked-response.ts:100-119`
- Test: `test/unit/ingress/baked-response.test.ts`

**Why:** `originHeaderCache` is an unbounded `Map` keyed by attacker-supplied
`Origin`; wildcard CORS allows every origin → remote memory-exhaustion DoS.

- [ ] **Step 1: Add a test** asserting the cache does not grow past a fixed cap
  when many distinct origins pass through.
- [ ] **Step 2:** Bound the map (e.g. `ORIGIN_HEADER_CACHE_MAX = 64`, evict
  oldest / clear when full) or skip caching unless CORS is an exact allowlist.
  Fix the comment at `handlers.ts:330-338`.
- [ ] **Step 3:** `bun test test/unit/ingress` + commit.

```bash
git commit -am "fix(ingress): bound the per-origin header cache (wildcard CORS DoS)"
```

---

### Task 8: WIP prewarm warms the wrong variant (MEDIUM)

**Files:**
- Modify: `src/ingress/handlers.ts:395-421`
- Test: `test/unit/ingress/baked-response.test.ts` (add a prewarm-hit assertion)

**Why:** the loop calls `responseHeaders(HV_CORS_SIMPLE, …)` (variant `&31 = 24`)
while the native success variant is `HV_JSON | HV_CORS_SIMPLE` (`&31 = 31`); the
cached array is unreachable. The comment also claims it fills the memoized
`Headers` WeakMap, but `memoizedHeaders` is never called.

- [ ] **Step 1:** Prewarm with the real success variant (and the terminal variant
  if applicable). Call `memoizedHeaders(...)` in the prewarm, or delete the
  claim. Verify against `rust/ingress/output.rs` when the success variant is set.
- [ ] **Step 2:** Add a regression test that a prewarmed `(variant, origin)` is a
  cache hit for the success path.
- [ ] **Step 3:** `bun run bench:http:smoke` (wire-format guard) + commit.

```bash
git commit -am "fix(ingress): prewarm the actual success header variant"
```

---

### Task 9: WIP `prefill` multiplies memory across router routes (HIGH-impact)

**Files:**
- Modify: `src/ingress/handlers.ts:110-120,296-307`
- Modify: `src/ingress/router.ts:199` (one handler per route)
- Test: `test/unit/shared/buffer-pool.test.ts`, `test/unit/ingress/router.test.ts`

**Why:** `prefill: 16` eagerly allocates `outputBufferSize × 16` per handler;
`createIngressRouter` creates one handler per route and `outputBufferSize` may be
up to 64 MiB → up to 1 GiB per route.

- [ ] **Step 1:** Bound prefill by total bytes, not just count:
  `prefill = min(PREWARM_POOL_BUFFERS, floor(MAX_PREWARM_BYTES / initialSize))`
  with `MAX_PREWARM_BYTES` small (e.g. 4 MiB). Document the trade in
  `docs/INGRESS.md`.
- [ ] **Step 2:** Unit-test `BufferPool` `prefill`: free count, `createdCount`,
  and that `prefill` never exceeds `maxBuffers - 1`.
- [ ] **Step 3:** `bun run bench:http:smoke` + commit.

```bash
git commit -am "fix(ingress): bound pool prefill by bytes (router memory)"
```

---

### Task 10: Bench WIP correctness (instance UAF, timing skew)

**Files:**
- Modify: `bench/cost/ingress-cost.ts`, `ingress-cost-post.ts`, `ingress-js-breakdown.ts`, `ingress-refresh-breakdown.ts`, `ingress-native-decompose.ts`, `router-minimal-breakdown.ts`
- Modify: `src/ingress/packing/gather-raw-headers.ts:173-183` (filter `*`)

- [ ] **Step 1:** Retain every discarded `new NativeIngress(OPTIONS)` instance in
  a module-level `const` so its `innerPtr()` target stays alive.
- [ ] **Step 2:** In `ingress-cost.ts`, pre-generate the request id outside the
  `nativeCmp` timed closure; merge the two `../../src/ingress/shared` imports.
- [ ] **Step 3:** Make `prewarmOriginBlocks` skip `*` (match the handler filter).
- [ ] **Step 4:** `bun run bench:ingress-cost` must run clean; commit.

```bash
git commit -am "fix(bench): retain native ingress instances; de-skew nativeCmp timing"
```

---

## Phase 3 — P2: crypto hardening

### Task 11: JWT time-claim robustness + require-`exp`

**Files:** `rust/crypto/jwt/token.rs:238-265`, `rust/crypto/jwt/api.rs`, tests.

- [ ] Reject (not skip) non-integer / out-of-range `exp`, `nbf`, `iat` — a
  float `exp` currently verifies forever. Add a Rust test with `"exp": 1.75e9`.
- [ ] Add an option to require `exp` (default documented); add a TS test.
- [ ] Replace the hand-rolled `ct_eq` (`token.rs:116-127`) with
  `aws_lc_rs::hmac::verify` or `subtle::ConstantTimeEq`.
- [ ] `cargo test && bun test` + commit.

### Task 12: AEAD batch nonce length validation

**Files:** `rust/crypto/aead.rs:29-37,192-230`, `src/rust-ffi/batch/types.ts`.

- [ ] Validate `nonce.len() == 12` in `batch_nonce`/entry points and return a
  JS error instead of `copy_from_slice` panicking (`rust.aead.encryptBatch`).
- [ ] Document the "fresh base nonce per batch call" contract on the public type.
- [ ] Add a Rust test with a 16-byte nonce → error, not abort. Commit.

### Task 13: Crypto config validation

**Files:** `rust/crypto/{hmac_sha256,cookie_sign,csrf,jwt/api,session}.rs`,
`rust/crypto/bcrypt.rs:17-27`, `rust/crypto/pbkdf2.rs:22-40`,
`rust/crypto/argon2.rs:33-43`.

- [ ] Reject empty HMAC/session/JWT keys (session already does; extend to the rest).
- [ ] bcrypt `cost == 0` → error (not clamp to 4); pbkdf2 `rounds == 0` → error.
- [ ] Cap argon2 `m_cost`/`t_cost`/`out_len` at sane maxima.
- [ ] `cargo test` + commit (split into per-area commits if easier).

---

## Phase 4 — P2: ingress security defaults / parser hardening

### Task 14: Echo route reflected Content-Type XSS

**Files:** `src/ingress/routes/echo.ts:53-88`.

- [ ] Do not reflect `Content-Type` verbatim; default to `application/octet-stream`
  unless it is a safe allowlist, or always force `X-Content-Type-Options: nosniff`.
- [ ] Test: `POST /echo` with `Content-Type: text/html` must not return `text/html`.
- [ ] Commit.

### Task 15: Rate limiting with no `getIp` shares one global bucket

**Files:** `src/ingress/routes/common.ts:42-49`, `src/ingress/server.ts`,
`src/ingress/options.ts`.

- [ ] When rate limiting is enabled and no `getIp` is configured, log a one-time
  warning and/or document the single-bucket behavior. Prefer a fail-loud default.
- [ ] Test that the warning fires (or that the chosen behavior is explicit).
- [ ] Commit.

### Task 16: Duplicate `x-forwarded-for` handling

**Files:** `rust/http/headers.rs:117-126`, `rust/ingress/proxy.rs`.

- [ ] Combine duplicate XFF lines in arrival order instead of keeping only the
  last; pin the behavior and re-run proxy tests. `[verify]` against proxy semantics.
- [ ] Commit.

### Task 17: `cors: {}` resolves to wildcard allow-all

**Files:** `rust/ingress/cors.rs:54-80`, `src/ingress/headers/cors.ts`.

- [ ] Decide and document: an empty `cors` object should not silently allow all
  origins. Prefer default-deny unless `allowOrigin` is set.
- [ ] Update tests + `docs/INGRESS.md`. Commit.
- [ ] **Do not change this without maintainer sign-off** — it is a behavioral default.

### Task 18: Node WS handshake protocol injection

**Files:** `src/ingress/server-node.ts:276-279`.

- [ ] Validate the negotiated subprotocol token (`^[A-Za-z0-9._-]+$`) or build the
  101 response via `Headers` instead of string interpolation.
- [ ] Test with a CRLF-bearing protocol. Commit.

---

## Phase 5 — P2: maintainability

### Task 19: FFI/general doc drift

**Files:** `docs/CASE_STUDY.md:61`, `docs/FFI_BUN_GUIDE.md:495`,
`docs/REPO_MAP.md:40,44,134,297`, `docs/ENVIRONMENT.md:13`,
`.agents/skills/castrum-rust-ffi/SKILL.md:109`,
`.agents/skills/castrum-codebase-map/SKILL.md:34`,
`.agents/skills/castrum-ingress-pipeline/SKILL.md:26,51-54,74`,
`scripts/check-clean.ts:19-25`.

- [ ] Make the counts match `check:clean` (121 total / 109 direct) and fix the
  `nm -D | grep -c castrum_` example. Update the test counts and the zero-copy text.
- [ ] Extend `check:clean` to scan `.agents/skills/**` for the FFI count and to
  catch "C-ABI symbols" as well as "castrum".
- [ ] Run `bun run check:clean`. Commit.

### Task 20: Dead exports, missing JSDoc, accidental duplication

**Files:** `src/ingress/packing/gather-raw-headers.ts:17-21`,
`src/ingress/server.ts:346`, `src/loader/ops.ts:29`, `src/ingress/shared.ts:39`,
`src/native/ffi/build/parse.ts:37`, `src/ingress/server-node.ts:76-77/159-163`,
`src/shared/packed/parsers.ts:56-80`.

- [ ] Remove/narrow confirmed-unused exports (grep first).
- [ ] Add the missing JSDoc on `buildParse`.
- [ ] De-duplicate `hasBody`, the retry-after helper, and the four lazy-addon
  parser wrappers.
- [ ] `bun run check:clean && bun run check:jsdoc && bun test test/unit` + commit.

### Task 21: Extract the duplicated FFI-fallback block in `handlers.ts`

**Files:** `src/ingress/handlers.ts:506-540`.

- [ ] Extract one `handleFfiOrNapi(...)` helper used by both branches; keep the
  failure counter + `ffiDisabled` behavior identical. `bun run bench:http:smoke` + commit.

### Task 22: Document the class exceptions to RULES.md §4

**Files:** `RULES.md`, `src/ingress/routes/responder.ts:48,66,115` (typo).

- [ ] State that `AdaptiveEstimate`, `BakedIngressResult`, `FastIngressResult` are
  sanctioned result/utility classes; fix `IGNGEX_SECURITY_HEADERS` → `IGNEX_SECURITY_HEADERS`.
- [ ] Commit.

---

## Phase 6 — Final verification

### Task 23: Full gate + benchmark before/after

- [ ] `cargo test`
- [ ] `bun run build:all`
- [ ] `bun run typecheck && bun run typecheck:test`
- [ ] `bun run lint`
- [ ] `bun test test/unit test/property test/compat`
- [ ] `bun run test:node`
- [ ] `bun run check:clean && bun run check:jsdoc && bun run check:version`
- [ ] `bun run bench:http:smoke`
- [ ] `bun run bench:startup` (loader untouched, but cheap)
- [ ] Compare `bun run bench:ingress-cost` / `bench:ffi` before vs after; record
  `bun --version` at start and end.
- [ ] Update `CHANGELOG.md`; commit.

---

## Self-Review

**Coverage vs the audit:** FFI lifecycle (1–3), unguarded exports (4), NUL
truncation (5), native-route fail-open (6), WIP correctness (7–10), crypto
(11–13), ingress security (14–18), docs/maintainability (19–22), verification
(23). Findings not yet scheduled and deferred deliberately: argon2 batch-salt
helper (API design), AEAD AAD support (API design), request-id predictability
(documented, not a secret), `isValidResponseStatus(101)` (defense-in-depth),
existing `MAX_OUTPUT_BUFFER_SIZE` export (covered by 20), oversized Rust test
modules (cosmetic). None are P0/P1.

**Open decisions requiring maintainer input before implementation:** Task 17
(`cors: {}` default), Task 15 (fail-loud on missing `getIp`), Task 11 (require
`exp` default). Do not silently change public defaults in those tasks.

**Placeholder scan:** P2/Phase 3–5 tasks specify files and exact behavior but not
full code blocks; each still names the symbol, the current bug, and the
verification command. Expand to full code before executing those tasks.
