// src/bench/report.ts — CPU-bench report writer (machine-readable JSON + markdown).

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type {
  BenchResult,
  ComparisonReport,
  ConcurrentBenchResult,
  StressBenchResult,
} from './types'
import { resolveEnvVar } from '../shared/env'

export function printResults(results: BenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      iters: r.iterations,
      'avg ms': r.avgMs.toFixed(4),
      'p50 ms': r.p50Ms.toFixed(4),
      'p95 ms': r.p95Ms.toFixed(4),
      'ops/s': r.opsPerSec.toFixed(1),
      checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  )
}

export function printConcurrentResults(results: ConcurrentBenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      concurrency: r.concurrency,
      'ops/slot': r.iterations,
      'total ops': r.totalOps,
      'total ms': r.totalMs.toFixed(2),
      'avg ms/op': r.avgMs.toFixed(6),
      'ops/s': r.opsPerSec.toFixed(1),
      checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  )
}

export function printStressResults(results: StressBenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      'duration ms': r.durationMs.toFixed(0),
      'total ops': r.totalOps,
      'ops/s': r.opsPerSec.toFixed(1),
      'avg ms': r.avgMs.toFixed(6),
      checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  )
}

function printComparison(
  results: (BenchResult | ConcurrentBenchResult | StressBenchResult)[],
  report: ComparisonReport,
): void {
  const n = results.find((x) => x.name === report.nativeName)
  const r = results.find((x) => x.name === report.rustName)

  if (!n || !r) {
    return
  }

  const nAvg = n.avgMs
  const rAvg = r.avgMs
  const ratio = nAvg / Math.max(rAvg, 1e-9)

  if (ratio >= 1) {
    console.log(
      `${report.label}: Rust ${rAvg.toFixed(4)}ms vs Native ${nAvg.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    )
  } else {
    console.log(
      `${report.label}: Rust ${rAvg.toFixed(4)}ms vs Native ${nAvg.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    )
  }
}

export function printSummary(
  results: (BenchResult | ConcurrentBenchResult | StressBenchResult)[],
  reports: ComparisonReport[],
): void {
  for (const report of reports) {
    printComparison(results, report)
  }
}

// ── Machine-readable CPU report ───────────────────────────────────
// Serializes a benchmark run to JSON so results can be committed and diffed
// across changes (bench/results/cpu/latest.json + a timestamped snapshot).
// The HTTP benchmarks already persist reports; this gives the CPU micro-bench
// suite the same property.

export interface CpuEnvironment {
  platform: string
  arch: string
  cpuModel?: string
  bun: string
  node: string
  rayonThreads?: string
  buildFlavor?: string
}

export interface CpuComparisonSummary {
  label: string
  nativeName: string
  rustName: string
  nativeAvgMs: number
  rustAvgMs: number
  ratio: number
  faster: 'rust' | 'native'
}

export interface CpuReport {
  kind: 'cpu-benchmark'
  generatedAt: string
  environment: CpuEnvironment
  standard: BenchResult[]
  complex: BenchResult[]
  concurrent: ConcurrentBenchResult[]
  stress: StressBenchResult[]
  comparisons: CpuComparisonSummary[]
}

/** Structured Rust-vs-native comparison summaries (shared with printing). */
export function computeComparisons(
  results: (BenchResult | ConcurrentBenchResult | StressBenchResult)[],
  reports: ComparisonReport[],
): CpuComparisonSummary[] {
  const out: CpuComparisonSummary[] = []
  for (const report of reports) {
    const native = results.find((x) => x.name === report.nativeName)
    const rust = results.find((x) => x.name === report.rustName)
    if (!native || !rust) {
      continue
    }
    const ratio = native.avgMs / Math.max(rust.avgMs, 1e-9)
    out.push({
      label: report.label,
      nativeName: report.nativeName,
      rustName: report.rustName,
      nativeAvgMs: native.avgMs,
      rustAvgMs: rust.avgMs,
      ratio,
      faster: ratio >= 1 ? 'rust' : 'native',
    })
  }
  return out
}

/** Best-effort CPU model name (Linux only). */
function cpuModelName(): string | undefined {
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8')
    for (const line of info.split('\n')) {
      if (line.startsWith('model name')) {
        return line.split(':')[1]?.trim() || undefined
      }
    }
  } catch {
    // /proc/cpuinfo is not available on every platform.
  }
  return undefined
}

/**
 * Persist the CPU benchmark results as JSON and return the path written.
 * Writes both a stable `latest.json` and a timestamped snapshot.
 */
export async function writeCpuReport(options: {
  standard: BenchResult[]
  complex: BenchResult[]
  concurrent: ConcurrentBenchResult[]
  stress: StressBenchResult[]
  comparisons: ComparisonReport[]
  outDir?: string
  buildFlavor?: string
}): Promise<string> {
  const outDir = options.outDir ?? 'bench/results/cpu'
  mkdirSync(outDir, { recursive: true })

  const report: CpuReport = {
    kind: 'cpu-benchmark',
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpuModelName(),
      bun: process.versions.bun ?? '',
      node: process.versions.node ?? '',
      rayonThreads: resolveEnvVar('CASTRUM_RAYON_THREADS'),
      buildFlavor: options.buildFlavor,
    },
    standard: options.standard,
    complex: options.complex,
    concurrent: options.concurrent,
    stress: options.stress,
    comparisons: computeComparisons(
      [...options.standard, ...options.complex, ...options.concurrent, ...options.stress],
      options.comparisons,
    ),
  }

  const json = JSON.stringify(report, null, 2)
  const latestPath = join(outDir, 'latest.json')
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const stampedPath = join(outDir, `${stamp}.json`)

  await writeFile(latestPath, json, 'utf8')
  await writeFile(stampedPath, json, 'utf8')
  return latestPath
}
