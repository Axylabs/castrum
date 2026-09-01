// src/bench/measure.ts — CPU-bench timing/measurement helpers.

import { checksumValue } from './checksum'
import { nowMs } from './now'
import type {
  BenchResult,
  ConcurrentBenchResult,
  ConcurrentBenchTask,
  StressBenchResult,
} from './types'

const concurrentWorkerUrl = new URL('./concurrent-worker.ts', import.meta.url)

// Very fast (sub-µs) ops are dominated by per-iteration timer overhead. When
// the per-op time is below this threshold (ms), ops are measured in batches to
// reduce that overhead and report a stable avg / ops-per-second. Batch size is
// overridable via CASTRUM_BENCH_BATCH_SIZE for methodology experiments.
const FAST_OP_THRESHOLD_MS = 0.01
const FAST_OP_BATCH_SIZE = Math.max(1, Number(process.env.CASTRUM_BENCH_BATCH_SIZE) || 64)

export function bench(name: string, fn: () => unknown, iterations = 100, warmup = 10): BenchResult {
  const safeIterations = Math.max(1, iterations)
  const safeWarmup = Math.max(0, warmup)

  let checksum = 0n

  for (let i = 0; i < safeWarmup; i++) {
    checksum += checksumValue(fn())
  }

  // Probe a single op after warmup to decide whether batched measurement is
  // warranted (the probe result is not folded into the checksum).
  const probeStart = nowMs()
  void checksumValue(fn())
  const probeMs = nowMs() - probeStart

  const samples: number[] = new Array(safeIterations)

  if (probeMs < FAST_OP_THRESHOLD_MS) {
    // Batched: run FAST_OP_BATCH_SIZE ops between timer reads and attribute
    // the batch duration equally to each op. This preserves avg/ops-per-sec;
    // per-op percentiles are not meaningful at this scale anyway.
    const batch = FAST_OP_BATCH_SIZE
    const fullBatches = Math.floor(safeIterations / batch)
    const remainder = safeIterations % batch
    let idx = 0

    for (let b = 0; b < fullBatches; b++) {
      const start = nowMs()
      for (let i = 0; i < batch; i++) {
        checksum += checksumValue(fn())
      }
      const perOpMs = (nowMs() - start) / batch
      for (let i = 0; i < batch; i++) {
        samples[idx++] = perOpMs
      }
    }
    if (remainder > 0) {
      const start = nowMs()
      for (let i = 0; i < remainder; i++) {
        checksum += checksumValue(fn())
      }
      const perOpMs = (nowMs() - start) / remainder
      for (let i = 0; i < remainder; i++) {
        samples[idx++] = perOpMs
      }
    }
  } else {
    for (let i = 0; i < safeIterations; i++) {
      const start = nowMs()
      checksum += checksumValue(fn())
      samples[i] = nowMs() - start
    }
  }

  samples.sort((a, b) => a - b)

  const total = samples.reduce((a, b) => a + b, 0)
  const avg = total / safeIterations

  return {
    name,
    iterations: safeIterations,
    avgMs: avg,
    p50Ms: samples[Math.floor(safeIterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(safeIterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  }
}

export async function benchConcurrent(task: ConcurrentBenchTask): Promise<ConcurrentBenchResult> {
  const concurrency = Math.max(1, task.concurrency)
  const iterations = Math.max(1, task.iterationsPerSlot)
  const warmup = Math.max(0, task.warmupPerSlot)

  const workers: Worker[] = []

  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const worker = new Worker(concurrentWorkerUrl, { type: 'module' })
        workers.push(worker)

        await new Promise<void>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent) => {
            const msg = e.data
            if (msg?.type === 'ready') {
              resolve()
            } else if (msg?.type === 'error') {
              reject(new Error(msg.message ?? 'worker init error'))
            }
          }

          worker.onerror = (e: ErrorEvent) => {
            reject(new Error(e?.message ?? 'worker error'))
          }

          worker.postMessage({
            type: 'init',
            op: task.op,
            payload: task.payload,
            warmup,
          })
        })
      }),
    )

    const resultPromises = workers.map(
      (worker) =>
        new Promise<bigint>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent) => {
            const msg = e.data
            if (msg?.type === 'result') {
              resolve(BigInt(msg.checksum ?? '0'))
            } else if (msg?.type === 'error') {
              reject(new Error(msg.message ?? 'worker runtime error'))
            }
          }

          worker.onerror = (e: ErrorEvent) => {
            reject(new Error(e?.message ?? 'worker error'))
          }
        }),
    )

    const start = nowMs()

    for (const worker of workers) {
      worker.postMessage({
        type: 'run',
        iterations,
      })
    }

    const checksums = await Promise.all(resultPromises)
    const totalMs = nowMs() - start

    const checksum = checksums.reduce((a, b) => a + b, 0n)
    const totalOps = concurrency * iterations

    return {
      name: task.name,
      iterations,
      concurrency,
      totalOps,
      totalMs,
      avgMs: totalMs / Math.max(totalOps, 1),
      p50Ms: 0,
      p95Ms: 0,
      opsPerSec: (totalOps / Math.max(totalMs, 1e-9)) * 1000,
      checksum: checksum.toString(),
    }
  } finally {
    for (const worker of workers) {
      worker.terminate()
    }
  }
}

export function benchStress(
  name: string,
  fn: () => unknown,
  durationMs: number,
  warmupMs = 100,
): StressBenchResult {
  const safeDuration = Math.max(100, durationMs)
  const safeWarmup = Math.max(0, warmupMs)

  const warmupEnd = nowMs() + safeWarmup
  while (nowMs() < warmupEnd) {
    checksumValue(fn())
  }

  let checksum = 0n
  let ops = 0

  const start = nowMs()
  const end = start + safeDuration

  while (nowMs() < end) {
    checksum += checksumValue(fn())
    ops++
  }

  const elapsed = nowMs() - start

  return {
    name,
    durationMs: elapsed,
    totalOps: ops,
    opsPerSec: (ops / Math.max(elapsed, 1e-9)) * 1000,
    avgMs: elapsed / Math.max(ops, 1),
    checksum: checksum.toString(),
  }
}
