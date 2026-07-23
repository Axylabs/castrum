import { checksumValue } from "./checksum";
import { nowMs } from "./now";
import type { BenchResult } from "./types";

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
