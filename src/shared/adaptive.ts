// src/shared/adaptive.ts — Reusable EWMA adaptive-estimate utility.
//
// The loader's cost model (src/loader/cost.ts) learns per-op dispatch costs at
// runtime with an exponential moving average (EWMA). This is that same
// machinery, extracted as a tiny reusable class so OTHER subsystems can
// self-optimize without re-implementing the math — e.g. BufferPool learns the
// observed request size to pre-size future buffers (`adaptive` option), and
// consumers can drive their own runtime decisions (batch-vs-loop, delegate
// vs-native, cache-size) with a bounded, noise-smoothed estimate.
/** Options for an `AdaptiveEstimate`: EWMA smoothing, bounds, starting value. */ export interface AdaptiveEstimateOptions {
  /**
   * EWMA smoothing factor in (0, 1]. Higher reacts faster to new samples;
   * lower smooths more. Default: 0.25.
   */
  alpha?: number
  /** Starting estimate. Default 0 (the first sample wins). */
  initial?: number
  /** Clamp the estimate to at least this. Default 0. */
  min?: number
  /** Clamp the estimate to at most this (bounds memory / resources). Default Infinity. */
  max?: number
}

/**
 * A bounded exponential-moving-average estimate of an observed quantity.
 *
 * `sample(x)` folds a new observation into the running estimate; `estimate`
 * reads the current value. The estimate is clamped to `[min, max]`, so it is
 * safe to drive resource sizing (buffer pools, batch thresholds) with it —
 * a single outlier cannot blow up the estimate, and it decays toward recent
 * observations.
 */
export class AdaptiveEstimate {
  private readonly alpha: number
  private readonly min: number
  private readonly max: number
  private readonly initial: number
  private value: number

  constructor(options: AdaptiveEstimateOptions = {}) {
    const alpha = options.alpha ?? 0.25
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new RangeError(`AdaptiveEstimate: alpha must be in (0,1], got ${alpha}`)
    }
    this.alpha = alpha
    this.min = Math.max(0, options.min ?? 0)
    this.max = options.max ?? Number.POSITIVE_INFINITY
    this.initial = options.initial ?? 0
    this.value = this.initial
  }

  /** Fold a new observation into the running estimate. */
  sample(x: number): void {
    const v = this.value === 0 ? x : this.value * (1 - this.alpha) + x * this.alpha
    this.value = v < this.min ? this.min : v > this.max ? this.max : v
  }

  /** Current estimate (clamped to `[min, max]`). */
  get estimate(): number {
    return this.value
  }

  /** Reset the estimate (back to `initial`). */
  reset(): void {
    this.value = this.initial
  }
}
