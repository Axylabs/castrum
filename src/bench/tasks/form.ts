// src/bench/tasks/form.ts — Form-urlencoded body parsing benchmarks.
//
// Native (URLSearchParams baseline) vs Rust (form_parse_packed / FormParser).
// The `FormParser` instance is constructed ONCE at task setup (buffer
// allocation is a one-time cost) and reused across iterations — the
// higher-order / compiled-once pattern.

import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import { nativeFormParseBatchLen, nativeFormParsePacked } from '../form-baseline'
import type { BenchTask } from '../types'

export function formTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: setup once, reuse across iterations.
  const parser = rust.createFormParser(8192)

  return [
    {
      name: 'native:form_parse',
      run: () => nativeFormParsePacked(f.formBody).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:form_parse',
      run: () => parser.parse(f.formBody).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:form_parse_scalar',
      run: () => rust.formParsePacked(f.formBody).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:form_parse_batch',
      run: () => nativeFormParseBatchLen(f.formBodies),
      iterations: 50,
      warmup: 5,
    },
    {
      name: 'rust:form_parse_batch',
      run: () => {
        const results = rust.batch.formParse(f.formBodies)
        let total = 0
        for (const r of results) total += r.byteLength
        return total
      },
      iterations: 50,
      warmup: 5,
    },
  ]
}
