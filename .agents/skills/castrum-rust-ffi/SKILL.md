---
name: castrum-rust-ffi
description: Add or modify a native (Rust) operation in castrum — the 6 wiring points across the pure-Rust core, the extern "C" export, the bun:ffi dlopen map, the public rust.* wrapper, selection metadata, and parity tests. Use when touching rust/ffi/, src/native/ffi.ts, or src/rust-ffi/.
---

# castrum: Rust FFI ops (bun:ffi primary + napi fallback)

The golden rule: **a new op must be reachable from the public `rust.*`
surface, bound on BOTH transports (bun:ffi primary + napi fallback), pinned by
a bind-time self-test, and listed in the op-selection metadata** — or the
parity guards fail. The full runbook is `docs/HOW_TO_ADD_AN_OP.md`; the
canonical ABI reference is `docs/FFI_BUN_GUIDE.md`. This skill is the
condensed version.

## The 6 wiring points

| # | File | What you add |
|---|------|--------------|
| 1 | `rust/<domain>/<module>.rs` (+ `mod.rs`) | Pure-Rust core — `&[u8]` / `&str` / `Result<_, String>` signatures only, unit-testable with plain `cargo test` (no napi types) |
| 2 | `rust/ffi/<domain>.rs` (+ `rust/ffi/util.rs`) | The `#[no_mangle] extern "C"` export with `panic_guard`, null-checks, needed-size convention |
| 3 | `src/native/ffi.ts` + `src/native/ffi/types.ts` + `src/native/ffi/build/<domain>.ts` | The `bun:ffi` dlopen-map entry + `BunFFI` method + per-domain bind-time self-test |
| 4 | `src/rust-ffi/scalar/<area>.ts` (or `text`/`batch`/`packed`) | The public `rust.*` wrapper |
| 5 | `src/selection.json` + `src/shared/proven.ts` + `src/runtime/builtins.ts` | Baked op-selection / delegation metadata |
| 6 | `test/unit/native/ffi.test.ts` + `test/unit/contract/wiring.test.ts` + `test/unit/native/ffi-symbol-parity.test.ts` | Parity tests (rust exports ⊆ dlopen map ⊆ self-test coverage) |

## ABI contract (the non-negotiables)

- **Scalar + `(ptr, len)` only.** No by-value structs, no variadics. Every
  argument is a register-passable integer, float, or pointer.
- **Strings into Rust → `cstring` args**: the JS side passes a string, Bun
  transcodes it to a call-scoped NUL-terminated UTF-8 buffer (**zero JS-side
  `TextEncoder`/`TextDecoder`**); Rust reads `CStr::from_ptr(x).to_bytes()`.
  Never dereference past the NUL. Returns use `cstring_return`/`CSTR_BUF`
  (per-thread buffer, null = error).
- **Bytes → `(ptr, len)`** or the `buffer`/`buffer_length` ABI pair (the
  engine converts a TypedArray to its pointer — zero-copy). Rust reads
  `slice::from_raw_parts` and must null-check + respect the length.
- **Byte-count returns → `u64_fast`** (`'u64_fast'` in the dlopen map) — plain
  `number` below 2^53, no BigInt boxing.
- **Opaque state → `usize` handle** (schema/jwt/template/route/ingress
  instances); null handle (0) → safe no-op, never dereference freed state.
- **Needed-size convention**: `0` = real error; `w > out_cap` = the exact size
  required (JS allocates once and retries at most once — `growExact`). Never
  return 0 on a valid call.
- **`panic_guard` every fallible export** (`catch_unwind` → fallback). A panic
  unwinding through `extern "C"` kills the whole Bun process. `thread_local`
  scratch only — no global `static mut`.
- The ABI types in the dlopen map MUST match the Rust signature exactly — a
  mismatch is a crash, not an error. The bind-time self-test is the net.

## The dlopen-map mechanics (`src/native/ffi.ts`)

- `bind()` resolves `CASTRUM_FFI_MODE` (`auto`/`ffi`/`napi`), dlopens the SAME
  `.node` the napi fallback uses, probes whether this Bun accepts the
  `buffer`/`buffer_length` pair, then builds the map — `abi()` rewrites every
  `ptr`→`buffer` + paired `usize`→`buffer_length` in `'buffer-pair'` mode, or
  keeps explicit `(ptr, usize)` in `'ptr-len'` mode.
- Bind-time self-test (`ffi/selftest.ts` + per-domain `selfTest*` in
  `ffi/build/*.ts`) gates the whole transport: failure → napi fallback
  (`auto`) or throw (`ffi`).

## Modifying an EXISTING symbol's ABI (vs adding one)

A signature/arity/type change is ATOMIC across `rust/ffi/**` + the
`src/native/ffi.ts` dlopen map + the JS wrapper + self-test vectors, and
`bun run build` must run before anything binds — a stale `.node` segfaults
the process (no runtime ABI validation; the parity test checks names only).
Full post-mortem + failure signatures: `docs/FFI_BUN_GUIDE.md` §14.
Debug with `CASTRUM_FFI_MODE=ffi` so bind failures throw instead of silently
falling back to napi.

## Gates to run before done

```bash
cargo test && bun test
bun run typecheck && bun run typecheck:test
bun run lint:ci
bun run check:jsdoc      # ≥95% JSDoc on exported symbols
bun run check:clean      # FFI doc count stays 85 castrum_* / 77 direct
bun run check:selection  # selection.json ↔ code consistency
bun run bench:startup    # after touching the loader
```

## Verify (parity)

- `test/unit/native/ffi-symbol-parity.test.ts` enforces rust exports ⊆ ffi.ts
  map ⊆ self-test coverage.
- `test/unit/contract/proven.test.ts` verifies every `PROVEN_SELECTION` winner
  is wired (opImpl / builtins / selection.json).
