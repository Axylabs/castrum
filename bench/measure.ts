// bench/measure.ts — shared micro-benchmark timing helpers (ns/op, min-of-5).
//
// Extracted from the cost/margin benches so their timing methodology cannot
// drift: warm up a fraction of the batch, then report the best (min) of 5
// timed batches as ns/op.

/**
 * Measure a hot synchronous function as nanoseconds per op (min-of-5 after
 * warmup).
 *
 * @param fn The op to time (must be a synchronous closure).
 * @param iterations Ops per timed batch (batch sub-µs ops up).
 * @returns Best batch's ns/op.
 */
export function measureNs(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.max(iterations / 20, 1); i++) fn()
  let best = Infinity
  for (let b = 0; b < 5; b++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    const ns = ((performance.now() - start) * 1e6) / iterations
    if (ns < best) best = ns
  }
  return best
}

/**
 * Async sibling of {@link measureNs} for `async` ops (e.g. body-stream reads).
 *
 * @param fn The op to time (must return a promise).
 * @param iterations Ops per timed batch.
 * @returns Best batch's ns/op.
 */
export async function measureNsAsync(
  fn: () => Promise<unknown>,
  iterations: number,
): Promise<number> {
  for (let i = 0; i < Math.max(iterations / 20, 1); i++) await fn()
  let best = Infinity
  for (let b = 0; b < 5; b++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) await fn()
    const ns = ((performance.now() - start) * 1e6) / iterations
    if (ns < best) best = ns
  }
  return best
}
