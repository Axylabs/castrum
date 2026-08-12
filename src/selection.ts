// src/selection.ts — native-vs-JS selection surface (OWNED BY CASTRUM).
//
// The decision of whether an operation should use the Rust addon ("native")
// or a pure-JS implementation ("js") is a property of this library, not of
// any consumer. The single source of truth is `rust/selection.rs`
// (benchmark-driven, audited by `scripts/select-native.ts --check`); this
// module is its TS projection and the API consumers call ONCE at load time.
//
// Consumers bind each operation to a fixed implementation at startup by
// reading `opImpl(op)` here — they do NOT swap native↔js per call.

import { lazyAddon, getAddon } from "./native";
import { isBun } from "./shared/runtime";

/** Recommended implementation for an operation. */
export type OpImpl = "native" | "js";

export interface OpDecision {
  /** The recommended implementation when the addon is available. */
  readonly impl: OpImpl;
  /** Why this decision (measured ratio / rationale). */
  readonly note?: string;
}

/**
 * Ops where Bun's NATIVE built-in beats the Rust addon (measured in
 * `docs/bun-builtins-decision-matrix.md`: `Bun.gzipSync` ~2.0x, `Bun.hash.crc32`
 * 2.8–8.4x, `Bun.CryptoHasher` ~1.2x, `Bun.hash.xxHash3` ~4.2x, and
 * `crypto.getRandomValues` for token-sized random). Under Bun the fastest
 * choice for these is the pure-JS path that DELEGATES to the Bun built-in
 * (`"js"`), not the Rust addon — so we never ship something slower than what
 * Bun natively provides. Under Node the base benchmark decision stands (Rust
 * wins for gzip/random/hmac there).
 */
const BUN_WINS = new Set([
  "gzipCompress",
  "gzipDecompress",
  "crc32",
  "randomToken",
  "hmacSha256",
  "xxh3",
  "urlEncode",
  "urlDecode",
  "base64Encode",
]);

// Lazy: importing this module does NOT dlopen the addon; `opImpl` reads the
// baked decision from Rust on first call.
const addon = lazyAddon(getAddon);

/**
 * The benchmark-driven native-vs-JS decision for `op` — runtime-aware.
 *
 * Returns `"native"` when the Rust addon is the recommended implementation,
 * `"js"` when a pure-JS (or Bun built-in) implementation wins, or `null` for
 * unknown ops (or when the addon is unavailable — with no addon there is no
 * "native" choice). Under Bun, ops in {@link BUN_WINS} resolve to `"js"` so the
 * consumer's JS path delegates to the faster Bun built-in.
 */
export const opImpl = (op: string): OpImpl | null => {
  if (isBun() && BUN_WINS.has(op)) return "js";
  return addon.opImpl(op);
};

/** `true` when the Rust addon is the recommended impl for `op`. */
export const isNativeOp = (op: string): boolean => opImpl(op) === "native";

/** The decision record for `op`, or `null` when unknown. */
export const opDecision = (op: string): OpDecision | null => {
  const impl = opImpl(op);
  if (impl === null) return null;
  return { impl };
};
