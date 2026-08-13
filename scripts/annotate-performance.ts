// scripts/annotate-performance.ts — Annotate exported rust.* JSDoc from the CPU report.
//
// Reads a machine-readable CPU report (default `bench/results/cpu/latest.json`,
// written by `bun run check`) and rewrites the JSDoc on the public `rust.*`
// function declarations in `src/rust-ffi/scalar/interface.ts` (and `batch.ts`
// for `templateRender`, `client.ts` for `configure`).
//
// Classification is DATA-DRIVEN: for every `PROVEN_SURFACE` entry it aggregates
// ALL of the function's benchmark comparisons (the canonical task plus its
// `_`-suffixed variants) and derives a live status + score:
//   - effective "proven"          → `@performance <label>: ~Nx faster ... (N/M tasks won)`
//   - effective "parity"          → `@performance <label>: ≈ parity ... (N/M tasks won)`
//   - effective "not-competitive" → `@performance <label>: ~Nx slower ...` + `@deprecated ...`
//
// Hybrid deprecation (see src/shared/bench-classify.ts): a clear MAJORITY of a
// function's benchmarks failing in the latest run auto-deprecates it even when
// the static registry says "proven"/"parity" (a `@remarks` note records the
// drift). A single good run NEVER removes an existing `@deprecated` — static
// classifications reflect the shipped release build, not one local run; a
// majority win on a static "not-competitive" entry only adds a "promotion
// candidate" note.
//
// Generated lines carry the `[check:annotate]` marker, so the script is
// IDEMPOTENT — re-running it strips the previous generated lines and rewrites
// them from the latest report (hand-written JSDoc is preserved).
//
// Usage:
//   bun run check                     # produce a fresh bench/results/cpu/latest.json
//   bun run check:annotate            # rewrite the JSDoc (default)
//   bun run check:annotate -- --dry-run   # print what would change, write nothing
//   CASTRUM_BENCH_ANNOTATE=1 bun run check  # auto-annotate after the run (src/bench/run.ts)
//
// This script imports ONLY pure-data modules (registry + classifier) — it does
// NOT load the native addon.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVEN_SURFACE } from '../src/shared/proven'
import {
  classifySurface,
  type ClassifiedEntry,
  type Comparison,
} from '../src/shared/bench-classify'

/** Marker tagging machine-generated JSDoc lines (used for idempotent strip). */
const MARKER = '[check:annotate]'
const REPORT_PATH = join(process.cwd(), 'bench', 'results', 'cpu', 'latest.json')

interface CpuReport {
  environment?: { buildFlavor?: string }
  comparisons: Comparison[]
}

interface Target {
  name: string
  lines: string[]
}

/** Map a registry `name` to the source file that declares the public method. */
function fileForName(name: string): string {
  if (name === 'templateRender') return 'src/rust-ffi/batch.ts'
  if (name === 'configure') return 'src/rust-ffi/client.ts'
  // Scalar methods are declared on the `RustScalar` interface (the impl is
  // split across src/rust-ffi/scalar/*).
  return 'src/rust-ffi/scalar/interface.ts'
}

function loadReport(reportPath: string): CpuReport {
  let raw: string
  try {
    raw = readFileSync(reportPath, 'utf8')
  } catch {
    throw new Error(
      `no report found at ${reportPath}.\nRun "bun run check" first (it writes the machine-readable CPU report).`,
    )
  }
  return JSON.parse(raw) as CpuReport
}

/**
 * Score suffix for the `@performance` line, e.g. "(5/6 tasks won)" — omitted
 * for single-task functions where the ratio already says it all. Shows the
 * failed count when the displayed outcome is a loss, the won count otherwise.
 */
function scoreText(c: ClassifiedEntry): string {
  if (c.total <= 1) return ''
  const losing = c.effective === 'not-competitive' && (c.ratio ?? 1) < 1
  return losing ? ` (${c.failed}/${c.total} tasks failed)` : ` (${c.won}/${c.total} tasks won)`
}

/**
 * Build the generated JSDoc lines for a classified entry, or null when there
 * is nothing to annotate (unmeasured / no measured comparison).
 *
 * `effective` is the hybrid status from bench-classify: a clear majority of
 * task losses overrides the static registry and auto-deprecates.
 */
function generatedLines(c: ClassifiedEntry): string[] | null {
  if (c.effective === 'unmeasured' || c.total === 0 || c.ratio === undefined) {
    return null
  }
  const entry = c.entry
  // ratio = nativeAvg / rustAvg → >1 means rust is faster.
  const r = c.ratio
  const lines: string[] = []

  if (c.effective === 'proven') {
    // Clamp to >= 1 for display; a sub-1 ratio here is a regression the audit
    // (`bun run check:proven`) flags.
    lines.push(
      ` * @performance ${entry.label}: ~${Math.max(r, 1).toFixed(1)}x faster than the JS baseline${scoreText(c)} ${MARKER}`,
    )
  } else if (c.effective === 'parity') {
    lines.push(
      ` * @performance ${entry.label}: ≈ parity with the JS baseline${scoreText(c)} ${MARKER}`,
    )
  } else if (c.effective === 'not-competitive') {
    if (r >= 1) {
      // Won in THIS run but statically "not-competitive" (promotable / mixed):
      // report the win honestly while keeping the historical deprecation (a
      // single good run never un-deprecates — see the classifier's hybrid rule).
      lines.push(
        ` * @performance ${entry.label}: ~${r.toFixed(1)}x faster than the JS baseline in the latest run${scoreText(c)} ${MARKER}`,
      )
      lines.push(
        ` * @deprecated Historically slower than the native JS baseline on release builds — prefer the JS/Bun baseline until promoted. ${MARKER}`,
      )
    } else {
      const loss = 1 / Math.max(r, 1e-9)
      lines.push(
        ` * @performance ${entry.label}: ~${loss.toFixed(1)}x slower than the JS baseline${scoreText(c)} ${MARKER}`,
      )
      lines.push(
        ` * @deprecated Slower than the native JS baseline (~${loss.toFixed(1)}x) — prefer the JS/Bun baseline. ${MARKER}`,
      )
    }
    if (c.drifted) {
      lines.push(
        ` * @remarks Auto-deprecated: ${c.failed}/${c.total} benchmarks failed in the latest run (static classification was ${c.entry.status}). ${MARKER}`,
      )
    } else if (c.promotable) {
      lines.push(
        ` * @remarks Promotion candidate: ${c.won}/${c.total} benchmarks won in the latest run (static: not-competitive). ${MARKER}`,
      )
    }
  } else {
    return null
  }

  if (entry.note) {
    lines.push(` * @remarks ${entry.note} ${MARKER}`)
  }
  return lines
}

const isGenerated = (line: string): boolean => line.includes(MARKER)

/**
 * Rewrite the JSDoc blocks above the target declarations in a namespace
 * interface file. Returns { changed, deprecated } for the summary.
 */
function annotateFile(
  filePath: string,
  targets: Target[],
  dryRun: boolean,
): { changed: number; deprecated: number } {
  const src = readFileSync(filePath, 'utf8')
  const lines = src.split('\n')

  const interfaceStart = lines.findIndex((l) =>
    /^\s*export interface (RustScalar|RustBatch)\s*\{/.test(l),
  )
  if (interfaceStart < 0) {
    console.error(`annotate — could not locate interface in ${filePath}`)
    return { changed: 0, deprecated: 0 }
  }

  const interfaceEnd = (() => {
    for (let i = interfaceStart + 1; i < lines.length; i++) {
      if (/^\}\s*$/.test(lines[i] ?? '')) return i
    }
    return -1
  })()
  if (interfaceEnd < 0) {
    console.error(`annotate — could not locate interface end in ${filePath}`)
    return { changed: 0, deprecated: 0 }
  }

  const byName = new Map(targets.map((t) => [t.name, t.lines]))
  const names = [...byName.keys()]

  interface Action {
    start: number // first line of the JSDoc block to replace (or the decl line when inserting)
    decl: number // declaration line (kept as-is)
    hasJdoc: boolean
    generated: string[]
  }
  const actions: Action[] = []

  let jdocStart = -1
  let jdocEnd = -1
  let inJdoc = false

  for (let i = interfaceStart + 1; i < interfaceEnd; i++) {
    // i is bounded by the validated interface range, so the element is defined.
    const line = lines[i] ?? ''

    if (!inJdoc && /^\s*\/\*\*/.test(line)) {
      jdocStart = i
      if (/\*\/\s*$/.test(line)) {
        jdocEnd = i
      } else {
        inJdoc = true
      }
      continue
    }
    if (inJdoc) {
      if (/\*\/\s*$/.test(line)) {
        jdocEnd = i
        inJdoc = false
      }
      continue
    }

    // Not inside a JSDoc block: check for a target declaration.
    const name = names.find((n) => new RegExp(`^\\s*${n}\\s*\\(`).test(line))
    if (name) {
      const generated = byName.get(name)
      if (generated) {
        const hasJdoc = jdocEnd === i - 1
        actions.push({
          start: hasJdoc ? jdocStart : i,
          decl: i,
          hasJdoc,
          generated,
        })
      }
      jdocStart = -1
      jdocEnd = -1
    }
  }

  const splices: Array<{
    start: number
    deleteCount: number
    newLines: string[]
  }> = []

  // Indent generated JSDoc to match the declaration's leading whitespace so
  // the injected blocks read as part of the interface body. Generated lines
  // already start with ` * `; prepending the indent aligns the `*` with the
  // block's other lines (e.g. `  /**` → `   * @performance ...` → `  */`).
  const padTo = (line: string, indent: string): string => `${indent}${line}`

  for (const a of actions) {
    // a.decl / a.start point at validated declaration lines within `lines`.
    const indent = lines[a.decl]?.match(/^\s*/)?.[0] ?? ''
    const generated = a.generated.map((l) => padTo(l, indent))

    if (a.hasJdoc) {
      // Replace the existing block: keep hand-written lines, drop generated
      // ones, re-append fresh generated lines before the closing `*/`.
      const block = lines.slice(a.start, a.decl).filter((l) => !isGenerated(l))
      let cleaned: string[]
      // A JSDoc written on one line (`/** ... */`) must be expanded into a
      // multi-line block so generated lines can sit inside it.
      const singleLine =
        block.length === 1 && /^\s*\/\*\*/.test(block[0] ?? '') && /\*\/\s*$/.test(block[0] ?? '')
      if (singleLine) {
        // singleLine requires block.length === 1, so block[0] is defined.
        const inner = (block[0] ?? '')
          .replace(/^\s*\/\*\*/, '')
          .replace(/\*\/\s*$/, '')
          .trim()
        cleaned = [
          `${indent}/**`,
          ...(inner ? [`${indent} * ${inner}`] : []),
          ...generated,
          `${indent} */`,
        ]
      } else {
        const closeIdx = block.findIndex((l) => l.includes('*/'))
        cleaned = []
        if (closeIdx >= 0) {
          cleaned.push(...block.slice(0, closeIdx))
          cleaned.push(...generated)
          cleaned.push(...block.slice(closeIdx))
        } else {
          cleaned.push(...block, ...generated)
        }
      }
      splices.push({
        start: a.start,
        deleteCount: a.decl - a.start,
        newLines: cleaned,
      })
    } else {
      // No JSDoc: insert a fresh block above the declaration.
      splices.push({
        start: a.decl,
        deleteCount: 0,
        newLines: [`${indent}/**`, ...generated, `${indent} */`],
      })
    }
  }

  splices.sort((x, y) => y.start - x.start)
  const work = lines.slice()
  for (const s of splices) {
    work.splice(s.start, s.deleteCount, ...s.newLines)
  }

  const next = work.join('\n')
  const deprecated = actions.filter((a) =>
    a.generated.some((l) => l.includes('@deprecated')),
  ).length

  if (next === src) {
    return { changed: 0, deprecated: 0 }
  }

  if (!dryRun) {
    writeFileSync(filePath, next, 'utf8')
  }
  return { changed: actions.length, deprecated }
}

/** Options for a programmatic annotation run (used by src/bench/run.ts). */
export interface AnnotateOptions {
  /** Path to the CPU report JSON (defaults to bench/results/cpu/latest.json). */
  reportPath?: string
  /** Print what would change without writing. */
  dryRun?: boolean
}

export interface AnnotateResult {
  files: number
  changed: number
  deprecated: number
  unmeasured: number
}

/**
 * Rewrite the `@performance` / `@deprecated` / `@remarks` JSDoc on the public
 * `rust.*` declarations from a CPU report. Returns how many files and functions
 * were touched. Throws when the report cannot be read (callers decide whether
 * that is fatal).
 */
export function annotateFromReport(options: AnnotateOptions = {}): AnnotateResult {
  const reportPath = options.reportPath ?? REPORT_PATH
  const dryRun = options.dryRun ?? false

  const report = loadReport(reportPath)
  const classified = classifySurface(PROVEN_SURFACE, report.comparisons)

  const targetsByFile = new Map<string, Target[]>()
  for (const c of classified.values()) {
    const gen = generatedLines(c)
    if (!gen) continue
    const file = fileForName(c.entry.name)
    const list = targetsByFile.get(file) ?? []
    list.push({ name: c.entry.name, lines: gen })
    targetsByFile.set(file, list)
  }
  const measuredEntries = [...targetsByFile.values()].reduce((n, t) => n + t.length, 0)

  let totalChanged = 0
  let totalDeprecated = 0

  console.log(`\n=== Annotate rust.* JSDoc from CPU report ===${dryRun ? ' (dry-run)' : ''}`)
  console.log(
    `Report: ${reportPath}\n${targetsByFile.size === 0 ? '' : `Entries with measurements: ${measuredEntries}`}\n`,
  )

  for (const [file, targets] of targetsByFile) {
    const { changed, deprecated } = annotateFile(file, targets, dryRun)
    totalChanged += changed
    totalDeprecated += deprecated
    const action = dryRun ? 'would annotate' : 'annotated'
    console.log(
      `  ${action} ${changed} function(s) in ${file}${deprecated > 0 ? ` (${deprecated} deprecated)` : ''}`,
    )
  }

  if (!report.environment?.buildFlavor) {
    console.log(
      '\nNote: the report has no buildFlavor — results (and any auto-deprecation) are build-dependent. Confirm on a release build (`bun run build`).',
    )
  }

  const unmeasured = classified.size - measuredEntries
  console.log(
    `\n${totalChanged} function(s) ${dryRun ? 'to update' : 'updated'}, ${totalDeprecated} marked @deprecated. ${unmeasured} registry entries skipped (unmeasured / no comparison).`,
  )

  return {
    files: targetsByFile.size,
    changed: totalChanged,
    deprecated: totalDeprecated,
    unmeasured,
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run')
  try {
    annotateFromReport({ dryRun })
  } catch (err) {
    console.error(`annotate — ${(err as Error).message}`)
    process.exit(2)
  }
}

/**
 * Only run the CLI when this file is the executed entry point. Importing the
 * module (e.g. from src/bench/run.ts for CASTRUM_BENCH_ANNOTATE=1) must not
 * trigger a side-effectful annotation.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(invoked)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main()
}
