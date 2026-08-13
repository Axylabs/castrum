// src/bench/tasks/etag.ts — ETag / HTTP-date / conditional-request benchmarks.
//
// Hand-rolled JS baselines vs Rust. The `ConditionalRequest` instance is
// constructed once (per-resource etag + last-modified computed up front) and
// reused across iterations — the higher-order / compiled-once pattern.

import { rust } from '../../rust-ffi'
import { decoder } from '../../shared/bytes'
import { rawHttpDate } from '../raw-native'
import { nativeEtag, nativeHttpDate, nativeIsNotModified } from '../etag-baseline'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function etagTasks(f: BenchFixtures): BenchTask[] {
  // Per-resource state computed once; reused for every iteration.
  const etagStr = decoder.decode(rust.etag(f.etagData))
  const conditional = rust.createConditionalRequest(rust.etag(f.etagData), f.httpDateSecs)
  const inm = decoder.decode(f.ifNoneMatchHeader)
  const ims = decoder.decode(f.ifModifiedSinceHeader)

  return [
    {
      name: 'native:etag',
      run: () => nativeEtag(f.etagData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:etag',
      run: () => rust.etag(f.etagData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:http_date',
      run: () => nativeHttpDate(f.httpDateSecs).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:http_date',
      // `rust.httpDate` delegates to `Date.toUTCString()` under Bun
      // (BUN_WINS) — measure the raw addon (napi; no C-ABI export) instead.
      run: () => rawHttpDate(f.httpDateSecs).byteLength,
      iterations: 500,
      warmup: 50,
    },
    // Pooled-output variant: one reused 32-byte buffer, no per-call alloc.
    {
      name: 'rust:http_date_into',
      run: (() => {
        const out = new Uint8Array(32)
        return () => rust.httpDateInto(f.httpDateSecs, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:conditional',
      run: () => (nativeIsNotModified(etagStr, f.httpDateSecs, inm, ims) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:conditional',
      run: () => (conditional.isNotModified(f.ifNoneMatchHeader, f.ifModifiedSinceHeader) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
  ]
}
