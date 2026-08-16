# Bun Built-ins vs castrum — Decision Matrix

> **Question this answers**: for the same workload, does a Bun native built-in
> beat the castrum Rust op? Where it does, castrum should stop reinventing the
> wheel and delegate to Bun; where castrum wins (or Bun
> has no sync equivalent), the Rust op stands.

## Methodology

- **Runtime**: Bun **1.4.0** (the primary target).
- **Addon**: castrum **release** build (`bun run build`, baseline CPU — the
  shipped profile).
- **Driver**: `bun run check` (CPU benchmark → `bench/results/cpu/latest.json`).
  Each pair runs on the SAME input (fixture payloads, see table).
- **Naming**: diagnostic comparisons use `diag:` task names so they are kept out
  of the shipped-op `native:`/`rust:` comparisons (see `src/bench/comparisons.ts`).
- **Honesty guard**: every Bun API is verified to actually execute real work at
  runtime before a result is trusted. This is important — the first run
  produced false "wins" (brotli 156×, validators 3–5×) because this Bun
  version has **no** `Bun.brotliCompressSync` and **no** `Bun.validators`, and
  the feature-detect fell through to an empty return. Those pairs were removed,
  not reported.
- Ratio is **nativeAvgMs / rustAvgMs** (>1 = Bun faster; <1 = rust faster).

## Results (Bun 1.4.0, release addon, 2026-08-11)

| castrum op | Bun built-in | Input | Winner | Ratio |
|---|---|---|---|---|
| `rust.fnv1a64` | `Bun.hash` (wyhash) | 42 B | Bun (parity) | 1.06× |
| `rust.crc32` | `Bun.hash.crc32` | 42 B | **Bun** | 2.8–8.4× |
| `rust.xxh3` (new) | `Bun.hash.xxHash3` | 42 B | **Bun** | 4.15× |
| `rust.hmacSha256` | `Bun.CryptoHasher("sha256", key)` | 32 B | Bun (mild) | 1.1–1.4× |
| `rust.passwordHash` (argon2id) | `Bun.password.hashSync` (argon2id) | 12 B | **rust** | 0.55× (rust 1.83×) |
| `rust.passwordVerify` | `Bun.password.verifySync` | 12 B | **rust** | 0.53× (rust 1.88×) |
| `rust.passwordHashBcrypt` (new) | `Bun.password.hashSync` (bcrypt) | 12 B | Bun (mild) | 1.24× |
| `rust.passwordVerifyBcrypt` (new) | `Bun.password.verifySync` (bcrypt) | 12 B | **rust** | 0.67× (rust 1.49×) |
| `rust.pbkdf2Sha256` (new) | `node:crypto.pbkdf2Sync` | 12 B | rust (parity) | 0.93× (rust 1.08×) |
| `rust.randomToken` (16 B) | `Bun.randomUUIDv7` | — | **Bun** | 1.62× |
| `rust.gzipCompress` | `Bun.gzipSync` | 11 179 B | **Bun** | 2.02× |
| `rust.gzipDecompress` | `Bun.gunzipSync` | 1 045 B | **Bun** | 1.38× |
| `rust.brotliCompress` | *no sync Bun API* | — | N/A | — |
| `rust.brotliDecompress` | *no sync Bun API* | — | N/A | — |
| `rust.validateEmail/Uuid/Ipv4/Ipv6` | `Bun.validators` (*absent in 1.4*) | — | N/A | — |

> Same-cost note: `Bun.password.hashSync` ran at `memoryCost 4096 / timeCost 1`
> (4 MiB, 1 iter) matching the rust bench cost (`mCost 4096 / tCost 1`) — the
> rust argon2id win is cost-for-cost, not a cost cheat.

> Transport note: "FFI-crossing Rust op" below means any Rust call over the
> native bridge. Under Bun that bridge is now `bun:ffi` (the PRIMARY transport);
> under Node it is the napi fallback. This Bun-builtin-vs-Rust axis is
> independent of the ffi-vs-napi transport axis — these decisions recommend
> WHICH implementation to call (`rust.*` vs a Bun built-in), not which transport
> carries the call.

## Decisions

### → Delegate to Bun at the selection layer (Bun wins)
These rust ops lose to Bun's native implementation on the SAME workload — the
FFI crossing cannot beat Bun's in-process C++:

This table mirrors `BUILTIN_OPS` in `src/runtime/builtins.ts` (the 11 ops that
delegate to Bun built-ins under Bun; `src/selection.ts` derives from it). `fnv1a64` is parity/either but is NOT delegated
(`Bun.hash` is wyhash — a different algorithm — and rust `fnv1a64` stays the
benchmarked impl).

| Op | Recommendation |
|---|---|
| `crc32` | Prefer `Bun.hash.crc32`; keep rust as fallback (pure-TS path already exists). |
| `xxh3` | Prefer `Bun.hash.xxHash3` (~4×); keep the rust export as the Node/non-Bun fast path. The runtime adapter delegates the public `rust.xxh3` to Bun under Bun. |
| `gzipCompress` | Prefer `Bun.gzipSync` (~2×). **`gzipDecompress` is deliberately NOT delegated** — `Bun.gunzipSync` has no decompression-bomb cap; the rust surface keeps its native 64 MiB-capped path under Bun. |
| `randomToken` | Prefer `Bun.randomUUIDv7()` (or `crypto.getRandomValues`) for token-sized output; keep rust for byte-precise control. |
| `hmacSha256` | Prefer `Bun.CryptoHasher("sha256", key)` (1.17× — mild; keep rust batch path, which wins on larger inputs). |
| `urlEncode` / `urlDecode` | Prefer `encodeURIComponent` / `decodeURIComponent` (JSC string builtins — ~11.5×, zero alloc). |
| `base64Encode` / `base64UrlEncode` | Prefer `Buffer.toString('base64'|'base64url')`. |
| `hexEncode` | Prefer `Buffer.toString('hex')`. |
| `httpDate` | Prefer `Date.toUTCString()`. |

**Delegation rule of thumb**: rust stays the default only where it beats its
**Bun** baseline (not just its JS baseline). These are the ops where rust
genuinely wins or Bun has no equivalent.

### → Keep rust (rust wins or Bun has no equivalent)
| Op | Rationale |
|---|---|
| `passwordHash` / `passwordVerify` (argon2id) | rust 1.83–1.88× faster than `Bun.password` at equal cost. **Do not delegate.** |
| `passwordHashBcrypt` / `passwordVerifyBcrypt` (new) | Hash ≈ parity (Bun 1.24×), verify rust 1.49×. Keep rust — self-contained and works under Node. |
| `pbkdf2Sha256` (new) | Bun has no sync PBKDF2; rust ≈ parity with node:crypto (1.08×). Keep rust. |
| `brotliCompress` / `brotliDecompress` | Bun 1.4 has no synchronous brotli; keep rust (async `CompressionStream` is not drop-in). |
| `validateEmail` / `validateUuid` / `validateIpv4` / `validateIpv6` | `Bun.validators` absent in 1.4; keep rust. Re-check when Bun adds it. |
| `jsonValid` / `jsonSumIds` / packed parsers / ingress | No Bun sync equivalent for the zero-DOM / zero-copy semantics; keep rust. |

### → Implemented primitives (gaps closed)
| Primitive | Outcome |
|---|---|
| `rust.xxh3` (XXH3-64) | Exposed; measured `Bun.hash.xxHash3` 4.15× faster → the runtime adapter delegates the public `rust.xxh3` to Bun under Bun (Node keeps the addon). |
| `rust.passwordHashBcrypt` / `rust.passwordVerifyBcrypt` | bcrypt `$2b$` PHC; hash parity, verify rust 1.49×. |
| `rust.pbkdf2Sha256` | PBKDF2-HMAC-SHA256; parity with `node:crypto`, the only sync option in Bun. |
| UUIDv7 (`uuidv7()`) | `Bun.randomUUIDv7` already wins — delegated to Bun (`crypto.randomUUID` on Node), not built in Rust. |

## Summary

**The "don't reinvent the wheel" takeaway:** for non-cryptographic hashing,
random tokens, and gzip, Bun 1.4's built-ins are already faster than any
FFI-crossing Rust op — the selection layer should prefer them. Rust retains a clear,
defensible moat exactly where it matters: **argon2id password hashing
(≈1.9× vs Bun)**, the **zero-DOM / zero-copy parsers and JSON paths** (no Bun
sync equivalent), and **brotli** (no Bun sync API).

## Re-run

```sh
bun run build   # release addon
bun run check   # writes latest.json; grep the "vs Bun" lines
```
