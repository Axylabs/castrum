// scripts/check-coverage.mjs — run `bun test --coverage` and enforce a floor.
//
// CI gate: fails if the overall LINE coverage drops below MIN_LINE_COVERAGE.
// The floor is a safety net (not a target) — it exists so coverage can't
// silently collapse as the codebase grows. Bump it as coverage improves.
//
// Usage: `bun run test:coverage` (== `node scripts/check-coverage.mjs`).

import { spawnSync } from "node:child_process";

/** Minimum overall line coverage (percent). */
const MIN_LINE_COVERAGE = 75;

const { stdout, stderr, status } = spawnSync(
  "bun",
  ["test", "--coverage"],
  { encoding: "utf8" },
);

// bun writes the coverage table to stderr when stdout is not a TTY (as in
// this script / CI), so parse the combined output.
const combined = `${stdout ?? ""}\n${stderr ?? ""}`;

if (status !== 0) {
  process.stderr.write(`\`bun test --coverage\` failed.\n\n${combined}`);
  process.exit(status ?? 1);
}

// Parse the "All files" summary row:
//   All files | <funcs>% | <lines>% | <uncovered>
// (bun reports functions in column 1 and lines in column 2.)
const summary = combined
  .split("\n")
  .find((line) => line.trim().startsWith("All files"));
if (!summary) {
  process.stderr.write(
    "Could not find the 'All files' coverage summary in bun test --coverage output.\n",
  );
  process.exit(1);
}

const lineCoverage = Number(summary.split("|")[2]?.trim().replace("%", ""));
if (!Number.isFinite(lineCoverage)) {
  process.stderr.write(`Could not parse line coverage from: ${summary}\n`);
  process.exit(1);
}

console.log(`Coverage: ${lineCoverage.toFixed(2)}% lines (floor ${MIN_LINE_COVERAGE}%)`);
if (lineCoverage < MIN_LINE_COVERAGE) {
  process.stderr.write(
    `Coverage ${lineCoverage.toFixed(2)}% is below the ${MIN_LINE_COVERAGE}% floor. ` +
      "Add tests before growing the untested surface.\n",
  );
  process.exit(1);
}
