// bench/ffi-worker-script.ts — worker body for bench/ffi-workers.ts.
// Runs the bun:ffi fast path in a worker thread and posts the results (or an
// error) back to the parent.
import { rust } from "../index";
import { getAddon } from "../src/native";
import { getBunFFI } from "../src/native/ffi";

try {
  const addon = getAddon();
  const encoder = new TextEncoder();
  const data = encoder.encode("worker load probe the quick brown fox 1234567890");
  const out = new Uint8Array(data.length * 2);

  const ffiActive = getBunFFI() !== null;

  // warmup (absorbs the one-time ffi bind per worker)
  for (let i = 0; i < 2000; i++) {
    rust.crc32(data);
    rust.hexEncodeInto(data, out);
  }

  // correctness cross-check ffi vs napi
  const crcOk = rust.crc32(data) === addon.crc32(data);
  const hexOk =
    rust.hexEncodeInto(data, out) === data.length * 2 &&
    new TextDecoder().decode(out) ===
      new TextDecoder().decode(addon.hexEncode(data));

  // timed throughput
  const n = 200000;
  let s = Bun.nanoseconds();
  for (let i = 0; i < n; i++) rust.crc32(data);
  const crcNs = (Bun.nanoseconds() - s) / n;

  s = Bun.nanoseconds();
  for (let i = 0; i < n; i++) rust.hexEncodeInto(data, out);
  const hexNs = (Bun.nanoseconds() - s) / n;

  postMessage({ ok: true, ffiActive, crcOk, hexOk, crcNs, hexNs });
} catch (err) {
  postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
