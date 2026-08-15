// src/bench/tasks/encoding.ts — base64 / hex encode-decode benchmarks.
//
// Buffer (JS native) baseline vs Rust. The `Base64Codec` instance is
// constructed once (config fixed) and reused across iterations.

import { Buffer } from 'node:buffer'
import { rust } from '../../rust-ffi'
import { encoder } from '../../shared/bytes'
import {
  nativeBase64Decode,
  nativeBase64Encode,
  nativeHexDecode,
  nativeHexEncode,
} from '../encoding-baseline'
import type { BenchFixtures } from '../fixtures'
import { rawHexEncode } from '../raw-native'
import type { BenchTask } from '../types'

export function encodingTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: config compiled once, reused.
  const codec = rust.createBase64Codec()
  const base64Sample = encoder.encode(Buffer.from(f.encodeData).toString('base64'))
  const hexSample = encoder.encode(Buffer.from(f.encodeData).toString('hex'))

  return [
    {
      name: 'native:base64_encode',
      run: () => nativeBase64Encode(f.encodeData).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:base64_encode',
      run: () => codec.encode(f.encodeData).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'native:base64_decode',
      run: () => nativeBase64Decode(base64Sample).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:base64_decode',
      run: () => codec.decode(base64Sample).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'native:hex_encode',
      run: () => nativeHexEncode(f.encodeData).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:hex_encode',
      // RAW addon accessor — the public `rust.hexEncode` delegates to Bun's
      // `Buffer.toString('hex')` under Bun (BUN_WINS), so it would measure the
      // built-in, not the addon (see src/bench/raw-native.ts).
      run: () => rawHexEncode(f.encodeData).length,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'native:hex_decode',
      run: () => nativeHexDecode(hexSample).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:hex_decode',
      run: () => rust.hexDecode(hexSample).byteLength,
      iterations: 300,
      warmup: 30,
    },
    // Pooled-output variant: one reused buffer, no per-call Vec+Buffer alloc.
    {
      name: 'rust:hex_encode_into',
      run: (() => {
        const out = new Uint8Array(256)
        return () => rust.hexEncodeInto(f.encodeData, out)
      })(),
      iterations: 300,
      warmup: 30,
    },
  ]
}
