import { batchBytes, hashBytes, productAddBytes } from "./data";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DURATION_MS = Number(process.env.DURATION_MS ?? 5_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);

const addBody = productAddBytes();
const batchBody = batchBytes(100);
const hashBody = hashBytes(100_000);

type HttpCase = {
  name: string;
  fn: () => Promise<Response>;
};

const cases: HttpCase[] = [
  {
    name: "native:POST /native/products/add",
    fn: () =>
      fetch(`${BASE}/native/products/add`, {
        method: "POST",
        body: addBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },
  {
    name: "rust:POST /rust/products/add",
    fn: () =>
      fetch(`${BASE}/rust/products/add`, {
        method: "POST",
        body: addBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },

  {
    name: "native:GET /native/products/123",
    fn: () => fetch(`${BASE}/native/products/123`),
  },
  {
    name: "rust:GET /rust/products/123",
    fn: () => fetch(`${BASE}/rust/products/123`),
  },

  {
    name: "native:POST /native/batch",
    fn: () =>
      fetch(`${BASE}/native/batch`, {
        method: "POST",
        body: batchBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },
  {
    name: "rust:POST /rust/batch",
    fn: () =>
      fetch(`${BASE}/rust/batch`, {
        method: "POST",
        body: batchBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },

  {
    name: "native:POST /native/hash",
    fn: () =>
      fetch(`${BASE}/native/hash`, {
        method: "POST",
        body: hashBody,
      }),
  },
  {
    name: "rust:POST /rust/hash",
    fn: () =>
      fetch(`${BASE}/rust/hash`, {
        method: "POST",
        body: hashBody,
      }),
  },

  {
    name: "native:POST /native/sha256",
    fn: () =>
      fetch(`${BASE}/native/sha256`, {
        method: "POST",
        body: hashBody,
      }),
  },
  {
    name: "rust:POST /rust/sha256",
    fn: () =>
      fetch(`${BASE}/rust/sha256`, {
        method: "POST",
        body: hashBody,
      }),
  },
];

type Stats = {
  count: number;
  errors: number;
  samples: number[];
};

async function worker(
  fn: () => Promise<Response>,
  endAt: number,
  stats: Stats,
): Promise<void> {
  while (Date.now() < endAt) {
    const start = performance.now();

    try {
      const res = await fn();
      await res.arrayBuffer();

      stats.count++;
      stats.samples.push(performance.now() - start);
    } catch {
      stats.errors++;
    }
  }
}

async function runWorkers(
  fn: () => Promise<Response>,
  durationMs: number,
  concurrency: number,
): Promise<Stats> {
  const stats: Stats = {
    count: 0,
    errors: 0,
    samples: [],
  };

  const endAt = Date.now() + durationMs;

  await Promise.all(
    Array.from({ length: concurrency }, () => worker(fn, endAt, stats)),
  );

  return stats;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const index = Math.floor(samples.length * p);
  return samples[Math.min(index, samples.length - 1)] ?? 0;
}

async function benchHttp(caseItem: HttpCase): Promise<void> {
  console.log(`\nBenchmarking ${caseItem.name}`);

  await runWorkers(caseItem.fn, 500, Math.min(10, CONCURRENCY));

  const stats = await runWorkers(caseItem.fn, DURATION_MS, CONCURRENCY);

  stats.samples.sort((a, b) => a - b);

  const totalMs = DURATION_MS;
  const avg =
    stats.samples.length > 0
      ? stats.samples.reduce((a, b) => a + b, 0) / stats.samples.length
      : 0;

  console.log({
    name: caseItem.name,
    requests: stats.count,
    errors: stats.errors,
    reqPerSec: (stats.count / (totalMs / 1000)).toFixed(2),
    avgMs: avg.toFixed(3),
    p50Ms: percentile(stats.samples, 0.5).toFixed(3),
    p95Ms: percentile(stats.samples, 0.95).toFixed(3),
    p99Ms: percentile(stats.samples, 0.99).toFixed(3),
  });
}

for (const caseItem of cases) {
  await benchHttp(caseItem);
}