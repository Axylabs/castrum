// src/bench/types.ts — CPU-bench shared types (task, report, comparison).

export interface BenchResult {
  name: string
  iterations: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  opsPerSec: number
  checksum: string
}

export interface ConcurrentBenchResult {
  name: string
  iterations: number
  concurrency: number
  totalOps: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  opsPerSec: number
  checksum: string
}

export interface StressBenchResult {
  name: string
  durationMs: number
  totalOps: number
  opsPerSec: number
  avgMs: number
  checksum: string
}

export interface BenchTask {
  name: string
  run: () => unknown
  iterations: number
  warmup: number
}

export interface ConcurrentBenchTask {
  name: string
  op: string
  payload: unknown
  concurrency: number
  iterationsPerSlot: number
  warmupPerSlot: number
}

export interface StressBenchTask {
  name: string
  run: () => unknown
  durationMs: number
  warmupMs: number
}

export interface ComparisonReport {
  label: string
  nativeName: string
  rustName: string
}
