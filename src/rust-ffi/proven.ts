// src/rust-ffi/proven.ts — The performance-proven export surface.
//
// `proven` exposes ONLY the `rust.*` functions whose status is "proven" in the
// benchmark registry (`src/shared/proven.ts`). Functions that merely match the
// JS baseline ("parity") or lose to it ("not-competitive" — e.g. `jsonParse`
// vs Bun's JSON.parse, or schema validation vs ajv) are intentionally omitted.
//
// This gives consumers a curated, performance-justified entry point:
//
//   import { proven } from "castrum";
//   proven.jsonValid(bytes);  // ✓ proven (Rust wins)
//   proven.jsonParse(bytes);  // ✗ type error — not in the proven surface
//
// The registry is the single source of truth; `proven` is derived from it, so
// the two can never drift. Run `bun run check:proven` to audit the registry
// against the latest benchmark report (with `--fail` to gate CI).

import {
  provenSurface,
  type ProvenKey,
  type ProvenEntry,
} from "../shared/proven";
import { rust, type RustClient } from "./client";

/**
 * The proven client: a subset of {@link RustClient} restricted to the
 * functions that prove performance in benchmarks (`ProvenKey` is derived from
 * the registry's "proven" entries, so the type matches the data exactly).
 */
export type ProvenClient = Pick<RustClient, ProvenKey>;

const provenNames = provenSurface().map((e) => e.name) as ProvenKey[];

function buildProven(): ProvenClient {
  const out: Record<string, unknown> = {};
  const anyRust = rust as unknown as Record<string, unknown>;
  for (const name of provenNames) {
    const fn = anyRust[name];
    if (typeof fn === "function") {
      out[name] = fn;
    }
  }
  return out as ProvenClient;
}

/**
 * The performance-proven surface: only `rust.*` functions that clearly beat
 * their JS baseline. Omitted functions still exist on `rust` (full surface).
 */
export const proven: ProvenClient = buildProven();

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
