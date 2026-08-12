import { runCorrectnessChecks, runComplexCorrectnessChecks } from "./checks";
import { comparisonReports } from "./comparisons";
import { createFixtures, createComplexFixtures } from "./fixtures";
import { bench, benchConcurrent, benchStress } from "./measure";
import {
  printResults,
  printConcurrentResults,
  printStressResults,
  printSummary,
  writeCpuReport,
} from "./report";
import { createAllTasks, createComplexTasks, createConcurrentTasks, createStressTasks } from "./tasks";
import { runLoaderAsyncBenchmarks, writeLoaderReport } from "./tasks/loader";
import { getBunFFI } from "../native/ffi";
import { isBun } from "../shared/runtime";

export async function runBenchmark(): Promise<void> {
  // ── Transport guard (FFI is PRIMARY on Bun) ─────────────────────
  // The `rust:*` tasks below run through `rust.*`, which on Bun dispatches to
  // bun:ffi. When the ffi transport is unavailable (Node, forced
  // `CASTRUM_FFI_MODE=napi`, or a failed bind-time self-test) the bench still
  // runs on the napi fallback, but a warning is printed so the report is never
  // mistaken for the primary (ffi) path. `CASTRUM_BENCH_FFI=1` turns that
  // warning into a hard failure for CI that must guarantee FFI-primary
  // measurements.
  const ffiActive = getBunFFI() !== null;
  if (isBun() && !ffiActive) {
    const msg =
      "bun:ffi is NOT active on Bun — rust:* tasks will run through the napi " +
      "fallback. Unset CASTRUM_FFI_MODE (or set it to auto) and ensure the " +
      "addon bind-time self-test passes.";
    if (process.env.CASTRUM_BENCH_FFI === "1") {
      throw new Error(`CASTRUM_BENCH_FFI=1: ${msg}`);
    }
    console.warn(`\u26a0\ufe0f  ${msg}`);
  } else if (isBun()) {
    console.log("bun:ffi active — rust:* tasks run through the primary FFI transport.");
  }

  const fixtures = createFixtures();
  const complexFixtures = createComplexFixtures();

  runCorrectnessChecks(fixtures);
  runComplexCorrectnessChecks(fixtures, complexFixtures);

  // ── Standard sequential benchmarks ──
  console.log("\n═══ Standard Benchmarks ═══");
  const tasks = createAllTasks(fixtures);
  const results = tasks.map((task) =>
    bench(task.name, task.run, task.iterations, task.warmup),
  );
  printResults(results);

  // ── Complex payload benchmarks ──
  console.log("\n═══ Complex Payload Benchmarks ═══");
  const complexTasks = createComplexTasks(complexFixtures);
  const complexResults = complexTasks.map((task) =>
    bench(task.name, task.run, task.iterations, task.warmup),
  );
  printResults(complexResults);

  // ── Loader async microbenchmarks (load() coalescing + cache hits) ──
  // Print-only: async `load()` results don't fit the sync CPU-report schema.
  console.log("\n═══ Loader Async Benchmarks ═══");
  const loaderAsync = await runLoaderAsyncBenchmarks(complexFixtures);
  for (const r of loaderAsync) {
    console.log(
      `  ${r.name.padEnd(34)} ${r.opsPerSec.toFixed(0).padStart(9)} ops/s  ${r.nsPerOp.toFixed(1).padStart(8)} ns/op  checksum ${r.checksum}`,
    );
  }
  const loaderReportPath = writeLoaderReport(loaderAsync);
  console.log(`Loader report written to ${loaderReportPath}`);

  // ── Concurrent burst benchmarks ──
  console.log("\n═══ Concurrent Burst Benchmarks ═══");
  const concurrentTasks = createConcurrentTasks(fixtures, complexFixtures);
  const concurrentResults: import("./types").ConcurrentBenchResult[] = [];
  for (const task of concurrentTasks) {
    concurrentResults.push(await benchConcurrent(task));
  }
  printConcurrentResults(concurrentResults);

  // ── Stress benchmarks (fixed duration) ──
  console.log("\n═══ Stress Benchmarks (2s each) ═══");
  const stressTasksList = createStressTasks(fixtures, complexFixtures);
  const stressResults: import("./types").StressBenchResult[] = [];
  for (const task of stressTasksList) {
    stressResults.push(
      benchStress(task.name, task.run, task.durationMs, task.warmupMs),
    );
  }
  printStressResults(stressResults);

  // ── Combined summary ──
  console.log("\n═══ Practical Summary ═══");
  const all = [
    ...results,
    ...complexResults,
    ...concurrentResults,
    ...stressResults,
  ];
  printSummary(all, comparisonReports);

  // ── Persist a machine-readable report (for committed baselines) ──
  const reportPath = await writeCpuReport({
    standard: results,
    complex: complexResults,
    concurrent: concurrentResults,
    stress: stressResults,
    comparisons: comparisonReports,
  });
  console.log(`\nCPU report written to ${reportPath}`);

  // ── Optional auto-annotation ──
  // `CASTRUM_BENCH_ANNOTATE=1` rewrites the rust.* JSDoc
  // (@performance/@deprecated, data-driven) right after the run so the user
  // sees an informed score + auto-deprecation without an extra step. This is
  // opt-in because it mutates tracked source files; the default `bun run check`
  // stays report-only (classifications should be confirmed on a release build).
  // The annotator imports only pure-data modules (registry + classifier), never
  // the addon, and is idempotent ([check:annotate] marker).
  if (process.env.CASTRUM_BENCH_ANNOTATE === "1") {
    try {
      const { annotateFromReport } = await import(
        "../../scripts/annotate-performance"
      );
      const result = annotateFromReport({ reportPath });
      console.log(
        `\nCASTRUM_BENCH_ANNOTATE=1: annotated ${result.changed} function(s) in ${result.files} file(s), ${result.deprecated} marked @deprecated.`,
      );
    } catch (err) {
      console.error(
        `CASTRUM_BENCH_ANNOTATE=1: JSDoc annotation skipped — ${(err as Error).message}`,
      );
    }
  }
}