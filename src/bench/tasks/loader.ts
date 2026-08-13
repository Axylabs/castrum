// src/bench/tasks/loader.ts — Loader (HFC) benchmark tasks.
//
// Three signals:
//   1. `rust:loader_single_*` — the loader's single-item path must be ≈ the
//      direct scalar call (no wrapper regression).
//   2. `rust:loader_bulk_*` — bulk through the loader = ONE packed native
//      crossing.
//   3. `native:loader_naive_*` — the per-item scalar-loop baseline (N native
//      crossings) that bulk coalescing replaces. This is the "reduce the
//      function calls" headline comparison.
//
// The loader instance here is created with `adaptive: false` so the batch
// decision is deterministic for measurement (n >= batchMin=2 → packed batch).

import { rust } from '../../rust-ffi'
import { createLoader } from '../../loader'
import { encoder } from '../../shared/bytes'
import { nowMs } from '../now'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComplexFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function loaderTasks(c: ComplexFixtures): BenchTask[] {
  // Deterministic batch path for measurement (no runtime threshold learning).
  const l = createLoader({ adaptive: false })
  const isEmail = l('validateEmail')
  const crc = l('crc32')
  const jsonValid = l('jsonValid')
  const hmac = l('hmacSha256')
  const adaptiveEmail = createLoader()('validateEmail') // adaptive: true (default)
  const email0 = c.batchEmails[0] ?? encoder.encode('fallback@example.com')
  const token0 = c.batchTokens[0] ?? encoder.encode('token')

  return [
    // ── Single item: loader scalar path vs direct scalar ──
    {
      name: 'rust:loader_single_validate_email',
      run: () => (isEmail(email0) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:loader_single_crc32',
      run: () => crc(token0),
      iterations: 1000,
      warmup: 100,
    },

    // ── Bulk: one packed batch call ──
    {
      name: 'rust:loader_bulk_validate_email',
      run: () => isEmail(c.batchEmails).reduce((acc, b) => acc + b, 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:loader_bulk_hmac_sha256',
      run: () => hmac(c.batchTokens, c.batchSecret).reduce((acc, b) => acc + b.byteLength, 0),
      iterations: 200,
      warmup: 20,
    },

    // ── Naive per-item scalar-crossing baseline (what bulk replaces) ──
    {
      name: 'native:loader_naive_validate_email',
      run: () => c.batchEmails.reduce((acc, e) => acc + (rust.validateEmail(e) ? 1 : 0), 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:loader_naive_hmac_sha256',
      run: () =>
        c.batchTokens.reduce((acc, t) => acc + rust.hmacSha256(c.batchSecret, t).byteLength, 0),
      iterations: 200,
      warmup: 20,
    },

    // ── Bulk on more ops: one packed batch call vs per-item scalar loop ──
    {
      name: 'rust:loader_bulk_crc32',
      run: () => crc(c.batchTokens).reduce((acc, v) => acc + v, 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:loader_naive_crc32',
      run: () => c.batchTokens.reduce((acc, t) => acc + rust.crc32(t), 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:loader_bulk_json_valid',
      run: () => jsonValid(c.batchJsonDocs).reduce((acc, b) => acc + b, 0),
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'native:loader_naive_json_valid',
      run: () => c.batchJsonDocs.reduce((acc, doc) => acc + (rust.jsonValid(doc) ? 1 : 0), 0),
      iterations: 200,
      warmup: 20,
    },

    // ── Adaptive (learning on): dispatch overhead vs the pinned loader ──
    {
      name: 'rust:loader_adaptive_bulk_email',
      run: () => adaptiveEmail(c.batchEmails).reduce((acc, b) => acc + b, 0),
      iterations: 1000,
      warmup: 100,
    },

    // ── Expanded-op bulk coverage: one packed call vs per-item scalar loop ──
    {
      name: 'rust:loader_bulk_fnv1a64',
      run: () => l('fnv1a64')(c.batchTokens).reduce((acc, v) => acc + v, 0n),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:loader_naive_fnv1a64',
      run: () => c.batchTokens.reduce((acc, t) => acc + rust.fnv1a64(t), 0n),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:loader_bulk_etag',
      run: () => l('etag')(c.batchTokens).reduce((acc, b) => acc + b.byteLength, 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:loader_naive_etag',
      run: () => c.batchTokens.reduce((acc, t) => acc + rust.etag(t).byteLength, 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:loader_bulk_base64url',
      run: () => l('base64UrlEncode')(c.batchTokens).reduce((acc, b) => acc + b.byteLength, 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:loader_naive_base64url',
      run: () => c.batchTokens.reduce((acc, t) => acc + rust.base64UrlEncode(t).byteLength, 0),
      iterations: 1000,
      warmup: 100,
    },
  ]
}

/** Result of one async loader microbenchmark. */
export interface LoaderAsyncResult {
  name: string
  rounds: number
  itemsPerRound: number
  totalOps: number
  totalMs: number
  opsPerSec: number
  nsPerOp: number
  checksum: number
}

/**
 * Async loader microbenchmarks — `load()` coalescing + LRU cache-hit.
 *
 * `bench`/`benchStress` are synchronous, so the async `load()` path is measured
 * here directly. The rows are honest END-TO-END numbers for the async `load()`
 * API: one Promise + microtask (and, when caching, one `fnv1a64` key crossing
 * and one LRU lookup) per load — overhead the raw scalar baselines below do
 * NOT pay. That is why `coalesced_load` is ~1.4µs/op for a sub-µs op like
 * `validateEmail`: the JS async machinery dominates the native work, not the
 * FFI. Coalescing pays off when the native op is expensive — see #5 vs #6.
 *
 *   1. `rust:loader_coalesced_load`        — N same-tick `load()` calls → 1
 *      packed native call per round (coalescing + key cost + promises).
 *   1b. `rust:loader_coalesced_load_nocache` — same, `{ cache: false }`: no key
 *      crossing, no LRU — isolates the pure coalescer/async cost.
 *   2. `native:loader_scalar_loop`         — N direct scalar crossings per round
 *      (the workload coalescing replaces).
 *   3. `rust:loader_cache_hit`             — repeated identical `load()` (cache
 *      hit: fnv1a64 key + promise + microtask, no native compute).
 *   4. `native:loader_single_recalc`       — one direct scalar recompute per op
 *      (the cache-hit comparison baseline).
 *   5. `rust:loader_coalesced_gzip`        — expensive-op coalescing
 *      (gzipCompress), where per-call JS overhead is dwarfed by native work.
 *   6. `native:loader_scalar_gzip`         — per-item scalar gzipCompress
 *      baseline.
 */
export async function runLoaderAsyncBenchmarks(
  c: ComplexFixtures,
  rounds = 200,
  n = 100,
): Promise<LoaderAsyncResult[]> {
  const l = createLoader({ adaptive: false })
  const isEmail = l('validateEmail')
  const emails = c.batchEmails.slice(0, n)
  const firstEmail = emails[0] as Uint8Array

  // 1. Coalesced load(): N same-tick loads → ONE packed batch call per round.
  let checksumA = 0
  const startA = nowMs()
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.all(emails.map((e) => isEmail.load(e)))
    for (const ok of results) checksumA += ok ? 1 : 0
  }
  const totalMsA = nowMs() - startA

  // 1b. Coalesced load() with caching DISABLED: no key crossing, no LRU. If
  //     this ≈ #1, the coalesced-load cost is async machinery (promise +
  //     microtask + flush), not the key/cache; if much lower, the key/cache
  //     dominated #1.
  let checksumG = 0
  const startG = nowMs()
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.all(emails.map((e) => isEmail.load(e, { cache: false })))
    for (const ok of results) checksumG += ok ? 1 : 0
  }
  const totalMsG = nowMs() - startG

  // 2. Direct scalar baseline: N crossings per round (no key, no promises).
  let checksumB = 0
  const startB = nowMs()
  for (let r = 0; r < rounds; r++) {
    for (const e of emails) checksumB += rust.validateEmail(e) ? 1 : 0
  }
  const totalMsB = nowMs() - startB

  // 3. Cache hit: repeat an identical pre-warmed load.
  await isEmail.load(firstEmail) // warm the key
  let checksumC = 0
  const startC = nowMs()
  for (let r = 0; r < rounds; r++) {
    checksumC += (await isEmail.load(firstEmail)) ? 1 : 0
  }
  const totalMsC = nowMs() - startC

  // 4. Single scalar recompute (cache-hit comparison baseline).
  let checksumD = 0
  const startD = nowMs()
  for (let r = 0; r < rounds; r++) {
    checksumD += rust.validateEmail(firstEmail) ? 1 : 0
  }
  const totalMsD = nowMs() - startD

  // 5. Expensive-op coalescing: gzipCompress load() → one packed call/round.
  const gzip = l('gzipCompress')
  const compressItems = c.batchCompressItems.slice(0, n)
  let checksumE = 0
  const startE = nowMs()
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.all(compressItems.map((item) => gzip.load(item)))
    for (const out of results) checksumE += out.byteLength
  }
  const totalMsE = nowMs() - startE

  // 6. Expensive-op scalar baseline.
  let checksumF = 0
  const startF = nowMs()
  for (let r = 0; r < rounds; r++) {
    for (const item of compressItems) {
      checksumF += rust.gzipCompress(item).byteLength
    }
  }
  const totalMsF = nowMs() - startF

  const make = (
    name: string,
    totalMs: number,
    totalOps: number,
    checksum: number,
  ): LoaderAsyncResult => ({
    name,
    rounds,
    itemsPerRound: n,
    totalOps,
    totalMs,
    opsPerSec: (totalOps / Math.max(totalMs, 1e-9)) * 1000,
    nsPerOp: (totalMs * 1e6) / Math.max(totalOps, 1),
    checksum,
  })

  return [
    make('rust:loader_coalesced_load', totalMsA, rounds * n, checksumA),
    make('rust:loader_coalesced_load_nocache', totalMsG, rounds * n, checksumG),
    make('native:loader_scalar_loop', totalMsB, rounds * n, checksumB),
    make('rust:loader_cache_hit', totalMsC, rounds, checksumC),
    make('native:loader_single_recalc', totalMsD, rounds, checksumD),
    make('rust:loader_coalesced_gzip', totalMsE, rounds * n, checksumE),
    make('native:loader_scalar_gzip', totalMsF, rounds * n, checksumF),
  ]
}

/**
 * Persist the async loader microbenchmarks (coalescing + cache-hit) so
 * cross-run comparisons are reproducible. The async `load()` path doesn't fit
 * the sync CPU-report schema, so it gets its own gitignored report
 * (`bench/results/loader/latest.json`), like the CPU report.
 */
export function writeLoaderReport(results: LoaderAsyncResult[]): string {
  const outDir = 'bench/results/loader'
  mkdirSync(outDir, { recursive: true })
  const report = {
    kind: 'loader-benchmark',
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: process.versions.bun ?? '',
      node: process.versions.node ?? '',
    },
    results,
  }
  const json = JSON.stringify(report, null, 2)
  const latestPath = join(outDir, 'latest.json')
  writeFileSync(latestPath, json, 'utf8')
  return latestPath
}
