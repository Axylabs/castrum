// scripts/annotate-performance.ts — Annotate exported rust.* JSDoc from the CPU report.
//
// Reads the latest machine-readable CPU report (`bench/results/cpu/latest.json`,
// written by `bun run check`) and rewrites the JSDoc on the public `rust.*`
// function declarations in `src/rust-ffi/scalar.ts` (and `batch.ts` for
// `templateRender`, the only registry entry that lives at batch level).
//
// For every `PROVEN_SURFACE` entry that has a measured comparison:
//   - "proven"          → `@performance <label>: ~Nx faster than the JS baseline`
//   - "parity"          → `@performance <label>: ≈ parity with the JS baseline`
//   - "not-competitive" → `@performance <label>: ~Nx slower ...` + `@deprecated ...`
//
// Generated lines carry the `[check:annotate]` marker, so the script is
// IDEMPOTENT — re-running it strips the previous generated lines and rewrites
// them from the latest report (hand-written JSDoc is preserved).
//
// Usage:
//   bun run check                     # produce a fresh bench/results/cpu/latest.json
//   bun run check:annotate            # rewrite the JSDoc (default)
//   bun run check:annotate -- --dry-run   # print what would change, write nothing
//
// This script imports ONLY the pure-data registry — it does NOT load the
// native addon.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVEN_SURFACE, type ProvenEntry } from "../src/shared/proven";

/** Marker tagging machine-generated JSDoc lines (used for idempotent strip). */
const MARKER = "[check:annotate]";
const REPORT_PATH = join(process.cwd(), "bench", "results", "cpu", "latest.json");
const DRY_RUN = process.argv.includes("--dry-run");

interface Comparison {
  label: string;
  nativeName: string;
  rustName: string;
  nativeAvgMs: number;
  rustAvgMs: number;
  ratio: number;
  faster: "rust" | "native";
}

interface CpuReport {
  comparisons: Comparison[];
}

interface Target {
  name: string;
  lines: string[];
}

/** Map a registry `name` to the source file that declares the public method. */
function fileForName(name: string): string {
  if (name === "templateRender") return "src/rust-ffi/batch.ts";
  if (name === "configure") return "src/rust-ffi/client.ts";
  // Scalar methods are declared on the `RustScalar` interface (the impl is
  // split across src/rust-ffi/scalar/*).
  return "src/rust-ffi/scalar/interface.ts";
}

function loadReport(): CpuReport {
  let raw: string;
  try {
    raw = readFileSync(REPORT_PATH, "utf8");
  } catch {
    console.error(
      `annotate — no report found at ${REPORT_PATH}.\nRun "bun run check" first (it writes the machine-readable CPU report).`,
    );
    process.exit(2);
  }
  return JSON.parse(raw) as CpuReport;
}

/**
 * Build the generated JSDoc lines for a registry entry, or null when there is
 * no measured comparison / the entry is "unmeasured".
 */
function generatedLines(
  entry: ProvenEntry,
  cmp: Comparison | undefined,
): string[] | null {
  if (!cmp || entry.status === "unmeasured") return null;

  // ratio = nativeAvg / rustAvg → >1 means rust is faster.
  const r = cmp.ratio;
  const lines: string[] = [];

  if (entry.status === "proven") {
    // Clamp to >= 1 for display; a sub-1 ratio here is a regression the audit
    // (`bun run check:proven`) flags.
    lines.push(
      ` * @performance ${entry.label}: ~${Math.max(r, 1).toFixed(1)}x faster than the JS baseline ${MARKER}`,
    );
  } else if (entry.status === "parity") {
    lines.push(
      ` * @performance ${entry.label}: ≈ parity with the JS baseline ${MARKER}`,
    );
  } else if (entry.status === "not-competitive") {
    const loss = 1 / Math.max(r, 1e-9);
    lines.push(
      ` * @performance ${entry.label}: ~${loss.toFixed(1)}x slower than the JS baseline ${MARKER}`,
    );
    lines.push(
      ` * @deprecated Slower than the native JS baseline (~${loss.toFixed(1)}x) — prefer the JS/Bun baseline. ${MARKER}`,
    );
  } else {
    return null;
  }

  if (entry.note) {
    lines.push(` * @remarks ${entry.note} ${MARKER}`);
  }
  return lines;
}

const isGenerated = (line: string): boolean => line.includes(MARKER);

/**
 * Rewrite the JSDoc blocks above the target declarations in a namespace
 * interface file. Returns { changed, deprecated } for the summary.
 */
function annotateFile(
  filePath: string,
  targets: Target[],
): { changed: number; deprecated: number } {
  const src = readFileSync(filePath, "utf8");
  const lines = src.split("\n");

  const interfaceStart = lines.findIndex((l) =>
    /^\s*export interface (RustScalar|RustBatch)\s*\{/.test(l),
  );
  if (interfaceStart < 0) {
    console.error(`annotate — could not locate interface in ${filePath}`);
    return { changed: 0, deprecated: 0 };
  }

  const interfaceEnd = (() => {
    for (let i = interfaceStart + 1; i < lines.length; i++) {
      if (/^\}\s*$/.test(lines[i])) return i;
    }
    return -1;
  })();
  if (interfaceEnd < 0) {
    console.error(`annotate — could not locate interface end in ${filePath}`);
    return { changed: 0, deprecated: 0 };
  }

  const byName = new Map(targets.map((t) => [t.name, t.lines]));
  const names = [...byName.keys()];

  interface Action {
    start: number; // first line of the JSDoc block to replace (or the decl line when inserting)
    decl: number; // declaration line (kept as-is)
    hasJdoc: boolean;
    generated: string[];
  }
  const actions: Action[] = [];

  let jdocStart = -1;
  let jdocEnd = -1;
  let inJdoc = false;

  for (let i = interfaceStart + 1; i < interfaceEnd; i++) {
    const line = lines[i];

    if (!inJdoc && /^\s*\/\*\*/.test(line)) {
      jdocStart = i;
      if (/\*\/\s*$/.test(line)) {
        jdocEnd = i;
      } else {
        inJdoc = true;
      }
      continue;
    }
    if (inJdoc) {
      if (/\*\/\s*$/.test(line)) {
        jdocEnd = i;
        inJdoc = false;
      }
      continue;
    }

    // Not inside a JSDoc block: check for a target declaration.
    const name = names.find((n) => new RegExp(`^\\s*${n}\\s*\\(`).test(line));
    if (name) {
      const generated = byName.get(name);
      if (generated) {
        const hasJdoc = jdocEnd === i - 1;
        actions.push({
          start: hasJdoc ? jdocStart : i,
          decl: i,
          hasJdoc,
          generated,
        });
      }
      jdocStart = -1;
      jdocEnd = -1;
    }
  }

  const splices: Array<{
    start: number;
    deleteCount: number;
    newLines: string[];
  }> = [];

  // Indent generated JSDoc to match the declaration's leading whitespace so
  // the injected blocks read as part of the interface body. Generated lines
  // already start with ` * `; prepending the indent aligns the `*` with the
  // block's other lines (e.g. `  /**` → `   * @performance ...` → `  */`).
  const padTo = (line: string, indent: string): string => `${indent}${line}`;

  for (const a of actions) {
    const indent = lines[a.decl].match(/^\s*/)?.[0] ?? "";
    const generated = a.generated.map((l) => padTo(l, indent));

    if (a.hasJdoc) {
      // Replace the existing block: keep hand-written lines, drop generated
      // ones, re-append fresh generated lines before the closing `*/`.
      const block = lines.slice(a.start, a.decl).filter((l) => !isGenerated(l));
      let cleaned: string[];
      // A JSDoc written on one line (`/** ... */`) must be expanded into a
      // multi-line block so generated lines can sit inside it.
      const singleLine =
        block.length === 1 &&
        /^\s*\/\*\*/.test(block[0]) &&
        /\*\/\s*$/.test(block[0]);
      if (singleLine) {
        const inner = block[0]
          .replace(/^\s*\/\*\*/, "")
          .replace(/\*\/\s*$/, "")
          .trim();
        cleaned = [
          `${indent}/**`,
          ...(inner ? [`${indent} * ${inner}`] : []),
          ...generated,
          `${indent} */`,
        ];
      } else {
        const closeIdx = block.findIndex((l) => l.includes("*/"));
        cleaned = [];
        if (closeIdx >= 0) {
          cleaned.push(...block.slice(0, closeIdx));
          cleaned.push(...generated);
          cleaned.push(...block.slice(closeIdx));
        } else {
          cleaned.push(...block, ...generated);
        }
      }
      splices.push({
        start: a.start,
        deleteCount: a.decl - a.start,
        newLines: cleaned,
      });
    } else {
      // No JSDoc: insert a fresh block above the declaration.
      splices.push({
        start: a.decl,
        deleteCount: 0,
        newLines: [`${indent}/**`, ...generated, `${indent} */`],
      });
    }
  }

  splices.sort((x, y) => y.start - x.start);
  const work = lines.slice();
  for (const s of splices) {
    work.splice(s.start, s.deleteCount, ...s.newLines);
  }

  const next = work.join("\n");
  const deprecated = actions.filter((a) =>
    a.generated.some((l) => l.includes("@deprecated")),
  ).length;

  if (next === src) {
    return { changed: 0, deprecated: 0 };
  }

  if (!DRY_RUN) {
    writeFileSync(filePath, next, "utf8");
  }
  return { changed: actions.length, deprecated };
}

function main(): void {
  const report = loadReport();
  const byRustTask = new Map(report.comparisons.map((c) => [c.rustName, c]));

  const targetsByFile = new Map<string, Target[]>();
  for (const entry of PROVEN_SURFACE) {
    const gen = generatedLines(entry, byRustTask.get(entry.rustTask));
    if (!gen) continue;
    const file = fileForName(entry.name);
    const list = targetsByFile.get(file) ?? [];
    list.push({ name: entry.name, lines: gen });
    targetsByFile.set(file, list);
  }

  let totalChanged = 0;
  let totalDeprecated = 0;

  console.log(`\n=== Annotate rust.* JSDoc from CPU report ===${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(
    `Report: ${REPORT_PATH}\n${targetsByFile.size === 0 ? "" : `Entries with measurements: ${[...targetsByFile.values()].reduce((n, t) => n + t.length, 0)}`}\n`,
  );

  for (const [file, targets] of targetsByFile) {
    const { changed, deprecated } = annotateFile(file, targets);
    totalChanged += changed;
    totalDeprecated += deprecated;
    const action = DRY_RUN ? "would annotate" : "annotated";
    console.log(
      `  ${action} ${changed} function(s) in ${file}${deprecated > 0 ? ` (${deprecated} deprecated)` : ""}`,
    );
  }

  const unmeasured = PROVEN_SURFACE.filter(
    (e) => e.status === "unmeasured" || !byRustTask.has(e.rustTask),
  ).length;
  console.log(
    `\n${totalChanged} function(s) ${DRY_RUN ? "to update" : "updated"}, ${totalDeprecated} marked @deprecated. ${unmeasured} registry entries skipped (unmeasured / no comparison).`,
  );
}

main();
