import { checksumValue } from "./checksum";
import { nowMs } from "./now";
import type {
  BenchResult,
  ConcurrentBenchTask,
  ConcurrentBenchResult,
  StressBenchResult,
} from "./types";

const concurrentWorkerUrl = new URL("./concurrent-worker.ts", import.meta.url);

export function bench(
  name: string,
  fn: () => unknown,
  iterations = 100,
  warmup = 10,
): BenchResult {
  const safeIterations = Math.max(1, iterations);
  const safeWarmup = Math.max(0, warmup);

  let checksum = 0n;

  for (let i = 0; i < safeWarmup; i++) {
    checksum += checksumValue(fn());
  }

  const samples: number[] = new Array(safeIterations);

  for (let i = 0; i < safeIterations; i++) {
    const start = nowMs();
    checksum += checksumValue(fn());
    samples[i] = nowMs() - start;
  }

  samples.sort((a, b) => a - b);

  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / safeIterations;

  return {
    name,
    iterations: safeIterations,
    avgMs: avg,
    p50Ms: samples[Math.floor(safeIterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(safeIterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}

export async function benchConcurrent(
  task: ConcurrentBenchTask,
): Promise<ConcurrentBenchResult> {
  const concurrency = Math.max(1, task.concurrency);
  const iterations = Math.max(1, task.iterationsPerSlot);
  const warmup = Math.max(0, task.warmupPerSlot);

  const workers: Worker[] = [];

  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const worker = new Worker(concurrentWorkerUrl, { type: "module" });
        workers.push(worker);

        await new Promise<void>((resolve, reject) => {
          worker.onmessage = (e: any) => {
            const msg = e.data;
            if (msg?.type === "ready") {
              resolve();
            } else if (msg?.type === "error") {
              reject(new Error(msg.message ?? "worker init error"));
            }
          };

          worker.onerror = (e: any) => {
            reject(new Error(e?.message ?? "worker error"));
          };

          worker.postMessage({
            type: "init",
            op: task.op,
            payload: task.payload,
            warmup,
          });
        });
      }),
    );

    const resultPromises = workers.map(
      (worker) =>
        new Promise<bigint>((resolve, reject) => {
          worker.onmessage = (e: any) => {
            const msg = e.data;
            if (msg?.type === "result") {
              resolve(BigInt(msg.checksum ?? "0"));
            } else if (msg?.type === "error") {
              reject(new Error(msg.message ?? "worker runtime error"));
            }
          };

          worker.onerror = (e: any) => {
            reject(new Error(e?.message ?? "worker error"));
          };
        }),
    );

    const start = nowMs();

    for (const worker of workers) {
      worker.postMessage({
        type: "run",
        iterations,
      });
    }

    const checksums = await Promise.all(resultPromises);
    const totalMs = nowMs() - start;

    const checksum = checksums.reduce((a, b) => a + b, 0n);
    const totalOps = concurrency * iterations;

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
    };
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

export function benchStress(
  name: string,
  fn: () => unknown,
  durationMs: number,
  warmupMs = 100,
): StressBenchResult {
  const safeDuration = Math.max(100, durationMs);
  const safeWarmup = Math.max(0, warmupMs);

  const warmupEnd = nowMs() + safeWarmup;
  while (nowMs() < warmupEnd) {
    checksumValue(fn());
  }

  let checksum = 0n;
  let ops = 0;

  const start = nowMs();
  const end = start + safeDuration;

  while (nowMs() < end) {
    checksum += checksumValue(fn());
    ops++;
  }

  const elapsed = nowMs() - start;

  return {
    name,
    durationMs: elapsed,
    totalOps: ops,
    opsPerSec: (ops / Math.max(elapsed, 1e-9)) * 1000,
    avgMs: elapsed / Math.max(ops, 1),
    checksum: checksum.toString(),
  };
}