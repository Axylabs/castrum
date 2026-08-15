// src/bench/tasks/into.ts — pooled zero-alloc `*Into` FFI benchmarks.
//
// The `rust.<op>Into(...)` variants write straight into a caller-supplied
// buffer (no per-call Vec + Uint8Array alloc), so a REUSED pooled buffer makes
// the bun:ffi crossing the ONLY per-call cost. These are the closest the
// public API gets to "pure native" call cost, and quantify the residual
// FFI-vs-native margin for their allocating siblings (the `native:` baselines
// live in their own task files — comparisons.ts pairs them here).
//
// Bench-only: never shipped (src/bench is outside the public entry).

import { Buffer } from 'node:buffer'
import { rust } from '../../rust-ffi'
import { encoder } from '../../shared/bytes'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function intoTasks(f: BenchFixtures): BenchTask[] {
  const base64Sample = encoder.encode(Buffer.from(f.encodeData).toString('base64'))
  const hexSample = encoder.encode(Buffer.from(f.encodeData).toString('hex'))
  return [
    {
      name: 'rust:base64_encode_into',
      run: (() => {
        const out = new Uint8Array(4096)
        return () => rust.base64EncodeInto(f.encodeData, out)
      })(),
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:base64_decode_into',
      run: (() => {
        const out = new Uint8Array(4096)
        return () => rust.base64DecodeInto(base64Sample, out)
      })(),
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:hex_decode_into',
      run: (() => {
        const out = new Uint8Array(4096)
        return () => rust.hexDecodeInto(hexSample, out)
      })(),
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:etag_into',
      run: (() => {
        const out = new Uint8Array(32)
        return () => rust.etagInto(f.etagData, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:hmac_sha256_into',
      run: (() => {
        const out = new Uint8Array(64)
        return () => rust.hmacSha256Into(f.hmacKey, f.hmacData, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:sign_cookie_into',
      run: (() => {
        const out = new Uint8Array(256)
        return () => rust.signCookieInto(f.cookieValue, f.cookieSecret, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:aead_encrypt_into',
      run: (() => {
        const out = new Uint8Array(256)
        return () => rust.aeadEncryptInto(f.aeadKey, f.aeadNonce, f.aeadPlaintext, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:ws_frame_encode_into',
      run: (() => {
        const out = new Uint8Array(256)
        return () => rust.wsFrameEncodeInto(1, f.wsPayload, false, true, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:gzip_compress_into',
      run: (() => {
        const out = new Uint8Array(64 * 1024)
        return () => rust.gzipCompressInto(f.compressPayload, out)
      })(),
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'rust:brotli_compress_into',
      run: (() => {
        const out = new Uint8Array(64 * 1024)
        return () => rust.brotliCompressInto(f.compressPayload, out)
      })(),
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'rust:sse_encode_into',
      run: (() => {
        const out = new Uint8Array(f.sseData.length + 64)
        return () => rust.sseEncodeEventInto('update', f.sseData, '42', 3000, out)
      })(),
      iterations: 500,
      warmup: 50,
    },
  ]
}
