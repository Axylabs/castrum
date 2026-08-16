// src/rust-ffi/proven.ts — the baked "proven selection" surface.
//
// `proven` re-exposes the FULL `rust.*` surface (identical object) alongside
// the pure-data registry (`src/shared/proven.ts`) that states which
// implementation is the benchmark-proven winner for every op: 'native',
// 'js', or 'bun' (Bun built-in delegation). The winners are BAKED (committed,
// benchmark-derived) and verified by `test/unit/shared/proven.test.ts` — no
// live benchmark audit and no `@deprecated` JSDoc machinery (the old
// `check:proven` / `check:annotate` friction, intentionally not re-added).

import { rust, type RustClient } from './client'

/** The full `rust.*` surface — identical to `rust`; the proven wiring is baked (see {@link ../shared/proven}). */
export type ProvenClient = RustClient

/** The full `rust.*` surface, exposed for audit. Same object as `rust`. */
export const proven: ProvenClient = rust

export {
  PROVEN_SELECTION,
  isProven,
  provenEntry,
  provenImpl,
  provenStatus,
  provenSummary,
  provenSurface,
} from '../shared/proven'
export type { ProvenEntry, ProvenImpl, ProvenStatus } from '../shared/proven'
