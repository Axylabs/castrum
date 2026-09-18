// src/shared/metrics.ts — Zero-dependency metrics registry (counters, gauges,
// histograms) with Prometheus text-exposition rendering.
//
// This is the "enterprise observability" primitive: `createMetrics()` gives
// operators counters/histograms they can expose at a `/metrics` endpoint
// (see src/ingress/metrics.ts for the ingress wiring + route factory). No
// external deps — matches the codebase's zero-runtime-dependency ethos; an
// OpenTelemetry exporter can wrap the same registry later.

/** Default histogram buckets (Prometheus-style, seconds). */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

/**
 * Per-family cap on the number of distinct label sets (series) retained by a
 * single counter/gauge/histogram. A metrics registry is keyed by caller-supplied
 * label values, so an unbounded label (e.g. a raw path or user id) would grow a
 * `Map` without limit. At the cap the oldest half of that family is evicted
 * (insertion order) and the count is accumulated into the synthetic counter
 * `castrum_metrics_series_dropped_total`, making the loss observable instead of
 * silent. That name is RESERVED — a caller declaring a counter/gauge/histogram
 * with it suppresses the synthetic emission (see {@link SERIES_DROPPED_METRIC}).
 */
export const MAX_SERIES_PER_METRIC = 10_000

/**
 * Reserved exposition name of the synthetic counter reporting series evicted by
 * {@link MAX_SERIES_PER_METRIC}. Callers must not register a metric family with
 * this name; if one exists, `render()` skips the synthetic emission so the
 * scrape never carries two `# HELP`/`# TYPE` lines for one family (Prometheus
 * rejects that).
 */
const SERIES_DROPPED_METRIC = 'castrum_metrics_series_dropped_total'

type LabelValues = readonly string[]
type Labels = Readonly<Record<string, string>>

/** Stable key for a label set (sorted for deterministic exposition). */
function labelKey(names: readonly string[], values: LabelValues): string {
  if (names.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < names.length; i++) {
    parts.push(`${names[i]}="${escapeLabel(values[i] ?? '')}"`)
  }
  return parts.join(',')
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Once a series map is at {@link MAX_SERIES_PER_METRIC}, evict its oldest half
 * (insertion order) and return the keys dropped; returns `[]` below the cap.
 * Mirrors Elysia's `evictOldestHalf` generational policy: halving at the cap
 * amortizes the eviction cost instead of paying a delete per insertion.
 */
function evictOldestHalf<K, V>(map: Map<K, V>): K[] {
  if (map.size < MAX_SERIES_PER_METRIC) return []
  const drop = Math.ceil(map.size / 2)
  const dropped: K[] = []
  for (const key of map.keys()) {
    if (dropped.length >= drop) break
    dropped.push(key)
  }
  for (const key of dropped) map.delete(key)
  return dropped
}

/** A single labelled counter value. */
export interface Counter {
  /** Increment by 1 (or `by`). `labels` must match the label names exactly. */
  inc(labels?: Labels, by?: number): void
}

/** A single labelled gauge value (can go up and down). */
export interface Gauge {
  inc(labels?: Labels, by?: number): void
  dec(labels?: Labels, by?: number): void
  set(labels: Labels | undefined, value: number): void
}

/** A single labelled histogram. */
export interface Histogram {
  /** Record one observation. `labels` must match the label names exactly. */
  observe(value: number, labels?: Labels): void
}

/** The metrics registry factory. */
export interface MetricsRegistry {
  /** Create (or fetch) a counter. `help` is only used on first creation. */
  counter(name: string, help: string, labelNames?: readonly string[]): Counter
  /** Create (or fetch) a gauge. */
  gauge(name: string, help: string, labelNames?: readonly string[]): Gauge
  /**
   * Create (or fetch) a histogram. `buckets`/`help` only apply on first
   * creation; later calls with the same name return the existing histogram.
   */
  histogram(
    name: string,
    help: string,
    buckets?: readonly number[],
    labelNames?: readonly string[],
  ): Histogram
  /** Render the Prometheus text exposition format. */
  render(): string
  /** Reset all metrics (for tests / interval rotation). */
  reset(): void
}

interface CounterEntry {
  name: string
  help: string
  labelNames: string[]
  values: Map<string, number>
}
interface GaugeEntry {
  name: string
  help: string
  labelNames: string[]
  values: Map<string, number>
}
interface HistogramEntry {
  name: string
  help: string
  labelNames: string[]
  buckets: number[]
  /** le bucket index -> cumulative count per label set. */
  counts: Map<string, number[]>
  sums: Map<string, number>
}

/** Create a fresh metrics registry. */
export function createMetrics(): MetricsRegistry {
  const counters = new Map<string, CounterEntry>()
  const gauges = new Map<string, GaugeEntry>()
  const histograms = new Map<string, HistogramEntry>()
  /** Series evicted by the per-family cardinality cap, rendered as a counter. */
  let seriesDropped = 0

  const bucketUpper = (buckets: number[]): number[] => [
    ...buckets.map((b) => b),
    Number.POSITIVE_INFINITY,
  ]

  const renderCounter = (e: CounterEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} counter`]
    for (const [key, value] of e.values) {
      lines.push(key ? `${e.name}{${key}} ${value}` : `${e.name} ${value}`)
    }
    return lines
  }

  const renderGauge = (e: GaugeEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} gauge`]
    for (const [key, value] of e.values) {
      lines.push(key ? `${e.name}{${key}} ${value}` : `${e.name} ${value}`)
    }
    return lines
  }

  const renderHistogram = (e: HistogramEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} histogram`]
    const upper = bucketUpper(e.buckets)
    for (const [key, counts] of e.counts) {
      const sum = e.sums.get(key) ?? 0
      const baseSuffix = key ? `{${key}}` : ''
      for (let i = 0; i < upper.length; i++) {
        const le = upper[i]
        const leLabel = le === Number.POSITIVE_INFINITY ? '+Inf' : String(le)
        const v = counts[i] ?? 0
        // `le` merges INTO the label set (Prometheus requires one brace group).
        const full = key ? `${key},le="${leLabel}"` : `le="${leLabel}"`
        lines.push(`${e.name}_bucket{${full}} ${v}`)
      }
      lines.push(`${e.name}_sum${baseSuffix} ${sum}`)
      lines.push(`${e.name}_count${baseSuffix} ${counts[counts.length - 1] ?? 0}`)
    }
    return lines
  }

  const render = (): string => {
    const out: string[] = []
    for (const e of counters.values()) out.push(...renderCounter(e))
    for (const e of gauges.values()) out.push(...renderGauge(e))
    for (const e of histograms.values()) out.push(...renderHistogram(e))
    // Only emitted once a family has actually overflowed, so the output for a
    // well-behaved registry is byte-identical to before the cap existed. Guard
    // against a caller-registered family of the same (reserved) name — two
    // `# HELP`/`# TYPE` lines for one family make the scrape invalid.
    if (
      seriesDropped > 0 &&
      !counters.has(SERIES_DROPPED_METRIC) &&
      !gauges.has(SERIES_DROPPED_METRIC) &&
      !histograms.has(SERIES_DROPPED_METRIC)
    ) {
      out.push(
        `# HELP ${SERIES_DROPPED_METRIC} Total metric series evicted by the per-family cardinality cap.`,
      )
      out.push(`# TYPE ${SERIES_DROPPED_METRIC} counter`)
      out.push(`${SERIES_DROPPED_METRIC} ${seriesDropped}`)
    }
    return `${out.join('\n')}\n`
  }

  const reset = (): void => {
    counters.clear()
    gauges.clear()
    histograms.clear()
    seriesDropped = 0
  }

  return {
    counter(name, help, labelNames = []) {
      // Capture a guaranteed non-null entry (first creation wins; later calls
      // with the same name return the existing counter).
      const existing = counters.get(name)
      const entry: CounterEntry = existing ?? {
        name,
        help,
        labelNames: [...labelNames],
        values: new Map(),
      }
      if (!existing) counters.set(name, entry)
      const names = entry.labelNames
      return {
        inc(labels, by = 1) {
          const key = labelKey(
            names,
            names.map((n) => labels?.[n] ?? ''),
          )
          const prev = entry.values.get(key)
          if (prev === undefined) {
            // New series: make room first (bounded family) and count evictions.
            seriesDropped += evictOldestHalf(entry.values).length
            entry.values.set(key, by)
          } else {
            entry.values.set(key, prev + by)
          }
        },
      }
    },

    gauge(name, help, labelNames = []) {
      const existing = gauges.get(name)
      const entry: GaugeEntry = existing ?? {
        name,
        help,
        labelNames: [...labelNames],
        values: new Map(),
      }
      if (!existing) gauges.set(name, entry)
      const names = entry.labelNames
      const keyOf = (labels?: Labels): string =>
        labelKey(
          names,
          names.map((n) => labels?.[n] ?? ''),
        )
      const add = (labels: Labels | undefined, delta: number): void => {
        const key = keyOf(labels)
        const prev = entry.values.get(key)
        if (prev === undefined) {
          seriesDropped += evictOldestHalf(entry.values).length
          entry.values.set(key, delta)
        } else {
          entry.values.set(key, prev + delta)
        }
      }
      return {
        inc(labels, by = 1) {
          add(labels, by)
        },
        dec(labels, by = 1) {
          add(labels, -by)
        },
        set(labels, value) {
          if (!entry.values.has(keyOf(labels))) {
            seriesDropped += evictOldestHalf(entry.values).length
          }
          entry.values.set(keyOf(labels), value)
        },
      }
    },

    histogram(name, help, buckets = DEFAULT_BUCKETS, labelNames = []) {
      const existing = histograms.get(name)
      const entry: HistogramEntry = existing ?? {
        name,
        help,
        labelNames: [...labelNames],
        buckets: [...buckets].sort((a, b) => a - b),
        counts: new Map(),
        sums: new Map(),
      }
      if (!existing) histograms.set(name, entry)
      const names = entry.labelNames
      return {
        observe(value, labels) {
          const key = labelKey(
            names,
            names.map((n) => labels?.[n] ?? ''),
          )
          let counts = entry.counts.get(key)
          if (!counts) {
            // New series: bound the family and drop the matching sum entries
            // (counts and sums always share the same key set).
            const dropped = evictOldestHalf(entry.counts)
            for (const k of dropped) entry.sums.delete(k)
            seriesDropped += dropped.length
            // One slot per bucket PLUS the implicit +Inf slot.
            counts = new Array<number>(entry.buckets.length + 1).fill(0)
            entry.counts.set(key, counts)
          }
          // Cumulative count per upper bound, including the implicit +Inf
          // bucket (every value falls in it).
          for (let i = 0; i < counts.length; i++) {
            const bound =
              i < entry.buckets.length ? (entry.buckets[i] as number) : Number.POSITIVE_INFINITY
            if (value <= bound) counts[i] = (counts[i] ?? 0) + 1
          }
          entry.sums.set(key, (entry.sums.get(key) ?? 0) + value)
        },
      }
    },

    render,
    reset,
  }
}
