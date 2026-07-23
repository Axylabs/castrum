import { runCorrectnessChecks } from "./checks";
import { comparisonReports } from "./comparisons";
import { createFixtures } from "./fixtures";
import { bench } from "./measure";
import { printResults, printSummary } from "./report";
import { createAllTasks } from "./tasks";

export function runBenchmark(): void {
  const fixtures = createFixtures();

  runCorrectnessChecks(fixtures);

  const tasks = createAllTasks(fixtures);
  const results = tasks.map((task) =>
    bench(task.name, task.run, task.iterations, task.warmup),
  );

  printResults(results);

  console.log("\n═══ Practical Summary ═══");
  printSummary(results, comparisonReports);
}
