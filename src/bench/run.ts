import { runCorrectnessChecks, runComplexCorrectnessChecks } from "./checks";
import { comparisonReports } from "./comparisons";
import { createFixtures, createComplexFixtures } from "./fixtures";
import { bench, benchConcurrent, benchStress } from "./measure";
import { printResults, printConcurrentResults, printStressResults, printSummary } from "./report";
import { createAllTasks, createComplexTasks, createConcurrentTasks, createStressTasks } from "./tasks";

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
  printSummary(
    [...results, ...complexResults, ...concurrentResults, ...stressResults],
    comparisonReports,
  );
}