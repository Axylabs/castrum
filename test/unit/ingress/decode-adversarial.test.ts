/**
 * Adversarial decoder tests: forged / garbage OUT_* layout bytes must never
 * throw or read out of bounds — both decoders degrade to a safe error state.
 *
 * The native core is trusted to emit a well-formed layout, but the JS decoders
 * (`FastIngressResult`, `BakedIngressResult`) are the LAST line of defense
 * against a malformed/truncated/corrupted buffer (a bug, a partial write, or
 * a mis-sized output pool). These tests feed them fabricated layouts: truncated
 * headers, huge declared section lengths, all-zero (uninitialized) buffers and
 * fully random bytes, and assert graceful degradation. All PRNG draws are
 * seeded (../property/seeded.ts) for reproducibility.
 */

import { describe, expect, test } from 'bun:test'
import {
  ERR_CODE_INTERNAL,
  OUT_BODY_JSON_LEN,
  OUT_COOKIES_JSON_LEN,
  OUT_DATA_START,
  OUT_ERROR_CODE,
  OUT_FLAGS,
  OUT_QUERY_JSON_LEN,
  OUT_RATE_LIMIT,
  OUT_RATE_REMAINING,
  OUT_RATE_RESET,
  OUT_RETRY_AFTER,
  OUT_STATUS,
  OUT_VERDICT,
} from '../../../src/ingress/constants'
import { BakedIngressResult } from '../../../src/ingress/decode/baked-result'
import { FastIngressResult } from '../../../src/ingress/decode/fast-result'
import { seededRandom } from '../../property/seeded'

const rand = seededRandom()

function forgeBuffer(size: number, fill: number): Uint8Array {
  const buf = new Uint8Array(size)
  buf.fill(fill)
  return buf
}

function viewFor(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** Run a forged buffer through BOTH decoders and assert safe degradation. */
function assertSafeDegradation(
  buf: Uint8Array,
  opts: { expectTruncated?: boolean; expectInternalError?: boolean } = {},
): void {
  const fast = new FastIngressResult()
  expect(() => fast.refresh(buf, new Uint8Array(0), 'rid')).not.toThrow()
  expect(() => {
    fast.bodyJson()
    fast.cookiesJson()
    fast.queryJson()
  }).not.toThrow()

  const baked = new BakedIngressResult()
  expect(() => baked.refresh(buf, new Uint8Array(0), viewFor(buf))).not.toThrow()
  expect(() => {
    baked.bodyJson(false)
    baked.cookiesJson()
    baked.queryJson()
  }).not.toThrow()

  if (opts.expectInternalError) {
    expect(fast.status).toBe(500)
    expect(fast.errorCode).toBe(ERR_CODE_INTERNAL)
    expect(fast.terminal).toBe(true)
    expect(baked.status).toBe(500)
    expect(baked.errorCode).toBe(ERR_CODE_INTERNAL)
    expect(baked.terminal).toBe(true)
  }

  if (opts.expectTruncated) {
    expect(fast.bodyTruncated).toBe(true)
    expect(baked.bodyTruncated).toBe(true)
  }
}

describe('adversarial layouts: both decoders degrade safely', () => {
  test('buffer shorter than the fixed header → internal error, no throw', () => {
    assertSafeDegradation(forgeBuffer(4, 0x00), { expectInternalError: true })
    assertSafeDegradation(forgeBuffer(OUT_DATA_START - 1, 0xff), {
      expectInternalError: true,
    })
  })

  test('huge declared section lengths clamp to the buffer (truncated, no OOB)', () => {
    const buf = forgeBuffer(OUT_DATA_START + 64, 0x41)
    const dv = viewFor(buf)
    dv.setUint32(OUT_COOKIES_JSON_LEN, 0xffffffff, true)
    dv.setUint32(OUT_QUERY_JSON_LEN, 0xffffffff, true)
    dv.setUint32(OUT_BODY_JSON_LEN, 0xffffffff, true)
    assertSafeDegradation(buf, { expectTruncated: true })

    // Sections clamped to 0 → accessors return the empty/default values.
    const fast = new FastIngressResult()
    fast.refresh(buf, new Uint8Array(0), 'rid')
    expect(fast.cookiesJson()).toBe('{}')
    expect(fast.queryJson()).toBe('{}')
    expect(fast.bodyJson().length).toBe(0)
  })

  test('section lengths exactly fit vs one-past-end (boundary)', () => {
    const payload = new TextEncoder().encode('{"a":1}')
    const size = OUT_DATA_START + payload.length
    const buf = forgeBuffer(size, 0x00)
    buf.set(payload, OUT_DATA_START)

    // Exact fit → not truncated, body readable.
    const dv = viewFor(buf)
    dv.setUint32(OUT_BODY_JSON_LEN, payload.length, true)
    const exact = new FastIngressResult()
    exact.refresh(buf, new Uint8Array(0), 'rid')
    expect(exact.bodyTruncated).toBe(false)
    expect(exact.bodyJson()).toEqual(payload)

    // One past the end → clamped, flagged truncated, empty body. The buffer
    // must be sized to the payload so the +1 overrun actually exceeds it.
    const over = forgeBuffer(OUT_DATA_START + payload.length, 0x00)
    over.set(payload, OUT_DATA_START)
    viewFor(over).setUint32(OUT_BODY_JSON_LEN, payload.length + 1, true)
    const truncated = new FastIngressResult()
    truncated.refresh(over, new Uint8Array(0), 'rid')
    expect(truncated.bodyTruncated).toBe(true)
    expect(truncated.bodyJson().length).toBe(0)
  })

  test('all-zero (uninitialized) buffer → internal error, no throw', () => {
    assertSafeDegradation(forgeBuffer(OUT_DATA_START + 32, 0x00), {
      expectInternalError: true,
    })
  })

  test('fully random bytes never throw and accessors stay safe', () => {
    for (let i = 0; i < 200; i++) {
      const buf = new Uint8Array(OUT_DATA_START + Math.floor(rand() * 256))
      for (let j = 0; j < buf.length; j++) {
        buf[j] = Math.floor(rand() * 256)
      }
      assertSafeDegradation(buf)
    }
  })

  test('random garbage after a VALID header is ignored (read region bounded)', () => {
    // Valid status/flags header but random section lengths — the decoder must
    // never read past the buffer, even with adversarial length prefixes.
    for (let i = 0; i < 200; i++) {
      const buf = new Uint8Array(OUT_DATA_START + 16)
      const dv = viewFor(buf)
      dv.setUint8(OUT_VERDICT, 0)
      dv.setUint8(OUT_ERROR_CODE, 0)
      dv.setUint16(OUT_STATUS, 200, true)
      dv.setUint32(OUT_FLAGS, 0, true)
      dv.setUint32(OUT_COOKIES_JSON_LEN, Math.floor(rand() * 0xffffffff), true)
      dv.setUint32(OUT_QUERY_JSON_LEN, Math.floor(rand() * 0xffffffff), true)
      dv.setUint32(OUT_BODY_JSON_LEN, Math.floor(rand() * 0xffffffff), true)
      assertSafeDegradation(buf)
    }
  })

  test('nonzero-byteOffset subarray decodes correctly (pooled-write pattern)', () => {
    // Production buffers are often subarrays with a nonzero byteOffset (the
    // output pool writes at an offset). The DataView must respect byteOffset.
    const backing = new Uint8Array(OUT_DATA_START + 64 + 8)
    backing.fill(0xcc)
    const payload = new TextEncoder().encode('{"ok":true}')
    const start = 8
    const buf = backing.subarray(start, start + OUT_DATA_START + payload.length)
    buf.set(payload, OUT_DATA_START)

    const fast = new FastIngressResult()
    expect(() => fast.refresh(buf, new Uint8Array(0), 'rid')).not.toThrow()
    expect(fast.bodyJson().length).toBe(0) // body length prefix is 0

    const dv = viewFor(buf)
    dv.setUint32(OUT_BODY_JSON_LEN, payload.length, true)
    const fast2 = new FastIngressResult()
    fast2.refresh(buf, new Uint8Array(0), 'rid')
    expect(fast2.bodyJson()).toEqual(payload)
  })

  test('rate-window i64 (u32-halves decode) matches the raw bytes exactly', () => {
    // `setRateWindow` (result-base.ts) reads OUT_RATE_RESET / OUT_RETRY_AFTER
    // as two u32 halves instead of `getBigUint64` (BigInt boxing). Pin that
    // decode on BOTH decoders with values that exercise the high word and the
    // exact-boundary (< 2^32) case.
    const buf = forgeBuffer(OUT_DATA_START, 0x00)
    const dv = viewFor(buf)
    // Valid accepted header: verdict 0, errorCode 0, status 200 → h0 = 200<<16.
    dv.setUint32(OUT_VERDICT, 200 << 16, true)
    dv.setUint32(OUT_FLAGS, 0, true)
    dv.setUint32(OUT_RATE_LIMIT, 5, true) // > 0 → setRateWindow reads the window
    dv.setUint32(OUT_RATE_REMAINING, 3, true)

    const writeI64 = (offset: number, value: number): void => {
      const hi = Math.floor(value / 4294967296)
      const lo = value - hi * 4294967296
      dv.setUint32(offset, lo, true)
      dv.setUint32(offset + 4, hi, true)
    }
    const reset = 1_700_000_000_123 // high word nonzero (5e12-class epoch-ms)
    const retryAfter = 42 // fits the low word only
    writeI64(OUT_RATE_RESET, reset)
    writeI64(OUT_RETRY_AFTER, retryAfter)

    const fast = new FastIngressResult()
    fast.refresh(buf, new Uint8Array(0), 'rid')
    expect(fast.rateResetMs).toBe(reset)
    expect(fast.retryAfterMs).toBe(retryAfter)
    expect(fast.rateRemaining).toBe(3)

    const baked = new BakedIngressResult()
    baked.refresh(buf, new Uint8Array(0), viewFor(buf))
    expect(baked.rateResetMs).toBe(reset)
    expect(baked.retryAfterMs).toBe(retryAfter)
    expect(baked.rateRemaining).toBe(3)
  })
})
