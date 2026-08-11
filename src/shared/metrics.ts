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
];

type LabelValues = readonly string[];
type Labels = Readonly<Record<string, string>>;

/** Stable key for a label set (sorted for deterministic exposition). */
function labelKey(names: readonly string[], values: LabelValues): string {
  if (names.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < names.length; i++) {
    parts.push(`${names[i]}="${escapeLabel(values[i] ?? "")}"`);
  }
  return parts.join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** A single labelled counter value. */
export interface Counter {
  /** Increment by 1 (or `by`). `labels` must match the label names exactly. */
  inc(labels?: Labels, by?: number): void;
}

/** A single labelled gauge value (can go up and down). */
export interface Gauge {
  inc(labels?: Labels, by?: number): void;
  dec(labels?: Labels, by?: number): void;
  set(labels: Labels | undefined, value: number): void;
}

/** A single labelled histogram. */
export interface Histogram {
  /** Record one observation. `labels` must match the label names exactly. */
  observe(value: number, labels?: Labels): void;
}

/** The metrics registry factory. */
export interface MetricsRegistry {
  /** Create (or fetch) a counter. `help` is only used on first creation. */
  counter(
    name: string,
    help: string,
    labelNames?: readonly string[],
  ): Counter;
  /** Create (or fetch) a gauge. */
  gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
  /**
   * Create (or fetch) a histogram. `buckets`/`help` only apply on first
   * creation; later calls with the same name return the existing histogram.
   */
  histogram(
    name: string,
    help: string,
    buckets?: readonly number[],
    labelNames?: readonly string[],
  ): Histogram;
  /** Render the Prometheus text exposition format. */
  render(): string;
  /** Reset all metrics (for tests / interval rotation). */
  reset(): void;
}

interface CounterEntry {
  name: string;
  help: string;
  labelNames: string[];
  values: Map<string, number>;
}
interface GaugeEntry {
  name: string;
  help: string;
  labelNames: string[];
  values: Map<string, number>;
}
interface HistogramEntry {
  name: string;
  help: string;
  labelNames: string[];
  buckets: number[];
  /** le bucket index -> cumulative count per label set. */
  counts: Map<string, number[]>;
  sums: Map<string, number>;
}

/** Create a fresh metrics registry. */
export function createMetrics(): MetricsRegistry {
  const counters = new Map<string, CounterEntry>();
  const gauges = new Map<string, GaugeEntry>();
  const histograms = new Map<string, HistogramEntry>();

  const bucketUpper = (buckets: number[]): number[] => [
    ...buckets.map((b) => b),
    Number.POSITIVE_INFINITY,
  ];

  const renderCounter = (e: CounterEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} counter`];
    for (const [key, value] of e.values) {
      lines.push(
        key ? `${e.name}{${key}} ${value}` : `${e.name} ${value}`,
      );
    }
    return lines;
  };

  const renderGauge = (e: GaugeEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} gauge`];
    for (const [key, value] of e.values) {
      lines.push(key ? `${e.name}{${key}} ${value}` : `${e.name} ${value}`);
    }
    return lines;
  };

  const renderHistogram = (e: HistogramEntry): string[] => {
    const lines = [`# HELP ${e.name} ${e.help}`, `# TYPE ${e.name} histogram`];
    const upper = bucketUpper(e.buckets);
    for (const [key, counts] of e.counts) {
      const sum = e.sums.get(key) ?? 0;
      const baseSuffix = key ? `{${key}}` : "";
      for (let i = 0; i < upper.length; i++) {
        const le = upper[i];
        const leLabel = le === Number.POSITIVE_INFINITY ? "+Inf" : String(le);
        const v = counts[i] ?? 0;
        // `le` merges INTO the label set (Prometheus requires one brace group).
        const full = key ? `${key},le="${leLabel}"` : `le="${leLabel}"`;
        lines.push(`${e.name}_bucket{${full}} ${v}`);
      }
      lines.push(`${e.name}_sum${baseSuffix} ${sum}`);
      lines.push(`${e.name}_count${baseSuffix} ${counts[counts.length - 1] ?? 0}`);
    }
    return lines;
  };

  const render = (): string => {
    const out: string[] = [];
    for (const e of counters.values()) out.push(...renderCounter(e));
    for (const e of gauges.values()) out.push(...renderGauge(e));
    for (const e of histograms.values()) out.push(...renderHistogram(e));
    return `${out.join("\n")}\n`;
  };

  const reset = (): void => {
    counters.clear();
    gauges.clear();
    histograms.clear();
  };

  return {
    counter(name, help, labelNames = []) {
      // Capture a guaranteed non-null entry (first creation wins; later calls
      // with the same name return the existing counter).
      const existing = counters.get(name);
      const entry: CounterEntry =
        existing ?? { name, help, labelNames: [...labelNames], values: new Map() };
      if (!existing) counters.set(name, entry);
      const names = entry.labelNames;
      return {
        inc(labels, by = 1) {
          const key = labelKey(names, names.map((n) => labels?.[n] ?? ""));
          entry.values.set(key, (entry.values.get(key) ?? 0) + by);
        },
      };
    },

    gauge(name, help, labelNames = []) {
      const existing = gauges.get(name);
      const entry: GaugeEntry =
        existing ?? { name, help, labelNames: [...labelNames], values: new Map() };
      if (!existing) gauges.set(name, entry);
      const names = entry.labelNames;
      const keyOf = (labels?: Labels): string =>
        labelKey(names, names.map((n) => labels?.[n] ?? ""));
      return {
        inc(labels, by = 1) {
          entry.values.set(keyOf(labels), (entry.values.get(keyOf(labels)) ?? 0) + by);
        },
        dec(labels, by = 1) {
          entry.values.set(keyOf(labels), (entry.values.get(keyOf(labels)) ?? 0) - by);
        },
        set(labels, value) {
          entry.values.set(keyOf(labels), value);
        },
      };
    },

    histogram(name, help, buckets = DEFAULT_BUCKETS, labelNames = []) {
      const existing = histograms.get(name);
      const entry: HistogramEntry =
        existing ?? {
          name,
          help,
          labelNames: [...labelNames],
          buckets: [...buckets].sort((a, b) => a - b),
          counts: new Map(),
          sums: new Map(),
        };
      if (!existing) histograms.set(name, entry);
      const names = entry.labelNames;
      return {
        observe(value, labels) {
          const key = labelKey(names, names.map((n) => labels?.[n] ?? ""));
          let counts = entry.counts.get(key);
          if (!counts) {
            // One slot per bucket PLUS the implicit +Inf slot.
            counts = new Array<number>(entry.buckets.length + 1).fill(0);
            entry.counts.set(key, counts);
          }
          // Cumulative count per upper bound, including the implicit +Inf
          // bucket (every value falls in it).
          for (let i = 0; i < counts.length; i++) {
            const bound =
              i < entry.buckets.length
                ? (entry.buckets[i] as number)
                : Number.POSITIVE_INFINITY;
            if (value <= bound) counts[i] = (counts[i] ?? 0) + 1;
          }
          entry.sums.set(key, (entry.sums.get(key) ?? 0) + value);
        },
      };
    },

    render,
    reset,
  };
}
