#!/usr/bin/env bun
/**
 * Repro: native BATCH APIs can corrupt their result buffer (and occasionally
 * crash Bun) under specific module/call arrangements.
 *
 * Observed 2026-08-11 on Bun `1.4.0-canary.1+827475e21` + castrum 0.8.0/0.9.0.
 * Symptom: calling e.g. `addon.queryParseBatchPacked(packed)` returns a Buffer
 * whose HEAD looks correct (count + first lengths) yet a DataView read throws
 * "RangeError: Out of bounds access" — or, with slightly different module
 * state, Bun hard-crashes inside `_tide_enter_transient` (JSC/tide GC).
 *
 * Isolated single calls work reliably; arranging several `packBatch` buffers
 * and batch calls in one module makes the result buffer appear truncated.
 * This is NOT reproduced on the scalar paths (queryParsePacked & friends are
 * byte-identical and stable). Suspect: napi-rs pooled/borrowed output buffer
 * interacting with Bun's GC/tide. Needs investigation on stable Bun + Node.
 *
 * Run: `bun scripts/repro-flux-batch.ts` (Bun only; may crash the process).
 *
 * DO NOT wire these batch APIs into production hot paths until root-caused.
 */
import { getAddon } from "../src/native";

const native = getAddon();
const enc = new TextEncoder();

function packBatch(items: Uint8Array[]): Uint8Array {
  let total = 4;
  for (const it of items) total += 4 + it.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, items.length, true);
  let pos = 4;
  for (const it of items) {
    dv.setUint32(pos, it.byteLength, true);
    pos += 4;
    out.set(it, pos);
    pos += it.byteLength;
  }
  return out;
}

function unpackByteResults(packed: Uint8Array): Uint8Array[] {
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = dv.getUint32(0, true);
  const out: Uint8Array[] = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(pos, true);
    pos += 4;
    out.push(packed.slice(pos, pos + len));
    pos += len;
  }
  return out;
}

const bigChunk = "x".repeat(64);
const query = `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}&name=Ada%20Lovelace`;
const cookies = Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(" ");
const N = 32;
const qItems = Array.from({ length: N }, () => enc.encode(query));
const cItems = Array.from({ length: N }, () => enc.encode(cookies));
const sseItems = Array.from({ length: N }, () => enc.encode(`data ${bigChunk}\n`));
const crcItems = Array.from({ length: 64 }, (_, i) => new Uint8Array(64).fill(i));

const packedQ = packBatch(qItems);
const packedC = packBatch(cItems);
const packedS = packBatch(sseItems);
const packedCrc = packBatch(crcItems);

console.log("module arranged; first batch call...");

// This is the pattern that corrupts (or crashes) under Bun canary.
const qRes = unpackByteResults(native.queryParseBatchPacked(packedQ));
console.log("query items:", qRes.length, qRes[0] ? qRes[0].length : "?");
const cRes = unpackByteResults(native.cookieParseBatchPacked(packedC));
console.log("cookie items:", cRes.length);
const sRes = unpackByteResults(native.sseEncodeBatchPacked(packedS, null, null, null));
console.log("sse items:", sRes.length);
const crcRes = unpackByteResults(native.crc32BatchPacked(packedCrc));
console.log("crc items:", crcRes.length);

console.log("(If you see a crash or 'Out of bounds access' above, the bug is reproduced.)");
