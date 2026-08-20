/**
 * Property test: the JS↔Rust ingress PACKED boundary must never crash the
 * process or throw out of the pipeline for adversarial input frames.
 *
 * The native core trusts the JS side to emit a well-formed packed frame, but
 * the boundary is only as safe as the Rust parser's bounds checks. These tests
 * feed it (a) valid frames with random/binary/control-char content, (b) fully
 * random bytes as the packed frame, (c) forged length prefixes and (d) one-byte
 * corruptions of valid frames, and assert the call either succeeds or throws a
 * CONTAINED error (panic_guard / napi catch_unwind) — never a process crash.
 * A crash fails the whole `bun test` run, which IS the assertion. All PRNG
 * draws are seeded (../property/seeded.ts) for reproducibility.
 */

import { describe, expect, test } from 'bun:test'
import { BakedIngressResult } from '../../src/ingress/decode/baked-result'
import { IngressInputPacker } from '../../src/ingress/packing/input-packer'
import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { isBun } from '../../src/shared/runtime'
import { seededRandom } from './seeded'

const addon = getAddon()
const rand = seededRandom()
const encoder = new TextEncoder()

function randBytes(max: number): Uint8Array {
  const b = new Uint8Array(Math.floor(rand() * max))
  for (let i = 0; i < b.length; i++) {
    b[i] = Math.floor(rand() * 256)
  }
  return b
}

function randValue(max: number): string {
  // JSON-special + control chars so the escape/JSON paths are exercised.
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_=+&?%/.~"\\\t\r\n\x08\x0c😀é'
  let s = ''
  const len = Math.floor(rand() * max)
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(rand() * chars.length)] ?? ''
  }
  return s
}

const HEADER_NAMES = [
  'cookie',
  'origin',
  'x-forwarded-for',
  'x-real-ip',
  'access-control-request-method',
  'access-control-request-headers',
  'x-forwarded-proto',
  'x-custom-header',
]

/** Build a valid packed header block: `[u16 count]{[u16 nlen][name][u32 vlen][value]}`. */
function packHeaderBlock(pairs: Array<[string, string]>): Uint8Array {
  const enc = encoder
  let total = 2
  for (const [n, v] of pairs) total += 2 + enc.encode(n).length + 4 + enc.encode(v).length
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, pairs.length, true)
  let pos = 2
  for (const [n, v] of pairs) {
    const nb = enc.encode(n)
    const vb = enc.encode(v)
    dv.setUint16(pos, nb.length, true)
    buf.set(nb, pos + 2)
    pos += 2 + nb.length
    dv.setUint32(pos, vb.length, true)
    buf.set(vb, pos + 4)
    pos += 4 + vb.length
  }
  return buf
}

function randomHeaderBlock(): Uint8Array {
  const n = Math.floor(rand() * 6)
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < n; i++) {
    pairs.push([
      HEADER_NAMES[Math.floor(rand() * HEADER_NAMES.length)] ?? 'x-custom',
      randValue(60),
    ])
  }
  return packHeaderBlock(pairs)
}

type PackedIngress = {
  handleRequestPacked(input: Uint8Array, body: Uint8Array | null, out: Uint8Array): number
}

/**
 * Run one packed input through the pipeline. Returns the written count (and
 * the output buffer) when it succeeded, or `{ w: null }` when the pipeline
 * threw a CONTAINED error (invalid input → napi catch_unwind / panic_guard →
 * 0 → throw). A process crash would abort the whole test run — surviving
 * every iteration is the assertion.
 */
function runHandle(
  handler: PackedIngress,
  input: Uint8Array,
  body: Uint8Array | null,
): { w: number | null; out: Uint8Array } {
  const out = new Uint8Array(8192)
  try {
    const w = handler.handleRequestPacked(input, body, out)
    return { w: w <= out.length ? w : null, out }
  } catch {
    return { w: null, out }
  }
}

/** Decode a successful output via BakedIngressResult — must never throw. */
function assertDecodesSafely(
  res: { w: number | null; out: Uint8Array },
  body: Uint8Array | null,
): void {
  if (res.w === null) return
  const buf = res.out.subarray(0, res.w)
  const baked = new BakedIngressResult()
  expect(() =>
    baked.refresh(
      buf,
      body ?? new Uint8Array(0),
      new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    ),
  ).not.toThrow()
  expect(() => {
    baked.bodyJson(false)
    baked.cookiesJson()
    baked.queryJson()
  }).not.toThrow()
}

describe('ingress packed boundary (adversarial, seeded)', () => {
  const handler = new addon.Ingress({ parseQuery: true, parseCookies: true })
  const bunFFI = isBun() ? getBunFFI() : null
  const ptr =
    bunFFI !== null && typeof handler.ingressInnerPtr === 'function'
      ? Number(handler.ingressInnerPtr())
      : 0
  const packer = new IngressInputPacker()

  test('valid frames with random/binary/control-char content never crash', () => {
    for (let i = 0; i < 300; i++) {
      const input = packer.pack(
        Math.floor(rand() * 8),
        randBytes(80),
        randBytes(20),
        randBytes(16),
        randomHeaderBlock(),
      )
      const body = Math.floor(rand() * 2) === 0 ? null : randBytes(128)
      const res = runHandle(handler, input, body)
      assertDecodesSafely(res, body)
    }
  })

  test('fully random bytes as the packed frame never crash', () => {
    for (let i = 0; i < 400; i++) {
      const input = randBytes(300)
      const body = Math.floor(rand() * 2) === 0 ? null : randBytes(128)
      runHandle(handler, input, body)
    }
  })

  test('forged u32 length prefixes never crash', () => {
    // method + urlLen=0x7ffffff0 — the parser must reject, not read OOB.
    const forged = new Uint8Array(64)
    forged[0] = 2 // method POST
    new DataView(forged.buffer).setUint32(1, 0x7ffffff0, true)
    runHandle(handler, forged, null)

    // urlLen points past the buffer.
    const forged2 = new Uint8Array(16)
    new DataView(forged2.buffer).setUint32(1, 1000, true)
    runHandle(handler, forged2, null)

    // header block len huge.
    const forged3 = new Uint8Array(16)
    new DataView(forged3.buffer).setUint32(1, 4, true) // url "xxxx"
    new DataView(forged3.buffer).setUint32(9, 0xfffffff0, true) // headersLen huge
    runHandle(handler, forged3, null)
  })

  test('one-byte corruption of a valid frame never crashes and decodes safely', () => {
    const good = packer.pack(
      0,
      encoder.encode('/api/users?x=1&y=2'),
      encoder.encode('127.0.0.1'),
      encoder.encode('rid-12345'),
      packHeaderBlock([
        ['cookie', 'a=1'],
        ['origin', 'https://app.example.com'],
      ]),
    )

    const baseline = runHandle(handler, good, null)
    expect(baseline.w).not.toBeNull()

    for (let i = 0; i < good.length; i++) {
      const mutated = good.slice()
      mutated[i] = ((mutated[i] ?? 0) + 1 + Math.floor(rand() * 250)) & 0xff
      const res = runHandle(handler, mutated, null)
      assertDecodesSafely(res, null)
    }
  })

  test('ffi handle (when active) mirrors napi on adversarial frames', () => {
    if (bunFFI === null || ptr === 0) return
    for (let i = 0; i < 200; i++) {
      const input = packer.pack(
        Math.floor(rand() * 8),
        randBytes(80),
        randBytes(20),
        randBytes(16),
        randomHeaderBlock(),
      )
      const body = Math.floor(rand() * 2) === 0 ? null : randBytes(64)
      const outN = new Uint8Array(8192)
      const outF = new Uint8Array(8192)
      let wN: number | null = null
      let wF: number | null = null
      try {
        wN = handler.handleRequestPacked(input, body, outN)
      } catch {
        /* contained */
      }
      try {
        const w = bunFFI.ingressHandlePacked(ptr, input, body, outF)
        wF = w <= outF.length ? w : null
      } catch {
        /* contained */
      }
      // Both transports must agree on the outcome (both succeed, or both
      // reject) and on the written bytes when they both succeed.
      expect(wN === null).toBe(wF === null)
      if (wN !== null && wF !== null) {
        expect(wN).toBe(wF)
      }
    }
  })
})
