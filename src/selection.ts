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
//
// The baked default comes from the PROVEN SELECTION registry
// (`src/shared/proven.ts`, `PROVEN_SELECTION`): for each op the
// benchmark-proven winner is 'native' | 'js' | 'bun' (Bun built-in
// delegation). Bun built-in delegation is runtime-aware via the adapter's
// `builtins` registry (`runtimeNative.builtins.has(op)` — empty under Node).
// `test/unit/shared/proven.test.ts` verifies this baked registry matches the
// live wiring, so it can't drift.

import { getAddon, lazyAddon } from './native'
import { provenImpl } from './shared/proven'
import { runtimeNative } from './runtime/native'

/** Recommended implementation for an operation. */
export type OpImpl = 'native' | 'js'

/** A selection decision: recommended implementation + rationale note. */
export interface OpDecision {
  /** The recommended implementation when the addon is available. */
  readonly impl: OpImpl
  /** Why this decision (measured ratio / rationale). */
  readonly note?: string
}

// Lazy: importing this module does NOT dlopen the addon; `opImpl` reads the
// baked decision from Rust on first call.
const addon = lazyAddon(getAddon)

/**
 * The benchmark-driven native-vs-JS decision for `op` — runtime-aware.
 *
 * Returns `"native"` when the Rust addon is the recommended implementation,
 * `"js"` when a pure-JS (or Bun built-in) implementation wins, or `null` for
 * unknown ops (or when the addon is unavailable — with no addon there is no
 * "native" choice). Under Bun, ops in the adapter's builtins registry resolve
 * to `"js"` so the consumer's JS path delegates to the faster Bun built-in.
 *
 * The default is the BAKED proven selection (`src/shared/proven.ts`):
 * `native` / `js` directly, `bun` resolves to `"js"` via the builtins check
 * above. Unknown ops (and `bun` entries on a non-Bun runtime, where no
 * built-in exists) fall back to the addon's embedded decision
 * (`rust/selection.rs` ← `src/selection.json`).
 */
export const opImpl = (op: string): OpImpl | null => {
  // Bun built-in delegation (runtime-aware — the registry is empty under Node).
  if (runtimeNative.builtins.has(op)) return 'js'
  // Baked proven winners are the default selection.
  const proven = provenImpl(op)
  if (proven === 'native') return 'native'
  if (proven === 'js') return 'js'
  // 'bun' on a non-Bun runtime (no built-in) or unknown ops → addon decision.
  return addon.opImpl(op)
}

/** `true` when the Rust addon is the recommended impl for `op`. */
export const isNativeOp = (op: string): boolean => opImpl(op) === 'native'

/** The decision record for `op`, or `null` when unknown. */
export const opDecision = (op: string): OpDecision | null => {
  const impl = opImpl(op)
  if (impl === null) return null
  return { impl }
}
