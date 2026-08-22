# RULES.md — castrum

Non-negotiable rules for writing code in this repo. Read before editing.
These are enforced by convention and CI (`bun run check:clean`,
`check:jsdoc`, `check:version`, coverage floors). `AGENTS.md` is the
how-to guide; `.agents/skills/` holds task-specific runbooks;
`docs/ai/LOCAL_DEV.md` covers cross-repo local development.

## 1. Bun first — Rust core first

- castrum is a **Bun-first** package: `bun:ffi` is the PRIMARY native
  transport, `Bun.serve`/`Bun.file`/`Bun.CryptoHasher`/`Bun.gzipSync` are
  used directly. Node compatibility (napi fallback + `dist/`) is secondary:
  it must never slow down or complicate the Bun path.
- Engine floors: `bun >=1.1.0`, `node >=20.3` (see `package.json`). The
  benchmark/reference runtime is the Rust-based Bun 1.4+ — "bun first" and
  "rust core first" are the same bias
  ([bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4),
  `docs/FFI_BUN_GUIDE.md`).
- **Performance comes from the Rust core** (`rust/`, the
  `castrum.<platform>-<arch>.node` cdylib). Before writing a hot loop in TS,
  check whether the op exists in Rust or as a Bun built-in
  (`src/runtime/builtins.ts`, `src/shared/proven.ts`). Measure before and
  after (`bench/`), never assume.

## 2. The Rust core is the source of performance

- Hot paths live in `rust/` (`crypto/`, `http/`, `ingress/`, `json/`,
  `payload/`, `util/`). Keep the Rust core **pure and unit-testable**:
  internal signatures use `&[u8]` / `&str` / `Result<_, String>` — no
  napi/ffi types inside the core, only at the `extern "C"` boundary
  (`rust/ffi/`).
- Every `extern "C"` export: `panic_guard`, null-check every pointer,
  needed-size convention (`0` = error, `w > out_cap` = exact size required),
  `thread_local` scratch only (no global `static mut`).
- New exports are pinned by a bind-time self-test (`src/native/ffi/selftest.ts`)
  and parity tests — or the transport gates fail.

## 3. FFI to Rust: no-encode/no-decode — `cstring` and byte slices

- **Never hand-encode/decode across the boundary.** No JS-side
  `TextEncoder`/`TextDecoder` round trips, no `Buffer.from` copies, no
  `JSON.stringify`/`parse` on hot paths. The engine does the transcoding:
  - **NUL-terminated string inputs**: the `cstring` FFI arg type — Bun
    transcodes the JS string into a call-scoped NUL-terminated UTF-8 buffer
    (zero JS-side encode); Rust reads it with `CStr::from_ptr` and
    `.to_bytes()`. Never dereference past the NUL.
  - **Arbitrary byte inputs**: `(ptr, len)` pairs or the
    `buffer`/`buffer_length` ABI pair — a TypedArray becomes a pointer
    engine-side (zero-copy); Rust reads `slice::from_raw_parts`. Use this
    when the callee does not need NUL-termination (the current convention
    for instance ops — see `rust/ffi/http.rs`).
  - **Returning strings**: return a `cstring` (engine clones to a JS string)
    or a `(ptr, len)` into scratch with the needed-size convention.
- The ABI types in the `dlopen` map (`src/native/ffi.ts`) MUST match the Rust
  signature exactly — a mismatch is a crash, not an error. The bind-time
  self-test is the net.
- Canonical reference: `docs/FFI_BUN_GUIDE.md`; new ops follow
  `docs/HOW_TO_ADD_AN_OP.md`.

## 4. Functional composition — pure functions, no classes

- Public API = **functional composition over an explicit state object**:
  factories returning plain objects with closures (`createRust()`,
  `createLoader()`, `createIngressServer()`, `createPipeline()`). No classes,
  no `this`, for public surfaces.
- Prefer **pure functions** (same input → same output, no hidden state) so
  they are directly unit-testable without mocks. Isolate side effects
  (dlopen, sockets, timers, env) in dedicated seams (`src/native/`,
  `src/runtime/`, `src/shared/env.ts`).
- **Small functions in small files**: one responsibility per file, small pure
  functions grouped into folders by concern (`src/rust-ffi/scalar/`,
  `src/ingress/headers/`, `src/shared/packed.ts`, …). Never build god-files.
  Follow the existing decomposition (`src/native/ffi/` split into
  `types|constants|selftest|build/*`).

## 5. Structure & maintainability

- New code ships in small, focused files under the right folder — consult
  `docs/REPO_MAP.md` before adding a file.
- Don't reinvent: check the Rust core, `src/shared/`, and the Bun built-ins
  (`src/runtime/builtins.ts`) before writing a new implementation; check the
  IgnEX core repos one directory back (`/home/adeel/poc/`, e.g. `@ignex/native`
  in `ignus/packages/native`) before adding ecosystem surface.
- Selection metadata (`src/selection.json`, `src/shared/proven.ts`,
  `src/selection.ts`) must stay consistent with the shipped op surface
  (`bun run check:selection`).

## 6. Tests ship with code

- TS: `bun test` — tests under `test/unit/<area>/`; new logic ships with
  parity/contract coverage (`test/unit/contract/`).
- Rust: `cargo test` — a `#[cfg(test)] mod tests` block lives in the SAME
  module file; cross-module suites in `rust/panic_safety.rs` and
  `rust/proptest_suite.rs`.
- HTTP: after touching servers or `handlers.ts`, run
  `bun run bench:http:smoke` and confirm no shape failures.

## 7. Docs discipline (anti-hallucination)

- Docs must match code. Never document behavior you did not verify in the
  source; if a doc and the code disagree, fix the doc.
- When you add/rename/move files or exports, update `AGENTS.md`, `RULES.md`,
  the relevant `.agents/skills/`, `docs/REPO_MAP.md`, and regenerate the
  scaffolding map (`bun run gen:ai-map`).
- Keep `CHANGELOG.md` current; keep `check:version` green
  (package.json ↔ Cargo.toml ↔ CHANGELOG).

## 8. Local development with core projects (maintainers & AI only)

- Core IgnEX packages live one directory back in `/home/adeel/poc/`. When a
  change spans repos, use `bun link` against the local source instead of the
  registry — see `docs/ai/LOCAL_DEV.md` (`castrum` is linked into
  `@ignex/native` in the ignus monorepo). Rebuild the addon before linking
  (`bun run build`). Never publish from a linked tree; CI/releases resolve
  from the registry.
