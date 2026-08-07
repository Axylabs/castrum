// bench/startup.ts — "instant execution" measurement for Bun.
//
// Each sample runs in a FRESH `bun` process and measures:
//   1. Time to `import castrum` (module load, incl. native addon dlopen)
//   2. First native call latency (crc32)
//   3. First ingress handler construction + request latency
//
// Usage:  bun run bench:startup

import { spawnSync } from "node:child_process";

const ITERATIONS = 15;
const ROOT = new URL("../", import.meta.url).pathname;

interface Sample {
  importMs: number;
  firstCrc32Ms: number;
  firstIngressMs: number;
}

const PROBE = `
import { performance } from "node:perf_hooks";

// 1) Import the package (this is where the native addon is (d)loaded).
const t0 = performance.now();
const mod = await import(${JSON.stringify(`${ROOT}index.ts`)});
const importMs = performance.now() - t0;

const bytes = new TextEncoder().encode("hello, world");

// 2) First scalar native call.
let t = performance.now();
mod.rust.crc32(bytes);
const firstCrc32Ms = performance.now() - t;

// 3) First ingress handler construction + request.
t = performance.now();
const { createIngressFast } = await import(${JSON.stringify(`${ROOT}src/ingress/fast.ts`)});
const ingress = createIngressFast({});
const req = new Request("http://localhost/api/users", { method: "GET" });
ingress.run(req, "127.0.0.1", null, "req-1", (r) => r.status);
const firstIngressMs = performance.now() - t;

console.log(JSON.stringify({ importMs, firstCrc32Ms, firstIngressMs }));
`;

function runOnce(): Sample {
  const res = spawnSync("bun", ["-e", PROBE], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });

  if (res.status !== 0) {
    throw new Error(`startup probe failed (${res.status}): ${res.stderr}`);
  }

  const lines = res.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Sample;
}

function stats(values: number[]): { min: number; p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0]!, p50: at(0.5), p95: at(0.95) };
}

const samples: Sample[] = [];
for (let i = 0; i < ITERATIONS; i++) {
  samples.push(runOnce());
}

const fmt = (ms: number) => `${ms.toFixed(2)}ms`;

console.log("\n═══ Startup / first-call (Bun, fresh process per run) ═══");
console.log(`Iterations: ${ITERATIONS}\n`);

const rows: Array<[string, keyof Sample]> = [
  ["import (module + addon dlopen)", "importMs"],
  ["first native call (crc32)", "firstCrc32Ms"],
  ["first ingress handler + request", "firstIngressMs"],
];

for (const [name, key] of rows) {
  const s = stats(samples.map((x) => x[key]));
  console.log(
    `  ${name.padEnd(32)} min=${fmt(s.min)}  p50=${fmt(s.p50)}  p95=${fmt(s.p95)}`,
  );
}
