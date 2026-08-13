/**
 * JSDoc coverage guard for the public API surface.
 *
 * Scans every exported symbol in the PUBLIC modules (everything under `src/`
 * plus the root `index.ts`) and reports which lack a JSDoc block
 * (a comment opener followed by an asterisk) immediately above them. Fails
 * when coverage drops below a floor, so new undocumented exports are caught in
 * CI instead of silently shipping.
 *
 * Scope: the shipped API (`src/` + `index.ts`). Internal tooling (`bench/`,
 * `scripts/`, `examples/`) is excluded from the gate.
 *
 * Run: `bun run check:jsdoc`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC_DIR = join(ROOT, "src");
const ENTRY = join(ROOT, "index.ts");

/** Coverage floor (%): a regression below this fails CI. */
const COVERAGE_FLOOR = 95;

/**
 * Internal directories excluded from the gate. These are benchmark/baseline
 * scaffolding that is NOT shipped (mirrors package.json `files`:
 * `"!src/bench"`, `"!src/baseline"`) — counting them only diluted the floor
 * for the real public API.
 */
const EXCLUDED_DIRS = new Set(["bench", "baseline"]);

/** All `.ts` files under a directory (non-recursive, recursive scan). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Whether the text immediately before `index` closes a JSDoc block. */
function isDocumented(file: string, exportStart: number): boolean {
  const before = file.slice(0, exportStart).trimEnd();
  if (!before.endsWith("*/")) return false;
  const openIdx = before.lastIndexOf("/*");
  if (openIdx === -1) return false;
  return before[openIdx + 2] === "*"; // `/**` opener
}

/** Find all `export <kind> <name>` declarations in `file`. */
function exportedDeclarations(
  file: string,
): Array<{ start: number; name: string }> {
  const out: Array<{ start: number; name: string }> = [];
  const re =
    /export\s+(?:async\s+)?(?:default\s+)?(function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of file.matchAll(re)) {
    const name = m[2];
    if (!name) continue;
    const start = m.index ?? 0;
    // Skip re-export statements (`export ... from '...'`) and `export * from`.
    if (file.slice(start).match(/^export[\s\S]{0,60}?\bfrom\s+['"]/)) continue;
    out.push({ start, name });
  }
  return out;
}

const files = [ENTRY, ...collectTsFiles(SRC_DIR)];
const undocumented: Array<{ file: string; name: string }> = [];
let total = 0;
let documented = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const decl of exportedDeclarations(source)) {
    total++;
    if (isDocumented(source, decl.start)) {
      documented++;
    } else {
      undocumented.push({ file: relative(ROOT, file), name: decl.name });
    }
  }
}

const pct = total === 0 ? 100 : Math.round((documented / total) * 100);
console.log(`JSDoc coverage: ${documented}/${total} exports (${pct}%)`);

if (undocumented.length > 0) {
  const shown = undocumented.slice(0, 30);
  console.log(`\nUndocumented exports (${undocumented.length} total, showing ${shown.length}):`);
  for (const { file, name } of shown) {
    console.log(`  - ${file} :: ${name}`);
  }
}

if (pct < COVERAGE_FLOOR) {
  console.error(
    `\nFAIL: JSDoc coverage ${pct}% < floor ${COVERAGE_FLOOR}%. ` +
      `Add a /** */ block above each undocumented export (see list).`,
  );
  process.exit(1);
}

console.log(`PASS: coverage is >= ${COVERAGE_FLOOR}%`);
