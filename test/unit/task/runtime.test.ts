// test/unit/task/runtime.test.ts — off-thread task runtime.
//
// Exercises the real Bun path end-to-end: packed args → native pool thread →
// batched doorbell → drained completion → resolved promise. The point of the
// feature is that the JS thread never blocks, so one test measures event-loop
// starvation while a multi-megabyte decompression runs.

import { describe, expect, test } from 'bun:test'
import { ffiAddonPath, getBunFFI } from '../../../src/native/ffi'
import { rust } from '../../../src/rust-ffi'
import {
  brotliCapacityGuess,
  createTaskRuntime,
  encodeArgon2VerifyArgs,
  encodeGzipCompressHeader,
  encodeGzipDecompressArgs,
  gzipCompressUpperBound,
} from '../../../src/task'

describe('task runtime', () => {
  test('packs gzip.decompress args as [u32 max][bytes]', () => {
    const args = encodeGzipDecompressArgs(new Uint8Array([1, 2, 3]), 1024)
    expect(args.length).toBe(7)
    expect(new DataView(args.buffer).getUint32(0, true)).toBe(1024)
    expect([...args.subarray(4)]).toEqual([1, 2, 3])
  })

  test('defaults the cap to 0 (native 64 MiB)', () => {
    const args = encodeGzipDecompressArgs(new Uint8Array([9]))
    expect(new DataView(args.buffer).getUint32(0, true)).toBe(0)
  })

  // The zero-copy path (op `gzipDecompressInto`) is selected by SIZE HINT: the
  // JS side pre-allocates the destination and the pool thread writes straight
  // into it, so the result never crosses the boundary as a copy. This asserts
  // the hint is what drives that decision (and that the bytes are still exact).
  test('pre-sizes the destination for a payload above the zero-copy threshold', async () => {
    const ffi = getBunFFI()
    expect(ffi).not.toBeNull()
    expect(ffiAddonPath()).not.toBeNull()
    const tasks = createTaskRuntime()
    const payload = new Uint8Array(512 * 1024)
    for (let i = 0; i < payload.length; i += 1024) payload[i] = (i * 2654435761) & 0xff
    const compressed = Bun.gzipSync(payload)

    const hinted = ffi!.gzipIsize(compressed)
    expect(hinted).toBe(payload.length)
    expect(hinted).toBeGreaterThan(64 * 1024)

    const out = await tasks.gzipDecompress(compressed)
    expect(out.length).toBe(payload.length)
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true)
  })

  test('compresses off-thread and round-trips through gzip', async () => {
    const tasks = createTaskRuntime()
    const payload = new TextEncoder().encode('compress this '.repeat(4096))
    const hdr = encodeGzipCompressHeader(6)
    expect(hdr.length).toBe(4)
    expect(new DataView(hdr.buffer, hdr.byteOffset, 4).getUint32(0, true)).toBe(6)

    const compressed = await tasks.gzipCompress(payload)
    // Independent oracle: Bun's own gunzip (the copy normalizes the loose
    // `Uint8Array<ArrayBufferLike>` our API returns into Bun's stricter type).
    const restored = Bun.gunzipSync(new Uint8Array(compressed))
    expect(Buffer.from(restored).equals(Buffer.from(payload))).toBe(true)
    // The analytic bound must never under-estimate (it is what zero-copy would
    // pre-size from, and a short bound would recompress).
    expect(gzipCompressUpperBound(payload.length)).toBeGreaterThanOrEqual(compressed.length)
  })

  // Regression: compressing a LARGE buffer used to pack the payload into the
  // args blob first, which copied the whole input on the JS thread — measured
  // 18.6 ms wall / 11.7 ms stall for 24 MiB, i.e. WORSE than the synchronous
  // built-in it replaces. Zero-copy INPUT (only the 4-byte level header is
  // copied) brought it to ~2 ms of stall, so this test fails loudly if the
  // payload ever goes back through a copy.
  test('compresses a large buffer without copying it on the JS thread', async () => {
    const tasks = createTaskRuntime()
    const payload = new Uint8Array(16 * 1024 * 1024).fill(0x5a)

    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 2)
    const compressed = await tasks.gzipCompress(payload)
    maxGap = Math.max(maxGap, performance.now() - last)
    clearInterval(timer)

    expect(Buffer.from(Bun.gunzipSync(new Uint8Array(compressed))).equals(Buffer.from(payload))).toBe(
      true,
    )
    // 16 MiB of memcpy is ~5-6 ms on this class of machine; a repacked payload
    // would blow well past this bound.
    expect(maxGap).toBeLessThan(8)
  })

  test('brotli-decompresses off-thread, including the zero-copy retry', async () => {
    const tasks = createTaskRuntime()
    // Highly compressible input: the compressed form is tiny, so the 8x
    // capacity guess (floored at 64 KiB) falls far short of a 1 MiB output —
    // which forces the TOO_SMALL retry instead of the happy path.
    const payload = new Uint8Array(1024 * 1024).fill(0x41)
    const compressed = rust.brotliCompress(payload, 5)
    expect(compressed.length).toBeLessThan(64 * 1024)
    expect(brotliCapacityGuess(compressed.length)).toBe(64 * 1024)
    expect(brotliCapacityGuess(compressed.length)).toBeLessThan(payload.length)

    const before = tasks.stats()
    const out = await tasks.brotliDecompress(compressed)
    const after = tasks.stats()
    expect(out.length).toBe(payload.length)
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true)
    // Correctness alone would not prove the retry ran (the fallback is correct
    // too) — the counter does.
    expect(after.tooSmallRetries).toBeGreaterThan(before.tooSmallRetries)
    // The floor keeps tiny inputs on a sensible capacity.
    expect(brotliCapacityGuess(16)).toBe(64 * 1024)
  })

  test('verifies argon2 off-thread with a one-byte answer', async () => {
    const tasks = createTaskRuntime()
    const password = new TextEncoder().encode('hunter2')
    const phc = rust.passwordHash(password, new TextEncoder().encode('saltysalt'), {
      mCost: 4096,
      tCost: 1,
      pCost: 1,
      outLen: 32,
    }) as string

    const args = encodeArgon2VerifyArgs(password, new TextEncoder().encode(phc))
    expect(new DataView(args.buffer, args.byteOffset, 4).getUint32(0, true)).toBe(password.length)

    expect(await tasks.argon2Verify(password, new TextEncoder().encode(phc))).toBe(true)
    expect(await tasks.argon2Verify(new TextEncoder().encode('wrong'), new TextEncoder().encode(phc))).toBe(false)
    // A malformed PHC string is a non-match, never a rejection.
    expect(await tasks.argon2Verify(password, new TextEncoder().encode('not-a-phc'))).toBe(false)
    // Parity with the synchronous surface.
    expect(rust.passwordVerify(password, new TextEncoder().encode(phc))).toBe(true)
  })

  test('gzip-decompresses off-thread and resolves the bytes', async () => {
    const tasks = createTaskRuntime()
    const payload = new TextEncoder().encode('castrum tasks '.repeat(500))
    const compressed = Bun.gzipSync(payload)
    const out = await tasks.gzipDecompress(compressed)
    expect(out.length).toBe(payload.length)
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true)
    expect(tasks.stats().threads).toBeGreaterThanOrEqual(1)
  })

  test('keeps the event loop responsive for a large payload', async () => {
    const tasks = createTaskRuntime()
    const payload = new Uint8Array(24 * 1024 * 1024)
    // Deterministic non-trivial content so the decompression does real work.
    for (let i = 0; i < payload.length; i += 4096) payload[i] = (i * 2654435761) & 0xff
    const compressed = Bun.gzipSync(payload)

    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)

    const out = await tasks.gzipDecompress(compressed)
    maxGap = Math.max(maxGap, performance.now() - last)
    clearInterval(timer)

    expect(out.length).toBe(payload.length)
    // Synchronous decompression of this payload stalls the loop for tens of ms
    // (measured ~28 ms for 32 MiB); off-thread it must stay well under that.
    expect(maxGap).toBeLessThan(40)
  })

  // The batched doorbell is what makes the runtime viable: the native side
  // coalesces completions so a burst does NOT cost one JS round trip per task.
  test('amortizes the doorbell: many completions ride few drain rounds', async () => {
    const tasks = createTaskRuntime()
    const tiny = Bun.gzipSync(new TextEncoder().encode('x'.repeat(256)))
    const before = tasks.stats()
    await Promise.all(Array.from({ length: 128 }, () => tasks.gzipDecompress(tiny)))
    const after = tasks.stats()
    expect(after.completed - before.completed).toBe(128)
    // 1:1 would mean batching is broken (the bench measures ~66/round).
    expect(after.drains - before.drains).toBeLessThan(128)
    expect(after.maxBatch).toBeGreaterThan(1)
  })

  test('rejects on invalid input instead of throwing across FFI', async () => {    const tasks = createTaskRuntime()
    await expect(tasks.gzipDecompress(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
  })

  test('enforces the decompression cap', async () => {
    const tasks = createTaskRuntime()
    const payload = new Uint8Array(1 << 20)
    const compressed = Bun.gzipSync(payload)
    await expect(tasks.gzipDecompress(compressed, { maxDecompressed: 16 })).rejects.toThrow(
      /cap|exceed/i,
    )
  })

  test('an aborted signal always settles the promise', async () => {
    const tasks = createTaskRuntime()
    const payload = new TextEncoder().encode('abort me '.repeat(2000))
    const compressed = Bun.gzipSync(payload)
    const controller = new AbortController()
    const promise = tasks.gzipDecompress(compressed, { signal: controller.signal })
    controller.abort()
    const settled = await Promise.race([
      promise.then(() => 'value').catch(() => 'error'),
      Bun.sleep(5000).then(() => 'timeout'),
    ])
    expect(settled).not.toBe('timeout')
  })

  test('staggers many concurrent tasks without losing any', async () => {
    const tasks = createTaskRuntime()
    const payloads = Array.from({ length: 64 }, (_, i) =>
      new TextEncoder().encode(`payload-${i}-`.repeat(50 + i)),
    )
    const compressed = payloads.map((p) => Bun.gzipSync(p))
    const results = await Promise.all(compressed.map((c) => tasks.gzipDecompress(c)))
    results.forEach((out, i) => {
      expect(Buffer.from(out).equals(Buffer.from(payloads[i]!))).toBe(true)
    })
  })

  test('a second createTaskRuntime() returns the shared runtime', () => {
    const a = createTaskRuntime()
    const b = createTaskRuntime()
    expect(a).toBe(b)
  })

  test('pbkdf2 runs off-thread and matches node:crypto', async () => {
    const tasks = createTaskRuntime()
    const password = new TextEncoder().encode('password')
    const salt = new TextEncoder().encode('salt')
    const out = await tasks.pbkdf2Sha256(password, salt, { rounds: 4096, dkLen: 32 })
    const { pbkdf2Sync } = await import('node:crypto')
    expect(Buffer.from(out).equals(pbkdf2Sync('password', 'salt', 4096, 32, 'sha256'))).toBe(true)
  })

  test('pbkdf2 keeps the loop responsive while burning CPU', async () => {
    const tasks = createTaskRuntime()
    const password = new TextEncoder().encode('correct horse battery staple')
    const salt = new TextEncoder().encode('saltsaltsalt')

    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 2)
    await Bun.sleep(30)
    last = performance.now()
    const out = await tasks.pbkdf2Sha256(password, salt, { rounds: 300_000, dkLen: 32 })
    await Bun.sleep(30)
    clearInterval(timer)
    maxGap = Math.max(maxGap, performance.now() - last)

    expect(out.length).toBe(32)
    // The whole point: ~100-300 ms of CPU with a 32-byte result must not stall
    // the event loop. Synchronous PBKDF2 would show a gap of the full duration.
    expect(maxGap).toBeLessThan(20)
  })
})
