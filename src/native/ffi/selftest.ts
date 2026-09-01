// src/native/ffi/selftest.ts — bind-time self-test for the bun:ffi transport.
//
// Every bound function is checked against known-good vectors at bind time. If
// ANY check fails (ABI mismatch, platform quirk, a future Bun regression), the
// whole ffi layer is disabled and the caller falls back to the napi addon —
// the public API never sees a wrong result. `bun:ffi` is experimental; this is
// the safety net. New C-ABI symbols MUST be added to the self-test for their
// domain: each check lives in the same `ffi/build/` file where the method is
// bound (`selfTestCodecs` / `selfTestCompress` / `selfTestParse` /
// `selfTestInstances` / `selfTestMetrics`), and this entry point ANDs them
// together so any single failure disables the whole layer.

import { selfTestCodecs } from './build/codecs'
import { selfTestCompress } from './build/compress'
import { selfTestInstances } from './build/instances'
import { selfTestMetrics } from './build/metrics'
import { selfTestParse } from './build/parse'
import type { BunFFI } from './types'

/** Verify every bound function against known-good results; false disables ffi. */
export function selfTest(b: BunFFI): boolean {
  return (
    selfTestCodecs(b) &&
    selfTestCompress(b) &&
    selfTestParse(b) &&
    selfTestInstances(b) &&
    selfTestMetrics(b)
  )
}
