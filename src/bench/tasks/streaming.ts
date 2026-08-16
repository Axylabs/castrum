// src/bench/tasks/streaming.ts — CPU benchmark tasks: SSE event framing.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function streamingTasks(f: BenchFixtures): BenchTask[] {
  // Pre-compute a frame to decode (same bytes for both impls).
  const wsFrame = native.nativeWsFrameEncode(0x2, f.wsPayload, true, true)

  return [
    {
      name: 'native:ws_frame_encode',
      run: () => native.nativeWsFrameEncode(0x2, f.wsPayload, true, true).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:ws_frame_encode',
      run: () => rust.wsFrameEncode(0x2, f.wsPayload, true, true).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:ws_frame_decode',
      run: () => native.nativeWsFrameDecode(wsFrame)?.payload.byteLength ?? 0,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:ws_frame_decode',
      run: () => rust.wsFrameDecode(wsFrame)?.payload.byteLength ?? 0,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:sse_encode',
      run: () => native.nativeSseEncodeEvent('update', f.sseData, '42', 3000).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:sse_encode',
      run: () => rust.sseEncodeEvent('update', f.sseData, '42', 3000).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ]
}
