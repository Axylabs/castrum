// src/bench/now.ts — timestamp helper for CPU-bench reporting.

export function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000
}
