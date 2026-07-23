import type { BenchResult, ComparisonReport } from "./types";

export function printResults(results: BenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      iters: r.iterations,
      "avg ms": r.avgMs.toFixed(4),
      "p50 ms": r.p50Ms.toFixed(4),
      "p95 ms": r.p95Ms.toFixed(4),
      "ops/s": r.opsPerSec.toFixed(1),
      checksum:
        r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  );
}

function printComparison(
  results: BenchResult[],
  report: ComparisonReport,
): void {
  const n = results.find((x) => x.name === report.nativeName);
  const r = results.find((x) => x.name === report.rustName);

  if (!n || !r) {
    return;
  }

  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);

  if (ratio >= 1) {
    console.log(
      `${report.label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    );
  } else {
    console.log(
      `${report.label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    );
  }
}

export function printSummary(
  results: BenchResult[],
  reports: ComparisonReport[],
): void {
  for (const report of reports) {
    printComparison(results, report);
  }
}
