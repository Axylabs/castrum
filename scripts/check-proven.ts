// scripts/check-proven.ts — Audit the performance-proven registry.
//
// Reads the latest machine-readable CPU report (`bench/results/cpu/latest.json`,
// written by `bun run check`) and cross-checks it against PROVEN_SURFACE
// (src/shared/proven.ts). Classification is shared with the JSDoc annotator
// (src/shared/bench-classify.ts) and is aggregate + majority-based: every
// comparison for a function (canonical task + `_`-suffixed variants) counts.
// Flags:
//
//   - REGRESSION   a "proven" function whose MAJORITY of benchmarks now lose
//   - PROMOTABLE   a "not-competitive" function whose MAJORITY now win
//   - PARITY-DRIFT a "parity" function whose MAJORITY of benchmarks now lose
//
// Usage:
//   bun run check && bun run check:proven            # report only (exit 0)
//   bun run check && bun run check:proven -- --fail  # exit 1 on regressions
//
// IMPORTANT: results depend on the addon build. Use a RELEASE build
// (`bun run build`) or the LOCAL max-perf build (`bun run build:perf`) for a
// meaningful audit; debug builds inflate rust timings (e.g. URL encode/decode
// appear to lose when they win in release).
//
// This script imports ONLY the pure-data registry + classifier — it does NOT
// load the native addon.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVEN_SURFACE, type ProvenEntry } from "../src/shared/proven";
import {
  classifySurface,
  LOSS_TOLERANCE,
  PROMOTE_TOLERANCE,
  type ClassifiedEntry,
  type Comparison,
} from "../src/shared/bench-classify";

const failMode = process.argv.includes("--fail");

function loadReport(): { comparisons: Comparison[] } {
  const path = join(process.cwd(), "bench", "results", "cpu", "latest.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      `check:proven — no report found at ${path}.\nRun "bun run check" first (it writes the machine-readable CPU report).`,
    );
    process.exit(2);
  }
  return JSON.parse(raw) as { comparisons: Comparison[] };
}

type Finding =
  | { kind: "OK"; entry: ProvenEntry; ratio: number; classified: ClassifiedEntry }
  | { kind: "REGRESSION"; entry: ProvenEntry; ratio: number; classified: ClassifiedEntry }
  | { kind: "PROMOTABLE"; entry: ProvenEntry; ratio: number; classified: ClassifiedEntry }
  | { kind: "PARITY-DRIFT"; entry: ProvenEntry; ratio: number; classified: ClassifiedEntry }
  | { kind: "UNMEASURED"; entry: ProvenEntry; classified: ClassifiedEntry };

/**
 * Audit the registry against the report. REGRESSION / PARITY-DRIFT /
 * PROMOTABLE use the SAME aggregate (majority-of-tasks) signal as the JSDoc
 * annotator: a clear majority of a function's benchmarks must lose before a
 * "proven"/"parity" function is flagged, and a majority win is required to
 * flag a "not-competitive" function as promotable.
 */
function audit(
  entries: readonly ProvenEntry[],
  comparisons: Comparison[],
): Finding[] {
  // classifySurface returns an entry for EVERY registry entry, so the lookup
  // below always resolves; entries with no measured comparison classify as
  // `total === 0` (UNMEASURED) rather than being absent.
  const classified = classifySurface(entries, comparisons);

  return entries.map((entry): Finding => {
    const c = classified.get(entry.name);
    if (!c) throw new Error(`missing classification for ${entry.name}`);
    if (c.total === 0) {
      return { kind: "UNMEASURED", entry, classified: c };
    }
    const ratio = c.ratio ?? 0;

    if (entry.status === "proven" && c.majorityFail) {
      return { kind: "REGRESSION", entry, ratio, classified: c };
    }
    if (entry.status === "parity" && c.majorityFail) {
      return { kind: "PARITY-DRIFT", entry, ratio, classified: c };
    }
    if (entry.status === "not-competitive" && c.majorityWin) {
      return { kind: "PROMOTABLE", entry, ratio, classified: c };
    }
    return { kind: "OK", entry, ratio, classified: c };
  });
}

function fmt(ratio: number): string {
  return ratio >= 1 ? `${ratio.toFixed(2)}x rust` : `${(1 / ratio).toFixed(2)}x baseline`;
}

/** Compact score suffix, e.g. " (3/4 tasks failed)" — omitted for single-task fns. */
function score(c: ClassifiedEntry): string {
  if (c.total <= 1) return "";
  return c.majorityFail
    ? ` (${c.failed}/${c.total} tasks failed)`
    : ` (${c.won}/${c.total} tasks won)`;
}

function main(): void {
  const report = loadReport();
  const findings = audit(PROVEN_SURFACE, report.comparisons);

  console.log("\n=== Performance-proven surface audit ===");
  console.log(
    `(ratio >1 = Rust faster; aggregate over each function's benchmark tasks; tolerances: proven-loss >${LOSS_TOLERANCE}x, promote >${PROMOTE_TOLERANCE}x)\n`,
  );

  const regressions: Finding[] = [];
  for (const f of findings) {
    switch (f.kind) {
      case "OK":
        if (f.entry.status === "proven") {
          console.log(`  ✓ ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}${score(f.classified)}`);
        }
        break;
      case "REGRESSION":
        regressions.push(f);
        console.log(
          `  ✗ REGRESSION  ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}${score(f.classified)}  (was proven: ${f.entry.label})`,
        );
        break;
      case "PARITY-DRIFT":
        console.log(
          `  ! PARITY-DRIFT ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}${score(f.classified)}  (was parity: ${f.entry.label})`,
        );
        break;
      case "PROMOTABLE":
        console.log(
          `  ↑ PROMOTABLE  ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}${score(f.classified)}  (was not-competitive: ${f.entry.label})`,
        );
        break;
      case "UNMEASURED":
        break;
    }
  }

  const counts = PROVEN_SURFACE.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    },
    { proven: 0, parity: 0, "not-competitive": 0, unmeasured: 0 } as Record<string, number>,
  );
  console.log(
    `\nRegistry: ${counts.proven} proven · ${counts.parity} parity · ${counts["not-competitive"]} not-competitive · ${counts.unmeasured} unmeasured`,
  );
  console.log(
    "Note: results are build-dependent. Audit on a release (`bun run build`) or perf (`bun run build:perf`) build.",
  );

  if (failMode && regressions.length > 0) {
    console.error(
      `\ncheck:proven --fail: ${regressions.length} proven function(s) regressed. See above.`,
    );
    process.exit(1);
  }
  console.log(failMode ? "\ncheck:proven --fail: OK (no regressions)" : "");
}

main();
