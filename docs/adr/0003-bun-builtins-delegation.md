# ADR-0003: Don't reinvent the wheel — benchmark, then delegate to Bun built-ins

- **Status**: Accepted (2026-08-11)
- **Deciders**: maintainers (measured on Bun 1.4.0 / release addon)

## Context

castrum ships Rust ops that overlap with Bun's native built-ins
(`Bun.hash`, `Bun.password`, `Bun.CryptoHasher`, `Bun.gzipSync`,
`Bun.randomUUIDv7`, `crypto.subtle`, `JSON.parse`, `URLSearchParams`). For the
same workload, the in-process Bun implementation can beat an FFI-crossing Rust
op — spending effort building or keeping such ops is reinventing the wheel.

## Decision

Every overlapping op is **benchmarked against its Bun built-in** before it is
built, kept, or delegated. Results live in
`docs/bun-builtins-decision-matrix.md`. Rules:

1. **Delegate to Bun** at the `@flux/native` wrapper layer where Bun wins
   clearly: non-crypto hashing (`Bun.hash.crc32` ~3x, `xxHash3` ~4x),
   gzip (`Bun.gzipSync`/`gunzipSync`), `Bun.randomUUIDv7` (~2x), HMAC
   (`Bun.CryptoHasher` ~1.2x).
2. **Keep rust** where it wins or Bun has no synchronous equivalent:
   argon2id password hashing (~1.8–2x vs `Bun.password`), bcrypt verify
   (~1.5x), brotli, PBKDF2, zero-DOM JSON/parsers.
3. **Don't build** what Bun already wins at (UUIDv7 → `uuidv7()` delegates to
   `Bun.randomUUIDv7`, falls back to `crypto.randomUUID`).

## Consequences

- New `rust.*` primitives ship with a Bun-built-in baseline + decision-matrix
  entry (`xxh3`, `passwordHashBcrypt`/`verifyBcrypt`, `pbkdf2Sha256`).
- `PROVEN_SURFACE` classifications reflect the Bun/JS baseline honestly
  (e.g. `xxh3` is `not-competitive` vs `Bun.hash.xxHash3`).
- Diagnostic benchmark tasks use `diag:` names so they never perturb the
  `check:proven` audit.

## See also

- docs/bun-builtins-decision-matrix.md
- src/bench/tasks/bun-builtins.ts
