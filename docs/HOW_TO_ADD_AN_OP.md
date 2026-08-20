# HOW TO ADD AN OP (runbook)

This is the single runbook for adding a new native operation to `castrum` end
to end. It consolidates the six places a new op must be wired, so a contributor
(or AI agent) knows exactly what to touch and in what order. "Op" = a
performance-critical primitive (`crc32`, `hmacSha256`, `jsonValid`,
`gzipCompress`, `validateEmail`, …) exposed through the native addon.

The golden rule: **a new op must be reachable from the public `rust.*` surface,
bound on BOTH transports (bun:ffi primary + napi fallback), pinned by a
bind-time self-test, and listed in the op-selection metadata** — or the parity
guards fail.

---

## 0. The six wiring points at a glance

| # | File | What you add |
|---|------|--------------|
| 1 | `rust/<domain>/<module>.rs` (+ `mod.rs`) | The pure-Rust core (no napi types — unit-testable) |
| 2 | `rust/ffi/<domain>.rs` (+ `rust/ffi/util.rs`) | The `#[no_mangle] extern "C"` export (`panic_guard`, correct ABI) |
| 3 | `src/native/ffi.ts` + `src/native/ffi/types.ts` + `src/native/ffi/build/<domain>.ts` | The `bun:ffi` dlopen map entry + `BunFFI` method + per-domain self-test check |
| 4 | `src/rust-ffi/scalar/<area>.ts` (or `text`/`batch`/`packed`) | The public `rust.*` wrapper |
| 5 | `src/selection.json` + `src/shared/proven.ts` + `src/selection.ts` | The baked op-selection / delegation metadata |
| 6 | `test/unit/native/ffi.test.ts` + `test/unit/contract/wiring.test.ts` | The parity tests |

Follow the numbered sections below. When you're done, the parity gates
(§7) are your safety net.

---

## 1. Add a new Rust module (the core)

Create the pure-Rust core in its domain folder, e.g. `rust/crypto/hmac_sha256.rs`.
Keep **napi types out of the core** — internal signatures use `&[u8]` /
`&str` / `Result<_, String>` so it stays unit-testable with plain `cargo test`.

```rust
/// Compute an FNV-1a 64-bit hash of `input`.
#[inline]
pub fn fnv1a64_bytes(input: &[u8]) -> u64 { /* ... */ }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_vectors() { /* ... */ }
}
```

- Register the module in `rust/lib.rs` (the module map comment) and in the
  folder's `mod.rs` re-exports.
- Ship `#[cfg(test)] mod tests` in the SAME file (cross-module tests live in
  `rust/panic_safety.rs` / `rust/proptest_suite.rs`; shared helpers in
  `rust/test_support.rs`).
- If it needs a napi-visible class or batch, add a thin `api.rs` boundary in
  the module folder (name it `api`, **not** `napi` — that collides with the
  `napi` crate under `use super::*`).

## 2. Expose it over the C ABI (bun:ffi primary)

Add the `#[no_mangle] extern "C"` export in `rust/ffi/<domain>.rs`. Every
fallible / allocating export **must** route its core through `panic_guard`
(defined in `rust/ffi/util.rs`) so an uncaught panic can't unwind through
`extern "C"` and kill the process.

Rules (see `docs/FFI_BUN_GUIDE.md` for the full contract):
- Keep signatures **scalar + `(ptr,len)`** — no struct-by-value, no variadics.
- Null-check pointers and opaque handles (return `0` / `null` instead of
  dereferencing).
- Byte-count returns MUST use `u64_fast` (`U64_FAST` in ffi.ts); opaque handles
  pass as `usize`/number.
- String ARGS come in as `*const c_char` (bun:ffi `cstring`); use
  `CStr::from_ptr(header).to_bytes()`.
- String RETURNS use `cstring_return` (per-thread `CSTR_BUF`, cloned at call
  time — never return a pointer into JS-owned memory).
- **Variable-size outputs**: return the EXACT required byte count on a
  too-small buffer (0 = real error) so JS allocates once and retries at most
  once.

```rust
/// FNV-1a 64-bit hash → u64.
#[no_mangle]
pub unsafe extern "C" fn castrum_fnv1a64(data: *const u8, len: usize) -> u64 {
    if data.is_null() { return 0; }
    panic_guard(
        || crate::crypto::hashing::fnv1a64_bytes(std::slice::from_raw_parts(data, len)),
        0,
    )
}
```

- A `#[no_mangle]` symbol emits regardless of module path — no re-export needed
  for the C ABI itself (re-exports are only needed for unit tests to reach the
  item).

## 3. Bind it on the bun:ffi path (transport core + build folder)

`src/native/ffi.ts` owns the `dlopen` symbol map (`bind()`). Add your symbol
key (the EXACT `castrum_*` name) to that map with its ABI spec.

Then add the ergonomic method where it belongs in the decomposed bind surface:
- `src/native/ffi/build/codecs.ts` — hashing / codec / crypto / auth
- `src/native/ffi/build/compress.ts` — gzip/brotli + jsonPatch
- `src/native/ffi/build/parse.ts` — packed parsers + media-type/http-date/accept
- `src/native/ffi/build/instances.ts` — opaque-handle evals (schema/jwt/template/route/ingress)

Add the method signature to the `BunFFI` interface in
`src/native/ffi/types.ts` (use a `Raw2..Raw12` / `RawCStr` signature for the
raw symbol, or add a new one if the arity doesn't fit).

**Add the self-test next to the binding**: each `build/*.ts` file exports a
`selfTest<Domain>` function; add a known-good vector check for your method
there. `src/native/ffi/selftest.ts` is a thin aggregator that ANDs all four
domain self-tests — a new symbol is bound **and** self-tested in one file.

## 4. Expose it on the public `rust.*` surface

`src/rust-ffi/scalar/<area>.ts` (or `text.ts` / `batch/` / `packed.ts`) builds
the public wrapper. The wrapper normalizes the string-vs-bytes return
divergence (`toBytes`/`toText` — `src/shared/bytes.ts`), adds the pooled
`*Into` variants where hot, and (optionally) delegates to Bun built-ins when
`isBun()` via `src/runtime/builtins.ts` (`BUILTIN_OPS`).

Add a JSDoc block (`@param`/`@returns`/`@example`) — `bun run check:jsdoc`
enforces a 95% floor on exported symbols.

## 5. Op-selection metadata (baked)

- `src/selection.json` — the machine-readable selection row for the op
  (native/js/bun winner). Generated by `scripts/select-native.ts --write`.
- **GOTCHA**: `select-native.ts`'s `OPS` array is the source of truth for what
  stays in `selection.json`. ANY op with a baked native/js decision MUST be
  listed there (or as a `skip+pinned` entry) or `--write` DELETES it from the
  selection. If you add an op to `rust/selection.rs`, add it to `OPS` too.
- `src/shared/proven.ts` — `PROVEN_SELECTION` (PURE DATA) maps each op to its
  proven winner (`native` / `js` / `bun`). Add/update the entry.
- `src/selection.ts` — `BUN_WINS` delegation registry (which ops delegate to
  Bun built-ins under Bun). Keep `src/runtime/builtins.ts` `BUILTIN_OPS` in
  sync.

## 6. Parity tests

- `test/unit/native/ffi.test.ts` — pin the ffi-vs-napi byte-parity for the new
  op (the transport self-test only guards bind-time vectors; this pins real
  parity against a live napi instance).
- `test/unit/contract/wiring.test.ts` — verifies each baked `PROVEN_SELECTION`
  winner is actually wired (`opImpl(op)` agrees, `builtins.has(op)` matches,
  native/js entries match the addon's embedded `selection.json`).
- `test/unit/native/ffi-symbol-parity.test.ts` — scans `rust/ffi/` for every
  `castrum_*` symbol and asserts it's bound in the ffi.ts map AND exercised by
  the self-test. New symbol not bound → this fails.

## 7. Run the gates

```sh
cargo test                                  # Rust cores + C-ABI tests
bun test                                    # TS suite (incl. the parity tests)
bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.test.json
bun run lint                                # Biome
bun run check:jsdoc                         # ≥95% JSDoc on exported symbols
bun run check:clean                         # module headers, runtime seam, purity, doc links
bun run check:version                       # package.json ↔ Cargo.toml ↔ CHANGELOG
bun run bench:http:smoke                    # if you touched the ingress path
bun run bench:startup                       # if you touched the transport/loader
```

---

## Checklist

- [ ] Pure-Rust core in the right domain folder with `#[cfg(test)] mod tests`
- [ ] `#[no_mangle] extern "C"` export with `panic_guard` + null checks +
      correct `u64_fast`/cstring ABI
- [ ] Symbol in the `ffi.ts` dlopen map + `BunFFI` interface method
- [ ] Per-domain `selfTest*` vector in the same `ffi/build/*.ts` file
- [ ] Public `rust.*` wrapper with JSDoc (+ `*Into` pooled variant if hot)
- [ ] `selection.json` + `PROVEN_SELECTION` + `BUILTIN_OPS` (if delegating)
- [ ] `ffi.test.ts` + `wiring.test.ts` parity coverage
- [ ] All §7 gates green
