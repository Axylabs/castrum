// bench/ffi-public.ts — verify the Bun ffi fast path is live on the public
// `rust.*` API and measure the real end-to-end crossing win.
// Run: bun run bench/ffi-public.ts
import { rust } from "../index";
import { getBunFFI } from "../src/native/ffi";

const ffi = getBunFFI();
console.log("bun:ffi fast path active:", ffi !== null);

const encoder = new TextEncoder();
const data = encoder.encode("the quick brown fox jumps over the lazy dog 1234567890");
const big = encoder.encode("the quick brown fox jumps over the lazy dog 1234567890".repeat(100));

function bench(name: string, fn: () => unknown, n = 50_000, trials = 7) {
  for (let i = 0; i < 3_000; i++) fn();
  let best = Infinity;
  for (let t = 0; t < trials; t++) {
    if ((Bun as any).gc) (Bun as any).gc();
    const start = performance.now();
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, ((performance.now() - start) / n) * 1e3);
  }
  console.log(`${name.padEnd(40)} ${best.toFixed(3).padStart(9)} µs`);
}

console.log("");
console.log("── public rust.* API (ffi active on Bun) ──");
bench("rust.crc32 (small)", () => rust.crc32(data));
bench("rust.fnv1a64 (small)", () => rust.fnv1a64(data));
bench("rust.xxh3 (small)", () => rust.xxh3(data));
bench("rust.jsonValid (small)", () => rust.jsonValid(data));
bench("rust.hexEncode (small)", () => rust.hexEncode(data).length);
bench("rust.hexEncode (5.4KiB)", () => rust.hexEncode(big).length);
bench("rust.urlEncode (small)", () => rust.urlEncode(data).length);

// Correctness: ffi results must equal napi results.
import { getAddon } from "../src/native";
const addon = getAddon();
console.log("");
console.log("crc32 ffi===napi:", rust.crc32(data) === addon.crc32(data));
console.log("fnv1a64 ffi===napi:", rust.fnv1a64(data) === addon.fnv1a64(data));
console.log("xxh3 ffi===napi:", rust.xxh3(data) === addon.xxh3(data));
console.log("jsonValid ffi===napi:", rust.jsonValid(data) === addon.jsonValid(data));
console.log("hexEncode ffi===napi:", rust.hexEncode(data) === new TextDecoder().decode(addon.hexEncode(data)));
console.log("urlEncode ffi===napi:", rust.urlEncode(data) === new TextDecoder().decode(addon.urlEncode(data)));
