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

export async function runBenchmark(): Promise<void> {
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
}