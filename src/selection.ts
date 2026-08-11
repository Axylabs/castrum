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

/** Recommended implementation for an operation. */
export type OpImpl = "native" | "js";

export interface OpDecision {
  /** The recommended implementation when the addon is available. */
  readonly impl: OpImpl;
  /** Why this decision (measured ratio / rationale). */
  readonly note?: string;
}

// Lazy: importing this module does NOT dlopen the addon; `opImpl` reads the
// baked decision from Rust on first call.
const addon = lazyAddon(getAddon);

/**
 * The benchmark-driven native-vs-JS decision for `op`.
 *
 * Returns `"native"` when the Rust addon is the recommended implementation,
 * `"js"` when a pure-JS implementation wins, or `null` for unknown ops (or
 * when the addon is unavailable — with no addon there is no "native" choice).
 */
export const opImpl = (op: string): OpImpl | null => addon.opImpl(op);

/** `true` when the Rust addon is the recommended impl for `op`. */
export const isNativeOp = (op: string): boolean => addon.opImpl(op) === "native";

/** The decision record for `op`, or `null` when unknown. */
export const opDecision = (op: string): OpDecision | null => {
  const impl = addon.opImpl(op);
  if (impl === null) return null;
  return { impl };
};
