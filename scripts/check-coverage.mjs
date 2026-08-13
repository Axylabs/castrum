// scripts/check-coverage.mjs — run `bun test --coverage` and enforce floors.
//
// CI gate. Two guards:
//   1. OVERALL floor: fails if total LINE coverage drops below MIN_LINE_COVERAGE
//      (a safety net so coverage can't silently collapse as the codebase grows).
//   2. PER-DIRECTORY floor on the SHIPPED api dirs: fails if any shipped source
//      directory's average line coverage drops below DIR_MIN_LINE_COVERAGE.
//      The overall floor alone lets one directory collapse while others
//      compensate; this closes that hole for the code users actually import.
//
// Internal (non-shipped) dirs — src/baseline, src/bench, src/data — are
// excluded from the per-directory floor (bench/reference code, not shipped).
//
// Usage: `bun run test:coverage` (== `node scripts/check-coverage.mjs`).

import { spawnSync } from 'node:child_process'

/** Minimum overall line coverage (percent). */
const MIN_LINE_COVERAGE = 75
/** Minimum per-directory average line coverage for SHIPPED source dirs. */
const DIR_MIN_LINE_COVERAGE = 50

/** Shipped source dirs that must not collapse individually. */
const SHIPPED_DIRS = new Set([
  'src/ingress',
  'src/shared',
  'src/rust-ffi',
  'src/native',
  'src/loader',
  'src/integration',
])

const { stdout, stderr, status } = spawnSync('bun', ['test', '--coverage'], { encoding: 'utf8' })

// bun writes the coverage table to stderr when stdout is not a TTY (as in
// this script / CI), so parse the combined output.
const combined = `${stdout ?? ''}\n${stderr ?? ''}`

if (status !== 0) {
  process.stderr.write(`\`bun test --coverage\` failed.\n\n${combined}`)
  process.exit(status ?? 1)
}

// ── Overall floor ────────────────────────────────────────────────────
// Parse the "All files" summary row:
//   All files | <funcs>% | <lines>% | <uncovered>
const summary = combined.split('\n').find((line) => line.trim().startsWith('All files'))
if (!summary) {
  process.stderr.write(
    "Could not find the 'All files' coverage summary in bun test --coverage output.\n",
  )
  process.exit(1)
}

const lineCoverage = Number(summary.split('|')[2]?.trim().replace('%', ''))
if (!Number.isFinite(lineCoverage)) {
  process.stderr.write(`Could not parse line coverage from: ${summary}\n`)
  process.exit(1)
}

console.log(`Coverage: ${lineCoverage.toFixed(2)}% lines (floor ${MIN_LINE_COVERAGE}%)`)
if (lineCoverage < MIN_LINE_COVERAGE) {
  process.stderr.write(
    `Coverage ${lineCoverage.toFixed(2)}% is below the ${MIN_LINE_COVERAGE}% floor. ` +
      'Add tests before growing the untested surface.\n',
  )
  process.exit(1)
}

// ── Per-directory floor (shipped dirs only) ──────────────────────────
// Each per-file row: `<path> | <funcs>% | <lines>% | <uncovered lines>`.
const perDir = new Map() // dir -> { sum, count }
for (const line of combined.split('\n')) {
  // Per-file rows look like: ` src/ingress/body.ts | 66.67 | 85.39 | 14,78`
  // (no % sign in the per-file table — unlike the "All files" summary).
  const m = line.match(/^\s*(\S+\.ts)\s+\|\s+[\d.]+\s+\|\s+([\d.]+)/)
  if (!m) continue
  const path = m[1]
  const parts = path.split('/')
  if (parts[0] !== 'src' || parts.length < 3) continue
  const dir = `${parts[0]}/${parts[1]}`
  if (!SHIPPED_DIRS.has(dir)) continue
  const pct = Number(m[2])
  if (!Number.isFinite(pct)) continue
  const acc = perDir.get(dir) ?? { sum: 0, count: 0 }
  acc.sum += pct
  acc.count += 1
  perDir.set(dir, acc)
}

let dirOk = true
for (const [dir, acc] of [...perDir.entries()].sort()) {
  const avg = acc.sum / acc.count
  const ok = avg >= DIR_MIN_LINE_COVERAGE
  if (!ok) dirOk = false
  console.log(
    `  ${ok ? 'ok ' : 'FAIL'} ${dir.padEnd(18)} avg ${avg.toFixed(1)}% ` +
      `(${acc.count} files, floor ${DIR_MIN_LINE_COVERAGE}%)`,
  )
}

if (!dirOk) {
  process.stderr.write(
    `\nA shipped source directory fell below the ${DIR_MIN_LINE_COVERAGE}% ` +
      'per-directory floor. Add tests for that directory before merging.\n',
  )
  process.exit(1)
}
