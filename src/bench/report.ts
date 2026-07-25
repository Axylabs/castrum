import type { BenchResult, ComparisonReport, ConcurrentBenchResult, StressBenchResult } from "./types";

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

export function printConcurrentResults(results: ConcurrentBenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      concurrency: r.concurrency,
      "ops/slot": r.iterations,
      "total ops": r.totalOps,
      "total ms": r.totalMs.toFixed(2),
      "avg ms/op": r.avgMs.toFixed(6),
      "ops/s": r.opsPerSec.toFixed(1),
      checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  );
}

export function printStressResults(results: StressBenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      "duration ms": r.durationMs.toFixed(0),
      "total ops": r.totalOps,
      "ops/s": r.opsPerSec.toFixed(1),
      "avg ms": r.avgMs.toFixed(6),
      checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  );
}

function printComparison(
  results: (BenchResult | ConcurrentBenchResult | StressBenchResult)[],
  report: ComparisonReport,
): void {
  const n = results.find((x) => x.name === report.nativeName);
  const r = results.find((x) => x.name === report.rustName);

  if (!n || !r) {
    return;
  }

  const nAvg = n.avgMs;
  const rAvg = r.avgMs;
  const ratio = nAvg / Math.max(rAvg, 1e-9);

  if (ratio >= 1) {
    console.log(
      `${report.label}: Rust ${rAvg.toFixed(4)}ms vs Native ${nAvg.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    );
  } else {
    console.log(
      `${report.label}: Rust ${rAvg.toFixed(4)}ms vs Native ${nAvg.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    );
  }
}

export function printSummary(
  results: (BenchResult | ConcurrentBenchResult | StressBenchResult)[],
  reports: ComparisonReport[],
): void {
  for (const report of reports) {
    printComparison(results, report);
  }
}