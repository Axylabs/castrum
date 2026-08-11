// src/loader/cost.ts — Adaptive scalar-vs-batch cost model.
//
// Each op owns one cost model. It learns from ACTUAL dispatch timings (EWMA)
// and decides, at runtime, whether a bulk of `n` items should go through the
// packed batch path (ONE native crossing) or a scalar loop (`n` crossings).
//
//   - `n === 1` always routes to the scalar path.
//   - `n >= batchMin` routes to the batch path.
//   - `batchMin` starts at the configured value (default 2) and adapts in
//     [2, 8]: if measured batch-per-item cost stays above the scalar-per-item
//     cost, `batchMin` rises so tiny batches fall back to the scalar loop; if
//     batching wins, `batchMin` sinks back to 2.
//
// Timing is sampled (every `sampleEvery` dispatches) so the hot path does NOT
// pay a `hrtime` call on every invocation.

/** A per-op adaptive cost model. */
export interface LoaderCostModel {
  /**
   * Should a bulk of `n` items use the packed batch path?
   * `false` → scalar loop (`n` crossings).
   */
  decide(n: number): boolean;
  /** Record a scalar-path dispatch of `n` items taking `elapsedNs`. */
  recordScalar(n: number, elapsedNs: number): void;
  /** Record a batch-path dispatch of `n` items taking `elapsedNs`. */
  recordBatch(n: number, elapsedNs: number): void;
  /** Current learned batch threshold. */
  readonly batchMin: number;
  /** Snapshot for observability/tests. */
  readonly stats: {
    batchMin: number;
    scalarPerItemNs: number;
    batchPerItemNs: number;
    samples: number;
  };
}

const MIN_BATCH_MIN = 2;
const MAX_BATCH_MIN = 8;
const EWMA_ALPHA = 0.3;

function clampBatchMin(v: number): number {
  return Math.max(MIN_BATCH_MIN, Math.min(MAX_BATCH_MIN, v));
}

/** High-resolution nanosecond clock (Bun/Node). */
export const nowNs: () => number =
  typeof process !== "undefined" && typeof process.hrtime === "function"
    ? () => Number(process.hrtime.bigint())
    : () => performance.now() * 1e6;

export interface CostModelOptions {
  /** Allow the model to adjust `batchMin` from measurement. Default true. */
  adaptive?: boolean;
  /** Initial batch threshold in [2, 8]. Default 2 (batch wins for n >= 2). */
  batchMin?: number;
}

/** Build a per-op cost model. */
export function createCostModel(options: CostModelOptions = {}): LoaderCostModel {
  const adaptive = options.adaptive !== false;
  let batchMin = clampBatchMin(options.batchMin ?? MIN_BATCH_MIN);
  let scalarPerItemNs = 0;
  let batchPerItemNs = 0;
  let samples = 0;

  function ewma(prev: number, next: number): number {
    return prev === 0 ? next : prev * (1 - EWMA_ALPHA) + next * EWMA_ALPHA;
  }

  return {
    decide(n) {
      if (n <= 1) return false;
      return n >= batchMin;
    },
    recordScalar(n, elapsedNs) {
      samples++;
      const perItem = n > 0 ? elapsedNs / n : elapsedNs;
      scalarPerItemNs = ewma(scalarPerItemNs, perItem);
      if (adaptive && n >= 2 && batchPerItemNs > 0 && perItem < batchPerItemNs * 0.8) {
        batchMin = clampBatchMin(batchMin + 1);
      }
    },
    recordBatch(n, elapsedNs) {
      samples++;
      const perItem = n > 0 ? elapsedNs / n : elapsedNs;
      batchPerItemNs = ewma(batchPerItemNs, perItem);
      if (adaptive && scalarPerItemNs > 0) {
        if (perItem > scalarPerItemNs * 1.2) {
          batchMin = clampBatchMin(batchMin + 1);
        } else if (perItem < scalarPerItemNs * 0.8) {
          batchMin = clampBatchMin(batchMin - 1);
        }
      }
    },
    get batchMin() {
      return batchMin;
    },
    get stats() {
      return { batchMin, scalarPerItemNs, batchPerItemNs, samples };
    },
  };
}
