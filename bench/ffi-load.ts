// bench/ffi-load.ts — compare the THREE native-call paths under sustained load:
//   NAPI  (the fallback/reference — raw napi addon via getAddon())
//   FFI   (the PRIMARY transport on Bun — public rust.* routes through bun:ffi)
//   Native Bun (Bun's built-in implementations)
//
// For each ffi-routed function it measures:
//   - throughput (ops/sec) over a sustained tight loop (min-of-trials)
//   - latency percentiles (p50/p95/p999) under that sustained load
// at small / medium / large input sizes.
//
// Run: bun run bench/ffi-load.ts
import { rust } from "../index";
import { getAddon } from "../src/native";
import { getBunFFI } from "../src/native/ffi";

const addon = getAddon();
const ffi = getBunFFI();
console.log("bun:ffi fast path active:", ffi !== null);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Input fixtures ───────────────────────────────────────────────
const SMALL = encoder.encode("Hello, practical CRC32 checksum test data! hello world & foo=bar");
const MEDIUM = encoder.encode("the quick brown fox jumps over the lazy dog 1234567890 ".repeat(20));
const LARGE = encoder.encode("the quick brown fox jumps over the lazy dog 1234567890 ".repeat(1280));
const jsonSmall = encoder.encode("{\"a\":1,\"b\":[true,null,\"x\"]}");
const jsonLarge = encoder.encode(
  JSON.stringify(
    Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user_${i}`, active: i % 2 === 0 })),
  ),
);

const sizes = { small: SMALL, medium: MEDIUM, large: LARGE };

// ── Native Bun baselines (called the way a real caller would) ────
const bunHash = (Bun as any).hash;
const nativePaths = {
  crc32: (d: Uint8Array) => bunHash.crc32(d) as number,
  fnv1a64: (d: Uint8Array) => bunHash.wyhash(d) as number,
  xxh3: (d: Uint8Array) => Number(bunHash.xxHash3(d)) as number,
  jsonValid: (d: Uint8Array) => {
    try {
      JSON.parse(d as unknown as string);
      return true;
    } catch {
      return false;
    }
  },
  hexEncode: (d: Uint8Array) => Buffer.from(d).toString("hex").length as number,
  urlEncode: (d: Uint8Array) => encodeURIComponent(decoder.decode(d)).length as number,
};

// The FFI (public rust.*) and NAPI paths for the same functions.
const ffiPaths = {
  crc32: (d: Uint8Array) => rust.crc32(d) as number,
  fnv1a64: (d: Uint8Array) => Number(rust.fnv1a64(d)) as number,
  xxh3: (d: Uint8Array) => Number(rust.xxh3(d)) as number,
  jsonValid: (d: Uint8Array) => rust.jsonValid(d) as boolean,
  hexEncode: (d: Uint8Array) => rust.hexEncode(d).length as number,
  urlEncode: (d: Uint8Array) => rust.urlEncode(d).length as number,
};
const napiPaths = {
  crc32: (d: Uint8Array) => addon.crc32(d) as number,
  fnv1a64: (d: Uint8Array) => Number(addon.fnv1a64(d)) as number,
  xxh3: (d: Uint8Array) => Number(addon.xxh3(d)) as number,
  jsonValid: (d: Uint8Array) => addon.jsonValid(d) as boolean,
  hexEncode: (d: Uint8Array) => addon.hexEncode(d).length as number,
  urlEncode: (d: Uint8Array) => addon.urlEncode(d).length as number,
};

// Pooled _into variants (caller-provided output buffer — no per-call alloc).
const hexOut = { small: new Uint8Array(SMALL.length * 2), medium: new Uint8Array(MEDIUM.length * 2), large: new Uint8Array(LARGE.length * 2) };
const napiHexInto = (d: Uint8Array, k: keyof typeof sizes) => addon.hexEncodeInto(d, hexOut[k]) as number;
const ffiHexInto = (d: Uint8Array, k: keyof typeof sizes) => rust.hexEncodeInto(d, hexOut[k]) as number;

interface Measure {
  opsPerSec: number;
  p50: number;
  p95: number;
  p999: number;
}

function measure(fn: () => number | boolean, n: number, trials = 5): Measure {
  // warmup (also absorbs the one-time ffi bind + JIT)
  for (let i = 0; i < Math.min(n, 2000); i++) fn();
  let bestOps = 0;
  let p50 = 0, p95 = 0, p999 = 0;
  for (let t = 0; t < trials; t++) {
    if ((Bun as any).gc) (Bun as any).gc();
    const start = Bun.nanoseconds();
    for (let i = 0; i < n; i++) fn();
    const elapsedNs = Bun.nanoseconds() - start;
    const ops = (n * 1e9) / elapsedNs;
    if (ops > bestOps) bestOps = ops;
    // per-call latency histogram on the best trial
    if (t === trials - 1) {
      const lat = new Float64Array(Math.min(n, 50_000));
      const m = lat.length;
      for (let i = 0; i < m; i++) {
        const s = Bun.nanoseconds();
        fn();
        lat[i] = Bun.nanoseconds() - s;
      }
      lat.sort();
      p50 = lat[(m * 0.5) | 0]!;
      p95 = lat[(m * 0.95) | 0]!;
      p999 = lat[(m * 0.999) | 0]!;
    }
  }
  return { opsPerSec: bestOps, p50, p95, p999 };
}

function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(0);
}

function ns(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(2) + "µs";
  return n.toFixed(0) + "ns";
}

interface Case {
  name: string;
  napi?: (d: Uint8Array) => number | boolean;
  ffi?: (d: Uint8Array) => number | boolean;
  native?: (d: Uint8Array) => number | boolean;
  input: Uint8Array;
  iters: number;
}

const cases: Case[] = [
  { name: "crc32", napi: napiPaths.crc32, ffi: ffiPaths.crc32, native: nativePaths.crc32, input: SMALL, iters: 200_000 },
  { name: "crc32 (large 64K)", napi: napiPaths.crc32, ffi: ffiPaths.crc32, native: nativePaths.crc32, input: LARGE, iters: 20_000 },
  { name: "fnv1a64", napi: napiPaths.fnv1a64, ffi: ffiPaths.fnv1a64, native: nativePaths.fnv1a64, input: SMALL, iters: 200_000 },
  { name: "xxh3", napi: napiPaths.xxh3, ffi: ffiPaths.xxh3, native: nativePaths.xxh3, input: SMALL, iters: 200_000 },
  { name: "jsonValid", napi: napiPaths.jsonValid, ffi: ffiPaths.jsonValid, native: nativePaths.jsonValid, input: jsonSmall, iters: 100_000 },
  { name: "jsonValid (200 rows)", napi: napiPaths.jsonValid, ffi: ffiPaths.jsonValid, native: nativePaths.jsonValid, input: jsonLarge, iters: 50_000 },
  { name: "hexEncode", napi: napiPaths.hexEncode, ffi: ffiPaths.hexEncode, native: nativePaths.hexEncode, input: MEDIUM, iters: 100_000 },
  { name: "hexEncodeInto (pooled)", napi: (d) => napiHexInto(d, "medium"), ffi: (d) => ffiHexInto(d, "medium"), input: MEDIUM, iters: 100_000 },
  { name: "urlEncode", napi: napiPaths.urlEncode, ffi: ffiPaths.urlEncode, native: nativePaths.urlEncode, input: SMALL, iters: 100_000 },
];

console.log("");
console.log("═══ NAPI vs bun:ffi vs native Bun — under sustained load ═══");
console.log("(ops/sec = sustained throughput, latency = per-call under that load)");
console.log("");

for (const c of cases) {
  const rows: Array<[string, Measure]> = [];
  if (c.napi) rows.push(["NAPI ", measure(() => c.napi!(c.input), c.iters)]);
  if (c.ffi) rows.push(["FFI  ", measure(() => c.ffi!(c.input), c.iters)]);
  if (c.native) rows.push(["Bun  ", measure(() => c.native!(c.input), c.iters)]);

  // best ops/sec among the measured paths for a relative ranking
  const best = Math.max(...rows.map(([, m]) => m.opsPerSec));

  console.log(`── ${c.name} (${c.input.length}B, ${fmt(c.iters)} iters) ──`);
  for (const [label, m] of rows) {
    const rel = m.opsPerSec / best;
    const bar = "█".repeat(Math.round(rel * 20));
    console.log(
      `  ${label} ${fmt(m.opsPerSec).padStart(8)} ops/s  ${String((rel * 100).toFixed(0)).padStart(3)}% ${bar.padEnd(20)}  p50=${ns(m.p50).padStart(7)} p95=${ns(m.p95).padStart(7)} p999=${ns(m.p999).padStart(7)}`,
    );
  }
  // ratio of the two rust paths
  const ffiRow = rows.find(([l]) => l === "FFI  ");
  const napiRow = rows.find(([l]) => l === "NAPI ");
  if (ffiRow && napiRow) {
    console.log(
      `  → FFI vs NAPI: ${(napiRow[1].opsPerSec / ffiRow[1].opsPerSec).toFixed(2)}x faster; FFI vs native Bun: ${
        rows.some(([l]) => l === "Bun  ") ? (rows.find(([l]) => l === "Bun  ")![1].opsPerSec / ffiRow[1].opsPerSec).toFixed(2) : "n/a"
      }x`,
    );
  }
  console.log("");
}
