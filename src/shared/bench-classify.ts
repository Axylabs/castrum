/**
 * src/shared/bench-classify.ts — Pure benchmark classification for PROVEN_SURFACE.
 *
 * Given the CPU report's `comparisons` array and the static PROVEN_SURFACE
 * registry, compute per-function live classification: aggregate all of a
 * function's benchmark tasks (the canonical comparison plus its `_`-suffixed
 * variants that no other registry entry claims), score each task pass/fail,
 * and derive:
 *
 *   - `live`       status purely from the latest report (majority-fail rule)
 *   - `effective`  hybrid status the JSDoc annotator and the audit use:
 *                  a clear MAJORITY of task losses overrides the static
 *                  status and auto-deprecates the function, while a single
 *                  good run never auto-promotes a "not-competitive" function
 *                  (static classifications reflect the shipped release build).
 *   - `promotable` static "not-competitive" but live majority WIN (ratio >= 1)
 *   - `won`/`failed`/`total` — the score embedded in the generated JSDoc.
 *
 * Task bands: won = ratio >= 1 (rust at least as fast), failed = ratio <
 * 1/LOSS_TOLERANCE (clear loss), middle = tie (counts toward neither).
 *
 * PURE DATA — imports only the registry (no addon, no `rust` client), so it is
 * unit-testable and shared by scripts/annotate-performance.ts and
 * scripts/check-proven.ts (one source of truth for classification).
 */

import { PROVEN_SURFACE, type PerformanceStatus, type ProvenEntry } from './proven'

/** A "proven"/"parity" function whose baseline is more than this much faster is a clear loss. */
export const LOSS_TOLERANCE = 1.35
/** A "not-competitive" function that wins by more than this is a promotion candidate. */
export const PROMOTE_TOLERANCE = 1.5

/** One measured rust-vs-baseline comparison from the CPU report. */
export interface Comparison {
  label: string
  nativeName: string
  rustName: string
  nativeAvgMs: number
  rustAvgMs: number
  ratio: number
  faster: 'rust' | 'native'
}

/** Pass/fail outcome for one of a function's benchmark tasks. */
export interface TaskOutcome {
  rustName: string
  label: string
  ratio: number
  /** True when rust is at least as fast (ratio >= 1) — a genuine win. */
  won: boolean
  /** True when rust is a CLEAR loss (ratio < 1 / LOSS_TOLERANCE) — the deprecation signal. */
  failed: boolean
  /** False for the registry's canonical rustTask; true for aggregated variants. */
  isVariant: boolean
}

/** One function's live benchmark classification (aggregated task outcomes). */
export interface ClassifiedEntry {
  entry: ProvenEntry
  tasks: TaskOutcome[]
  total: number
  /** Tasks where rust is at least as fast (ratio >= 1). */
  won: number
  /** Tasks where rust is a clear loss (ratio < 1 / LOSS_TOLERANCE). */
  failed: number
  /** True when a clear majority of the function's benchmarks lose (failed > total/2). */
  majorityFail: boolean
  /** True when a clear majority of the function's benchmarks win (won > total/2). */
  majorityWin: boolean
  /**
   * Ratio to display in JSDoc: the worst task when majority-failing (honest
   * "this loses" number), otherwise the canonical comparison, else the median.
   */
  ratio: number | undefined
  /** Status derived purely from the latest report. */
  live: PerformanceStatus
  /** Hybrid status the annotator/audit should act on (majority-fail overrides static). */
  effective: PerformanceStatus
  /** Live results contradict the static classification (majority fail on a proven/parity fn). */
  drifted: boolean
  /** Static "not-competitive" that now majority-wins (keep deprecated, add a note). */
  promotable: boolean
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Every rustTask claimed by any registry entry (prevents cross-entry variant theft). */
function defaultClaimed(): Set<string> {
  return new Set(PROVEN_SURFACE.map((e) => e.rustTask).filter(Boolean))
}

/**
 * Classify a single registry entry against the report's comparisons.
 *
 * `claimedRustTasks` is the set of rustTasks owned by OTHER registry entries;
 * a variant comparison is aggregated only when no other entry claims it (e.g.
 * `rust:jwt_sign_bytes` belongs to `jwtSignBytes`, not `jwtSign`).
 */
export function classifyEntry(
  entry: ProvenEntry,
  comparisons: Comparison[],
  claimedRustTasks: ReadonlySet<string> = defaultClaimed(),
): ClassifiedEntry {
  const unmeasured: ClassifiedEntry = {
    entry,
    tasks: [],
    total: 0,
    won: 0,
    failed: 0,
    majorityFail: false,
    majorityWin: false,
    ratio: undefined,
    live: 'unmeasured',
    effective: 'unmeasured',
    drifted: false,
    promotable: false,
  }
  if (!entry.rustTask) return unmeasured

  const tasks: TaskOutcome[] = []
  for (const c of comparisons) {
    const isCanonical = c.rustName === entry.rustTask
    const isVariant =
      !isCanonical &&
      !claimedRustTasks.has(c.rustName) &&
      c.rustName.startsWith(`${entry.rustTask}_`)
    if (isCanonical || isVariant) {
      // Three-band classification (honest, noise-resistant): a task is WON when
      // rust is at least as fast (ratio >= 1), FAILED when rust clearly loses
      // (ratio < 1 / LOSS_TOLERANCE), and a TIE in between. The middle band
      // counts toward neither majority, so marginal losses can never produce a
      // false win (e.g. a stale PROMOTABLE flag for a function that never
      // actually beat its baseline).
      tasks.push({
        rustName: c.rustName,
        label: c.label,
        ratio: c.ratio,
        won: c.ratio >= 1,
        failed: c.ratio < 1 / LOSS_TOLERANCE,
        isVariant: !isCanonical,
      })
    }
  }

  const total = tasks.length
  if (total === 0) return unmeasured

  const won = tasks.filter((t) => t.won).length
  const failed = tasks.filter((t) => t.failed).length
  const majorityFail = failed * 2 > total
  const majorityWin = won * 2 > total

  const canonical = tasks.find((t) => !t.isVariant)
  const ratio = majorityFail
    ? Math.min(...tasks.map((t) => t.ratio))
    : (canonical?.ratio ?? median(tasks.map((t) => t.ratio)))

  const live: PerformanceStatus = majorityFail
    ? 'not-competitive'
    : majorityWin
      ? 'proven'
      : 'parity'

  // Hybrid effective status: a clear majority of losses overrides the static
  // registry (auto-deprecate); otherwise the static classification stands —
  // classifications reflect the shipped release build, not one local run.
  const effective: PerformanceStatus =
    entry.status !== 'unmeasured' && majorityFail ? 'not-competitive' : entry.status

  return {
    entry,
    tasks,
    total,
    won,
    failed,
    majorityFail,
    majorityWin,
    ratio,
    live,
    effective,
    drifted: entry.status !== 'unmeasured' && effective !== entry.status,
    promotable: entry.status === 'not-competitive' && majorityWin,
  }
}

/** Classify every registry entry (single source of truth for the audit + annotator). */
export function classifySurface(
  entries: readonly ProvenEntry[],
  comparisons: Comparison[],
): Map<string, ClassifiedEntry> {
  const claimed = new Set(entries.map((e) => e.rustTask).filter(Boolean))
  const out = new Map<string, ClassifiedEntry>()
  for (const entry of entries) {
    out.set(entry.name, classifyEntry(entry, comparisons, claimed))
  }
  return out
}

/** Human ratio summary: "3.18x rust" / "2.34x baseline". */
export function formatRatio(ratio: number): string {
  if (ratio >= 1) return `${ratio.toFixed(2)}x rust`
  return `${(1 / ratio).toFixed(2)}x baseline`
}
