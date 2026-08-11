// src/rust-ffi/proven.ts — The performance-annotated export surface.
//
// `proven` exposes the FULL `rust.*` surface. Each exported function's JSDoc
// carries its measured performance vs the native JS baseline, annotated from
// the CPU benchmark report by `scripts/annotate-performance.ts` (run via
// `bun run check:annotate`). Functions that are SLOWER than the JS baseline
// (e.g. `jsonParse` vs Bun's JSON.parse, or schema validation vs ajv) are
// marked `@deprecated`.
//
// The registry (`src/shared/proven.ts`) is the single source of truth for the
// annotations; `bun run check:proven` audits it against the latest benchmark
// report (with `--fail` to gate CI).

import { rust, type RustClient } from "./client";

/**
 * The performance-annotated client: the full {@link RustClient} surface.
 * Each exported function's JSDoc notes its measured performance vs the JS
 * baseline; functions slower than the baseline carry `@deprecated`.
 */
export type ProvenClient = RustClient;

/**
 * The full `rust.*` surface with benchmark-annotated JSDoc. Identical to
 * `rust` — the annotations and `@deprecated` markers are what communicate
 * performance now, not a curated subset.
 */
export const proven: ProvenClient = rust;

// Re-export the registry + helpers so consumers can audit the surface.
export {
  PROVEN_SURFACE,
  provenStatus,
  isProven,
  provenSurface,
  provenSummary,
} from "../shared/proven";
export type {
  PerformanceStatus,
  ProvenEntry,
  ProvenKey,
} from "../shared/proven";
