// scripts/check-proven.ts — Audit the performance-proven registry.
//
// Reads the latest machine-readable CPU report (`bench/results/cpu/latest.json`,
// written by `bun run check`) and cross-checks it against PROVEN_SURFACE
// (src/shared/proven.ts). Flags:
//
//   - REGRESSION   a "proven" function is now a clear loss vs its baseline
//   - PROMOTABLE   a "not-competitive" function now clearly wins (candidate to
//                  promote to "proven")
//   - PARITY-DRIFT a "parity" function drifted to a clear loss
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
// This script imports ONLY the pure-data registry — it does NOT load the
// native addon.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVEN_SURFACE, type ProvenEntry } from "../src/shared/proven";

const failMode = process.argv.includes("--fail");

// A "proven" function whose baseline is more than this much faster is a
// regression worth failing on. Generous enough to absorb sub-µs noise.
const LOSS_TOLERANCE = 1.35;
// A "not-competitive" function that wins by more than this is a promotion
// candidate.
const PROMOTE_TOLERANCE = 1.5;

interface Comparison {
  label: string;
  nativeName: string;
  rustName: string;
  nativeAvgMs: number;
  rustAvgMs: number;
  ratio: number;
  faster: string;
}

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
  | { kind: "OK"; entry: ProvenEntry; ratio: number }
  | { kind: "REGRESSION"; entry: ProvenEntry; ratio: number }
  | { kind: "PROMOTABLE"; entry: ProvenEntry; ratio: number }
  | { kind: "PARITY-DRIFT"; entry: ProvenEntry; ratio: number }
  | { kind: "UNMEASURED"; entry: ProvenEntry };

function audit(
  entries: ProvenEntry[],
  comparisons: Comparison[],
): Finding[] {
  const byRustName = new Map(comparisons.map((c) => [c.rustName, c]));

  return entries.map((entry): Finding => {
    if (!entry.nativeTask || !entry.rustTask) {
      return { kind: "UNMEASURED", entry };
    }
    const c = byRustName.get(entry.rustTask);
    if (!c) return { kind: "UNMEASURED", entry };

    // ratio = nativeAvg / rustAvg → >1 means rust is faster.
    const ratio = c.nativeAvgMs / c.rustAvgMs;

    if (entry.status === "proven" && ratio < 1 / LOSS_TOLERANCE) {
      return { kind: "REGRESSION", entry, ratio };
    }
    if (entry.status === "parity" && ratio < 1 / LOSS_TOLERANCE) {
      return { kind: "PARITY-DRIFT", entry, ratio };
    }
    if (entry.status === "not-competitive" && ratio > PROMOTE_TOLERANCE) {
      return { kind: "PROMOTABLE", entry, ratio };
    }
    return { kind: "OK", entry, ratio };
  });
}

function fmt(ratio: number): string {
  return ratio >= 1 ? `${ratio.toFixed(2)}x rust` : `${(1 / ratio).toFixed(2)}x baseline`;
}

function main(): void {
  const report = loadReport();
  const findings = audit(PROVEN_SURFACE, report.comparisons);

  console.log("\n=== Performance-proven surface audit ===");
  console.log("(ratio >1 = Rust faster; tolerances: proven-loss >1.35x, promote >1.5x)\n");

  const regressions: Finding[] = [];
  for (const f of findings) {
    switch (f.kind) {
      case "OK":
        if (f.entry.status === "proven") {
          console.log(`  ✓ ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}`);
        }
        break;
      case "REGRESSION":
        regressions.push(f);
        console.log(
          `  ✗ REGRESSION  ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}  (was proven: ${f.entry.label})`,
        );
        break;
      case "PARITY-DRIFT":
        console.log(
          `  ! PARITY-DRIFT ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}  (was parity: ${f.entry.label})`,
        );
        break;
      case "PROMOTABLE":
        console.log(
          `  ↑ PROMOTABLE  ${f.entry.name.padEnd(26)} ${fmt(f.ratio)}  (was not-competitive: ${f.entry.label})`,
        );
        break;
      case "UNMEASURED":
        break;
    }
  }

  const counts = PROVEN_SURFACE.reduce(
    (acc, e) => {
      acc[e.status] += 1;
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
