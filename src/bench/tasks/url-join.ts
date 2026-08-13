// src/bench/tasks/url-join.ts — URL resolution + query-building benchmarks.
//
// WHATWG URL baseline vs Rust. The `UrlBuilder` instance parses the base once
// and reuses it across resolves (the higher-order / compiled-once pattern).

import { rust } from '../../rust-ffi'
import { nativeUrlEncodeQuery, nativeUrlResolve } from '../url-join-baseline'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function urlJoinTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: base parsed once, reused.
  const builder = rust.createUrlBuilder(f.urlBase)

  return [
    {
      name: 'native:url_resolve',
      run: () => nativeUrlResolve(f.urlBase, f.urlReference).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:url_resolve',
      run: () => builder.resolve(f.urlReference).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'native:url_encode_query',
      run: () => nativeUrlEncodeQuery(f.urlQueryParams).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:url_encode_query',
      run: () => rust.urlEncodeQuery(f.urlQueryParams).byteLength,
      iterations: 300,
      warmup: 30,
    },
  ]
}
