# Writing Rust for Bun — FFI Optimization Guide

> **Who this is for**: anyone (human or agent) writing or reviewing the Rust
> `extern "C"` surface in `rust/ffi/` and its `bun:ffi` binding in
> `src/native/ffi.ts`. The rules below are the concrete, citable behaviors of
> Bun's own `bun:ffi` implementation, distilled so that future generated Rust
> code is **optimized for Bun** out of the box — correct on the first `dlopen`,
> fast on the first call, and safe under burst load.
>
> **Version anchor**: behavior claims were distilled from the **Rust-based Bun
> 1.3.14** source (`/home/adeel/poc/bun`) and RE-VERIFIED against the installed
> **Bun 1.4.2** runtime (the local dev toolchain, matching the CI matrix). Where
> a claim is runtime-specific the number is stated inline. `bun:ffi` is
> experimental upstream; the bind-time self-test + napi fallback are what make
> it safe to use, and they are mandatory — not optional.

---

## 1. How `bun:ffi` actually works (the call path)

`bun:ffi` is implemented natively in Bun's JavaScriptCore integration, not as a
JS shim:

- `dlopen(path, { symbols })` resolves each symbol via `dlsym`-style lookup and
  creates a `JSFFIFunction` for it — a JS function that **holds the raw C
  function pointer** and marshals arguments in-engine (`src/js/bun/ffi.ts`,
  `src/runtime/ffi/ffi_body.rs::FFI::open`).
- **Hot call sites compile through the DFG/FTL JIT tiers into direct native
  calls** — "argument conversion, arity handling, and result boxing happen
  in-engine … with no per-argument JavaScript shim" (`docs/runtime/ffi.mdx`,
  "Performance"). This is why the crossing is ~10–20 ns vs ~100–350 ns for a
  Node-API call, and why Bun's own bench puts `bun:ffi` at 2–6× faster than
  Node's N-API (upstream bench `bench/ffi/bun.js` in the Bun runtime checkout
  `/home/adeel/poc/bun`, plus `docs/runtime/ffi.mdx`; castrum's own FFI-vs-napi
  margin bench is `bench/ffi/ffi-margin.ts`).
- The `#[no_mangle] extern "C"` symbols come from the **same cdylib** that
  napi-rs loads under Node — the two transports are two views of one binary.

**Implications for Rust code:**

- Keep `extern "C"` signatures **scalar + pointer/length**. Every argument is a
  register-passable integer, float, or pointer — no variadics, no variadic
  marshaling, no by-value structs (see §10).
- The ABI spec declared in the `dlopen` map (e.g. `["ptr","usize","u32"]`) MUST
  match the Rust signature exactly — there is no runtime checking beyond the
  bind-time self-test. A mismatch is a crash, not an error.

---

## 2. The ABI type system (`FFIType`)

The numeric tags are pinned by static asserts in
`src/jsc/bindings/JSCFFIBridge.cpp` (do not rely on the numbers; rely on the
string names). Canonical names used by castrum's `dlopen` map:

| Rust type       | `bun:ffi` name    | Notes |
|-----------------|-------------------|-------|
| `u8`            | `"u8"`            | returns as JS `number` |
| `u32`           | `"u32"`           | returns as JS `number` |
| `usize` / `u64` | `"usize"`/`"u64"` | `usize == u64` on the host ABI; returns surface as **BigInt** unless `u64_fast` |
| `i64`           | `"i64"`           | args passed as `BigInt(...)`; returns as BigInt |
| `f64`           | `"f64"`           | e.g. `castrum_http_date_into(secs: f64, …)` |
| `*const u8`     | `"ptr"`           | TypedArray/DataView auto-converted to its pointer; a plain `number` is passed through |
| `*const u8` (NUL-terminated string) | `"cstring"` | args: JS string transcoded to a call-scoped NUL-terminated UTF-8 buffer (zero JS-side encode — the engine does it); returns: cloned JS string. **ARGS are the fast string-input path** (see §3 shape 4) |
| `*const u8` + length as a pair | `"buffer"` + `"buffer_length"` | see §4 |
| `void`          | `"void"`          | — |
| —               | `"u64_fast"` / `"i64_fast"` | unboxed `number` when the value fits in a double (< 2^53); no BigInt boxing |

> Full table (incl. `i8..i32`, `f32`, `bool`, `char`, `function`, `napi_env`,
> `napi_value`) is in `docs/runtime/ffi.mdx` → "FFI types" and
> `packages/bun-types/ffi.d.ts`.

**Rule**: for any return that is a byte count / length / small scalar, use
`u64_fast` in the binding (castrum's `U64_FAST` constant) so the hot path never
boxes a BigInt. Keep the Rust return type as `usize`/`u32` — only the JS binding
changes.

---

## 3. Canonical C-ABI signature shapes (use these)

Everything castrum exports follows one of four shapes. New exports should pick
the matching shape and nothing else:

1. **`(ptr, len) -> scalar`** — pure read of input, no output buffer:
   `pub unsafe extern "C" fn castrum_crc32(data: *const u8, len: usize) -> u32`.
   Bind as `{ args: inputAbi, returns: 'u32' }` (`inputAbi` = the
   `buffer`/`buffer_length` pair or `(ptr,usize)`, see §4).
2. **`(ptr, len, out, out_cap) -> usize`** — output-into-caller-buffer with the
   **needed-size convention** (§12): return the exact required byte count on a
   too-small buffer, `0` = real error. Bind with `abi(['ptr','usize','ptr','usize'])`
   and `returns: U64_FAST`, drive through `growExact`.
3. **`(…) -> *const c_char`** — cstring return (per-thread reused `CSTR_BUF`,
   §7). Only for genuinely string-shaped results; prefer packed buffers for
   structured data.
4. **`cstring` ARG for string inputs** — `f(s: *const c_char) -> …`. When the
   input is TEXT (never NUL) and the JS caller has it as a JS `string`, pass it
   as a `cstring` ARG instead of a `(ptr,len)` pair: the engine transcodes the
   string to a call-scoped NUL-terminated UTF-8 buffer in-engine (zero JS-side
   `encoder.encode`), and the callee borrows via `CStr::from_ptr(s).to_bytes()`
   (no copy). **Benchmark-gated** (`bench:margin` `cstringArg` scenario):
   ~40–52 ns/call vs ~209–233 ns for `encodeUtf8` + `(ptr,len)` — a ~76–82% win,
   including non-ASCII inputs. It is a LOSS for BYTE inputs (decode + re-encode)
   — keep `(ptr,len)` there (the validators ship BOTH shapes:
   `castrum_validate_*` for strings, `castrum_validate_*_bytes` for bytes).
   **Verified `bun:ffi` facts**: JS `null` → NULL pointer, and JS `''` (empty
   string) → NULL too — a present-but-empty value is indistinguishable from
   absent through a `cstring` arg UNLESS a presence flag crosses alongside it.
   Adopted by: the validators (`castrum_validate_*`),
   `castrum_ws_accept_key`, `castrum_mime_from_extension`,
   `castrum_password_verify_bcrypt` (phc), `castrum_rate_limiter_check` (key),
   and `castrum_ingress_handle_components` (url/ip).

   > **CASE STUDY — a conversion we REVERTED (2026-08-23)**: SSE's event/id
   > were converted to `cstring` ARGs (+ presence flags) and shipped briefly,
   > then reverted. The conversion itself was sound; what failed was the dev
   > loop — see §14. Every "bun:ffi is broken" signal during that episode
   > traced back to a mismatched addon↔JS state, never to the engine. Do not
   > cite this as an engine bug.

Opaque instance handles are passed as a **bare `usize`** (`inner: usize`), and
must be null-checked at the top of the function (return the `0` sentinel) —
castrum's `castrum_ingress_handle_packed` / `castrum_*_matcher_matches` etc.

---

## 4. `buffer` / `buffer_length` — the atomic snapshot pair

`FFIType.buffer` (20) and `FFIType.buffer_length` (21) are a paired ABI: pass
the **same** TypedArray/DataView for both, and the callee receives the pointer
and the **byte length** of that same view. The engine reads ptr + byteLength
off the same object **at call time** — an atomic snapshot you cannot get by
passing `view.byteLength` yourself (a JS-side length read can go stale against
a resizable/growable/transferred buffer). Source:
`packages/bun-types/ffi.d.ts` (`buffer_length` doc), `docs/runtime/ffi.mdx`.

- **Argument-only**: valid for `dlopen`/`linkSymbols`/`CFunction` args, NOT for
  `cc()` or `JSCallback` (`src/runtime/ffi/ffi_body.rs::reject_cc_unsupported_types_error`).
- **castrum's pattern** (`src/native/ffi.ts`): `probeBufferLength()` verifies
  the pair at bind time (an older Bun canary threw "invalid ABI type" for it);
  when supported, the `abi()` transformer rewrites every `(ptr,usize)` pair to
  `(buffer,buffer_length)` and call sites pass the view twice (`lenOrView`).
  When not supported, explicit `(view, view.length)` is used. The probe makes
  the fast path the default on every modern Bun (1.3.x+) with zero drift.

**Rule**: keep the probe. Never hardcode the pair as the only path — a future
Bun could remove it, and the probe + `(ptr,usize)` fallback is what keeps the
transport working.

---

## 5. Pointers are `number`, not `BigInt`

Bun represents pointers as a JS **`number`** (`type Pointer = number` in
`packages/bun-types/ffi.d.ts`). 64-bit processors address ≤52 bits, which fits
in a double's 53-bit mantissa. Passing a `BigInt` to an FFI arg is converted to
a `number` anyway (`docs/runtime/ffi.mdx` → "Pointers"). Windows HANDLE values
are the exception — use `u64` for those.

- Get a pointer from a TypedArray with `ptr(view)`; read back with
  `read.*` (fast, no DataView/ArrayBuffer alloc) or `toArrayBuffer`/`toBuffer`.
- **`u64`/`i64` returns** surface as BigInt (boxed) unless you bind
  `u64_fast`/`i64_fast` (§2).
- **castrum's application**: the ingress opaque handle is obtained from napi as
  a BigInt and converted to a number ONCE (`Number(handler.ingressInnerPtr())`
  in `src/ingress/fast.ts` / `handlers.ts`), then passed as a `usize` arg —
  number is cheaper than BigInt on the hot path.

**Rule**: pass opaque handles as `usize`/number; convert the napi BigInt once,
not per call. If a function could ever receive a value ≥ 2^53, it cannot be a
pointer — rethink the ABI.

---

## 6. `cstring` returns are cloned at call time

When a symbol's return type is `cstring`, Bun clones the NUL-terminated C
string into a JS `string` at call time and returns that; `NULL` → `null`
(`src/js/bun/ffi.ts` `FFIBuilder`, `docs/runtime/ffi.mdx` → "Strings" +
"engine-native cstring" tests in `test/js/bun/ffi/ffi.test.js`). The engine
copies **nothing itself** — the C side must own the memory until the call
returns.

- **castrum's application**: the per-thread reused `CSTR_BUF` in `rust/ffi/`
  (`cstring_return`) is exactly right — the clone is synchronous, so reusing
  the buffer across calls is safe.
- **Aliasing caveat**: a C function that returns a pointer *derived from a
  `cstring` argument* you passed as a JS string — that argument was transcoded
  into an engine call-scoped buffer — is valid only until your **next** FFI
  call reuses that buffer. Clone it rather than holding the raw address. Avoid
  returning pointers into argument memory.

**Rule**: use per-thread reused buffers for cstring returns; never return a
pointer into JS-owned memory; treat `null` as the failure sentinel.

### 6.1 `cstring` ARGS: the engine transcodes — and truncates at NUL

The same doc section defines the **argument** side, which is a different trade
from returns:

> "When used in `args`, `FFIType.cstring` accepts everything `ptr` does and
> additionally accepts a JavaScript string directly. The engine transcodes the
> string to a **null-terminated** UTF-8 buffer that lives for the duration of
> the call, so you don't need to encode it into a `Buffer` yourself."

This is a real win — it removes a `TextEncoder` round trip per call, and it is
why castrum binds the string surfaces (`validate*`, `metrics_*`,
`regex_escape_str`, `ws_accept_key`, `mime_from_extension`, `session_*`, the JWT
/route id strings) as `cstring` ARGs, with byte-input callers crossing as
`(buffer, buffer_length)` instead. But "null-terminated" is load-bearing:

**An embedded `U+0000` silently truncates the value native-side.** Where the
callee answers with a VERDICT, that is a correctness hole, and two shipped bugs
came from it (found 2026-09-11, both now fixed and pinned by
`test/unit/native/cstring-nul.test.ts`):

| call | was | now |
|---|---|---|
| `rust.validateEmail(bytes('a@b.com\0<script>'))` | `true` | `false` |
| `rust.regexEscape('abc\0def')` | `'abc'` | `'abc\0def'` |

The validator case was the worst shape: bytes were decoded to a JS string and
handed to the `cstring` ARG, so a NUL **byte** made a non-address validate. The
fix routes byte-input APIs through the `*_bytes` symbols — which is also
**faster**, because the bytes then cross as an atomic `(buffer, buffer_length)`
pair with no transcode. Measured through the PUBLIC API (`rust.validateEmail`,
400k calls, Bun 1.4.2): email 236 → 110 ns, uuid 153 → 50 ns, ipv4 118 → 37 ns.
Correctness and speed pointed the same way; the old comment claiming the decode
route was faster predated the byte siblings.

Two further byte-input sites were closed the same way, with one caveat worth
recording. `mimeFromExtension` no longer resolves a NUL-suffixed extension as its
prefix (`'.js\0evil'` resolved as `.js` — a Content-Type chosen from truncated
input; it now takes the unknown sentinel). `wsAcceptKey` no longer computes the
accept value for a prefix of the key. Both KEEP the `cstring` fast path and divert
only the NUL case, because measuring the real call path reversed the raw-binding
result: `rust.wsAcceptKey` is 367 ns via `cstring` versus 381 ns via the byte
sibling (the extra `subarray` + decode outweighs the transcode saved), whereas
measuring the bare binding suggested the opposite. **Measure through the function
users call, not the binding** — the guard itself costs ~4 ns, so guarding is
cheap and routing everything through bytes is not always a win.

**Rule**: a `cstring` ARG is only correct when truncation cannot change the
answer — i.e. the string is developer-supplied config or NUL-free by
construction (a MIME extension, a base64 key, a header name). Anything
reachable from user input must either

1. cross as bytes (`buffer` + `buffer_length`) when the API is byte-shaped, or
2. be guarded with `hasNul` (`src/native/ffi/build/util.ts`): short-circuit the
   verdict (`false`), throw at declare time (metric names / label keys), or
   route to the `(ptr, usize)` sibling for a byte-exact result (`regexEscape`,
   batch hex validation).

Never silently return a value derived from a truncated prefix.

---

## 7. `dlopen` lifetime — never `close()` while bound symbols live

Bun deliberately **leaks** a `dlopen`'d library if you never call `close()`:
"dlclose on GC is unsound because `.ptr` addresses escape the collector's view"
(`src/runtime/ffi/ffi_body.rs` — `FFI::finalize`). Each `JSFFIFunction` also
holds a reference to its owning FFI object so the dylib stays alive as long as
any bound function is reachable.

- **castrum's application**: `getBunFFI()` binds once, holds the symbols for
  the process lifetime, and never calls `close()`. That is the correct pattern
  — do not "clean up" by closing a live library. Closing is only for short-lived
  ad-hoc libraries (e.g. a `dlopen` in a test), and only after no bound
  function can be called.

**Rule**: bind once, hold forever. If you ever call `close()`, it must be after
all bound symbols are unreachable.

---

## 8. Thread-safety & per-thread caches

`bun:ffi` symbols are shared across Worker threads (same dlopen'd cdylib
mapping; verified by castrum's `bench/ffi/ffi-workers.ts` — 4 workers, no
thread-safety issue). The Rust side must therefore keep any per-call mutable
state **thread-local**, never global:

- `HMAC_KEY_CACHE` (`thread_local! RefCell<LruCache<Vec<u8>, hmac::Key>>`) —
  compiled-key cache with zero lock contention across threads.
- `CSTR_BUF` (`thread_local! Vec<u8>`) — cstring return buffer.

**Rule**: no `static mut`, no shared mutable global in the C-ABI path. Use
`thread_local!` for per-thread scratch/caches, or `OnceLock` for immutable
one-time state. Never hold a `Mutex` across an FFI call.

---

## 9. There is no struct-by-value — use packed length-prefixed buffers

`bun:ffi`'s FFIType set has **no struct member** (only scalars, `ptr`,
`cstring`, `buffer`, `function`, and the napi types). You cannot pass a JS
object as a C struct argument, and a Rust `#[repr(C)]` struct is not directly
marshalable. This is why castrum's wire format is **packed, length-prefixed
byte buffers**:

- Inputs are packed by JS (`IngressInputPacker`, `pack_headers`, packed
  parsers) into a `Uint8Array` and passed `(ptr, len)`.
- Outputs are written by Rust into a caller buffer as
  `[u32 count][u32 field_len][field bytes]…` (or fixed-slot layouts like the
  `IngressLayout` 38×`u32` blob / rate-limit verdict `[u8][u32][i64]`).

This also enables zero-copy sharing and buffer pooling — a struct-by-value ABI
would have forced per-call copies.

**Rule**: for any multi-field result, define a packed byte layout (fixed slots
or length-prefixed sections), declare it in ONE Rust place (e.g.
`rust/ingress/output.rs`), mirror it in JS (`src/ingress/constants.ts`), and pin
it with a unit test + bind-time self-test. **Alignment**: keep 8-byte scalar
fields (e.g. the `i64 reset_ms`) aligned to 8 in the layout so Rust reads are
unclipped and DataView reads are natural.

---

## 10. Callbacks (`JSCallback`) — use sparingly, never in hot paths

`JSCallback` lets native code call back into JS. A `threadsafe` callback copies
the C args on the calling thread and **marshals the invocation onto the JS
thread** — from C's point of view it is asynchronous, and the value returned to
C is unspecified (treat it as `void`) (`docs/runtime/ffi.mdx` → "Callbacks",
`src/jsc/bindings/JSCFFIBridge.cpp::Bun__jscFFITimeadDispatch`). Async functions
are not supported. Each crossing has marshaling + event-loop cost.

**Rule**: prefer a synchronous return over a callback. If a callback is
unavoidable (push/event-driven integrations), pass `JSCallback.prototype.ptr`
directly (slightly faster than the object), declare `returns: "void"`-ish on the
C side, and call `close()` when done. castrum's hot request path uses **zero**
callbacks — keep it that way.

---

## 11. Mandatory rules for every new Rust export

These are not optional — they are what make the C-ABI surface safe on Bun (no
napi-style unwind guard exists for raw `extern "C"`).

1. **`panic_guard` every fallible/allocating core** (`std::panic::catch_unwind`
   in `rust/ffi/`, `AssertUnwindSafe` for captured `&mut [u8]`). An uncaught
   panic unwinding through `extern "C"` kills the whole Bun process — this is
   what happened under `11-concurrent-burst`.
2. **Bind-time self-test for EVERY new symbol** (`src/native/ffi/selfTest`).
   `bun:ffi` is experimental upstream; the self-test + napi fallback is the
   safety net. No symbol ships without a self-test vector.
3. **Needed-size convention** for variable-size outputs: return the EXACT
   required byte count on a too-small buffer; `0` stays a REAL error. JS uses
   `growExact` (allocate once, retry once — never a doubling re-run).
4. **Null-check every pointer arg** (`if data.is_null() && len != 0 { return 0 }`)
   and every opaque handle (`inner == 0` → sentinel).
5. **`u64_fast` byte-count returns** so the JS side avoids BigInt boxing.
6. **Thread-local scratch** — no global mutable state (§8).
7. **Parity**: add the symbol to the `dlopen` map, `ffi/types.ts` (`BunFFI`),
   the scalar builder, and `ffi-symbol-parity.test.ts`; a Rust unit test +
   self-test; cross-check FFI vs napi byte-for-byte in `ffi.test.ts`.

### 11.1 Conformance with Bun's published FFI guidance (audit)

The question "are we using Bun's FFI the way Bun recommends?" is answerable from
this table rather than from memory. Verified 2026-09-11 against
`https://bun.sh/docs/api/ffi` and the live binding on Bun 1.4.2
(`ffiBufferMode() === 'buffer-pair'`).

| Bun's guidance (docs) | castrum | Where |
|---|---|---|
| `buffer` + `buffer_length`: pass the **same view twice** for atomic ptr+len | **Followed and LIVE** — `abi()` rewrites every `(ptr,usize)` pair; `probeBufferLength()` verifies support at bind time with a `(ptr,usize)` fallback | §4, `src/native/ffi.ts` |
| `cstring` **returns** are cloned at call time (NULL → null) | Followed — per-thread `CSTR_BUF`, clone is synchronous | §6, `rust/ffi/` |
| `cstring` **args** accept a JS string; the engine transcodes it | Followed for the string surface; **byte-input APIs use `(buffer,buffer_length)` instead — measured 2.2–3.2× faster AND immune to NUL truncation** | §6.1 |
| `u64_fast`/`i64_fast` for byte counts (avoid BigInt boxing) | Followed — `U64_FAST` on every size/count return | §5 |
| `JSCallback`: pass `.ptr`, not the object ("slight performance boost") | Followed — `taskSetDoorbell(Number(cb.ptr))` | §10 |
| `read.u8/u32/...` avoids a `DataView`/`ArrayBuffer` for pointer reads | Applied where it matters (hot paths use pooled JS scratch, not pointer reads); bind-time blob reads keep `DataView` | `instances.ts` |
| `toArrayBuffer` with a deallocator for C-owned memory | **Deliberately NOT used** — Bun 1.4.2's deallocator path segfaults (`arity 1`, crash at `0x0`) while the docs describe 4/5-arg forms. Zero-copy instead keeps ownership in JS | `docs/RND-CONCURRENCY.md` §7a |
| `dlopen` is never `close()`d while symbols live | Followed — bound once, held forever | §7 |
| Async functions are not supported in `JSCallback` | Followed — the doorbell is a `void()` trampoline | §10 |

Reading the table honestly: the `buffer`/`buffer_length` and `cstring` return
practices were already conformant. The real gaps were on the **argument** side
(§6.1) — and those turned out to be correctness bugs, not just style.

### 11.2 Audit log — 2026-09-11 (Bun 1.4.2)

The audit above was run because the practices were *questioned*, not because a
failure was observed. Recording what it found, including the parts that were
already right, so nobody has to re-derive it:

**Already conformant (verified, do not "fix"):**

- `buffer`/`buffer_length` is live — `ffiBufferMode() === 'buffer-pair'`, and
  `abi()` rewrites every `(ptr, usize)` pair.
- `cstring` for returns and for the string surface; `u64_fast` for byte counts;
  `JSCallback.prototype.ptr`; `dlopen` never closed. All per the docs.

**Found and fixed (all correctness, two of them security-grade):**

| finding | evidence | fix |
|---|---|---|
| Validator verdicts could be fooled | `validateEmail(bytes('a@b.com\0<script>'))` → `true` | byte sibling (`buffer`/`buffer_length`), 2.2–3.2× faster too |
| `regexEscape` truncated output | `'abc\0def'` → `'abc'` | route the NUL case to the `(ptr,len)` sibling |
| Batch hex validation could pass a prefix | joined ids truncated at a NUL | same |
| Query/cookie gates could validate a prefix | `cstring` ARG + user-supplied wire text | short-circuit `false` on NUL |
| Metric label values silently merged series | truncation collapsed two label values into one | throw at declare time / reject at record |
| `mimeFromExtension` resolved a NUL-suffixed extension as its prefix | `.js\0evil` → `text/javascript` | unknown sentinel |
| `wsAcceptKey` hashed a prefix of the key | suffix silently ignored | byte path for the NUL case |

**Methodological corrections (both were nearly written into the docs as fact):**

1. **Raw-binding probes mislead.** `getBunFFI()!.op(...)` omits the memoized
   `ffi()` hop and the caller's own decode/subarray. For `wsAcceptKey` it made the
   byte path look 11% faster when through `rust.wsAcceptKey` it is 4% *slower*
   (381 vs 367 ns) — so that call keeps `cstring` and diverts only the NUL case.
2. **Closure-wrapped micro-benchmarks inflate small costs.** A guard that
   measured 90 ns inside a benchmark closure is 3.6 ns isolated (`indexOf`). That
   ~25× error would have justified adding a C-ABI symbol that earns nothing.

**Also closed:** the sweep found no other non-conformance. `toArrayBuffer`
appears once in `src/` (a comment explaining why it is avoided), the only
`bun:ffi` import outside the native layer is a type import, `read.*` has no
hot-path use (our pointer reads happen once at bind), and `rust.text.*` was
already FFI-first with `cstring` (zero encode).

**Follow-ups, deliberately not done:** `mimeFromExtension` still decodes for the
`cstring` ARG because no byte sibling exists (a symbol that would earn ~40 ns on
a non-hot path); `@types/bun` remains 1.3.14 (see §13 — the cache has no newer
version, so the casts stay).

---

## 12. Bun's own Rust hygiene (borrowed rules)

Bun's Rust codebase (`/home/adeel/poc/bun`, AGENTS.md) enforces conventions
that transfer directly to castrum's cdylib:

- **RAII / `Drop` over manual cleanup**; don't leak or free twice across the
  FFI boundary.
- **No mutable `#[no_mangle]` global state** without a synchronization
  wrapper. Bun wraps exported statics in `RacyCell` (see
  `src/jsc/FFI.rs`: `#[unsafe(no_mangle)] static ValueUndefined: RacyCell<…>`)
  so the symbol bytes stay identical while satisfying `Sync`. castrum's
  `thread_local!` caches and `OnceLock` state follow the same spirit.
- **`#[unsafe(no_mangle)]`** (Rust 2024) or `#[no_mangle]` (Rust 2021) on every
  export, `pub unsafe extern "C"`, snake_case names, `///` doc comments.
- Keep napi types OUT of internal signatures so core logic stays unit-testable
  in pure Rust (`#[cfg(test)] mod tests` in the same file).

---

## 13. Version anchors & verification

The behavioral claims above were distilled from the Rust-based Bun source
checkout at `/home/adeel/poc/bun` (LATEST file: 1.3.14; `package.json` tracks
the 1.4 development line) and are **re-verified against the installed Bun 1.4.2
runtime** that the code actually runs on (and that the CI matrix pins). The
decision matrix and ADR-0003 measured on the installed **Bun 1.4.0** runtime —
all anchors describe the same Rust-based runtime family. Castrum's own
measurements live in `bench/`.

**Known gap (2026-09-11): the type package lags the runtime.** `package.json`
pins `@types/bun@^1.3.14` / `bun-types@1.3.14` while the runtime is 1.4.2, and the
local package cache holds only 1.3.14 (so bumping it needs network access). The
visible consequence is that 1.4-era `bun:ffi` declarations are absent from the
types — `buffer_length` is not a valid `FFITypeOrString` literal there, so
`src/native/ffi.ts` casts it (`as unknown as readonly FFITypeOrString[]`). Any
new `bun:ffi` surface added in 1.4.x will need the same treatment until the
types are upgraded. The casts are load-bearing, not sloppiness: dropping them is
a type error, not a behavior change.

| Claim | Source (Bun checkout `/home/adeel/poc/bun`) |
|---|---|
| JIT-to-direct-native-call, 2–6× vs NAPI | `docs/runtime/ffi.mdx` → Performance; `bench/ffi/bun.js` (upstream) |
| `FFIType` numeric tags (`buffer`=20, `buffer_length`=21, `u64_fast`=16) | `src/js/bun/ffi.ts`; static asserts in `src/jsc/bindings/JSCFFIBridge.cpp` |
| `buffer`/`buffer_length` atomic snapshot, arg-only | `packages/bun-types/ffi.d.ts`; `src/runtime/ffi/ffi_body.rs::reject_cc_unsupported_types_error` |
| Pointers are `number`; BigInt converted to number | `docs/runtime/ffi.mdx` → Pointers |
| cstring returns cloned; NULL → null | `src/js/bun/ffi.ts` `FFIBuilder`; `test/js/bun/ffi/ffi.test.js` |
| dlopen leaks unless `close()`; unsound dlclose-on-GC | `src/runtime/ffi/ffi_body.rs` `FFI::finalize` |
| Low-overhead C-fn call (TinyCC path), zero bounds checking | `src/jsc/bindings/JSFFIFunction.h` |

**Verify after any FFI change**:

```bash
nm -D --defined-only <addon> | grep -c castrum_   # = 109
bun run bench:http:smoke                           # after touching decoders/handlers
bun test test/unit/native/ffi.test.ts            # FFI↔napi parity + self-test
bun test test/unit/native/ffi-symbol-parity.test.ts
```

---

## 14. Changing an existing symbol's ABI — the desync hazard (post-mortem 2026-08-23)

Adding or re-signing a `castrum_*` symbol means touching **Rust and the JS
dlopen map in lockstep**. `bun:ffi` performs ZERO runtime validation of the
declared ABI: if the addon on disk and `src/native/ffi.ts` disagree — arity,
arg order, or arg type — the call still crosses, the callee reads your scalar
as a pointer (or vice versa), and the process **segfaults**. This is not a
Bun bug; it is inherent to raw FFI, and it is why the bind-time self-test is
mandatory.

### The 2026-08-23 incident (recorded so nobody repeats it)

Converting `castrum_sse_encode_into`'s event/id to `cstring` args triggered
repeated SIGSEGVs that looked like an engine bug ("crash at address 0x5/0x6",
flaky across runs, "raw bindings pass but the package crashes"). After a full
root-cause pass, **every** crash traced to a development-loop desync — never
to bun:ffi itself:

1. **Half-updated trees**: rebuilding the Rust side while the JS map (or a
   scratch probe) still declared the old signature — e.g. after `git stash`
   / `git checkout` of one side. The callee then dereferenced a small integer
   argument as a pointer: crash addresses literally equalled values passed in
   earlier calls (`0x5`, `0x6`).
2. **Probe methodology bugs**: shell probes treated ANY non-zero exit as a
   crash — including clean `TypeError: Symbol "<key>" not found` failures
   from a misnamed dlopen-map key. Several "crashes" were exit-code-1
   TypeErrors.
3. **A mid-session runtime auto-update** (Bun canary replaced under us),
   invalidating comparisons across runs.

The minimal C-dylib control experiment bound every suspect signature shape
(`cstring` leading/middle/trailing, mixed with `buffer`/`buffer_length`,
`u64_fast` returns) against trivial exports: all marshaled correctly on Bun
1.4.0/1.4.1 canaries. **No engine bug exists to report.** (Re-run on the 1.4.2
binding: `ffiBufferMode() === 'buffer-pair'`, i.e. the `buffer`/`buffer_length`
pair is still live, and the full symbol set passes the bind-time self-test.)

### Rules for any ABI change (signature, arg order, or type)

1. **Treat Rust signature + JS dlopen-map entry + JS wrapper as ONE commit.**
   Never run anything that binds (`bun test`, benches, `import castrum`)
   between editing one side and the other.
2. **Rebuild before you bind**: after ANY `rust/ffi/**` edit (including
   reverting one via git), run `bun run build` before running tests. A stale
   `castrum.*.node` next to fresh JS is a guaranteed segfault, not an error.
3. **Fail loudly while debugging**: use `CASTRUM_FFI_MODE=ffi`. In `auto`
   mode a failed bind/self-test silently falls back to napi — which masks
   breakage as mysterious slowness or wrong-path results instead of an error.
4. **Know the failure signatures**:
   - `SIGSEGV at a tiny address (0x5–0xB)` right after a binding → almost
     always an ABI mismatch; check `git status rust/ src/native/ffi.ts` and
     rebuild before theorizing about the engine.
   - `Symbol "<name>" not found` at dlopen → key/name drift (parity test's
     domain).
   - ffi silently off → self-test returned false; run with
     `CASTRUM_FFI_MODE=ffi` to get the throw instead of the fallback.
5. **Known guard gap**: `test/unit/native/ffi-symbol-parity.test.ts` checks
   symbol NAMES (rust exports ⊆ dlopen map ⊆ self-test), NOT arities/types.
   Arity drift surfaces only at call time — as a crash. When changing a
   signature, update BOTH sides plus the self-test vectors in the same edit,
   and let `bun test test/unit/native/ffi.test.ts` (FFI↔napi parity) catch
   value divergence.
6. **Probe discipline when investigating**: distinguish crash from failure
   explicitly (exit code 139 + `Segmentation fault` line vs exit 1 +
   stderr), verify `bun --version` before AND after long sessions (canary
   auto-updates invalidate comparisons), and test hypotheses against a
   minimal dylib before blaming the engine.
7. **No repo-wide auto-fixers mid-investigation**: `bun run lint:fix`
   rewrites import order across ~90 files; in this codebase import ORDER
   carries side-effect semantics (eager-dlopen contract). Scope formatters
   to your changed files, and treat mass diffs appearing during a debug
   session as a variable to eliminate (revert them) before drawing
   conclusions.
