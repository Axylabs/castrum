// src/bench/tasks/media-type.ts — Content-Type / media type parsing benchmarks.
//
// Hand-rolled JS baseline vs Rust parse_media_type (MediaTypeParser instance,
// constructed once at setup and reused across iterations).

import { rust } from '../../rust-ffi'
import { decoder } from '../../shared/bytes'
import type { BenchFixtures } from '../fixtures'
import { nativeParseMediaType } from '../media-type-baseline'
import type { BenchTask } from '../types'

export function mediaTypeTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: constructed once, reused across iterations.
  const parser = rust.createMediaTypeParser()

  return [
    {
      name: 'native:media_type_parse',
      run: () => nativeParseMediaType(decoder.decode(f.contentTypeMultipart)).mediaType.length,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:media_type_parse',
      run: () => parser.parse(f.contentTypeMultipart).mediaType.length,
      iterations: 300,
      warmup: 30,
    },
  ]
}
