export interface BenchResult {
  name: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec: number;
  checksum: string;
}

export interface BenchTask {
  name: string;
  run: () => unknown;
  iterations: number;
  warmup: number;
}

export interface ComparisonReport {
  label: string;
  nativeName: string;
  rustName: string;
}
