#!/usr/bin/env bun
/**
 * Verify native BATCH APIs are byte-correct against their scalar counterparts.
 *
 * Replaces the old `repro-flux-batch.ts` (2026-08-11). Root-cause of that
 * repro: it read `crc32BatchPacked` (flat `[u32 count][u32…]` wire format)
 * with `unpackByteResults` (the `[count][len][bytes]` format) — a script bug,
 * not a buffer-corruption bug. On re-run with correct unpackers, query/cookie/
 * sse batch calls returned correct item counts and NO process crash occurred.
 *
 * This script is the real test: for every op, the BATCH result must equal the
 * per-item SCALAR result, byte-for-byte, across multiple trials. If this is
 * green, the native batch path is safe to wire into the data loader.
 *
 * Run: `bun scripts/verify-native-batch.ts` (Bun and Node both work).
 */
import { rust } from '../src/rust-ffi'

const enc = new TextEncoder()

function deepEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

let failures = 0
let checks = 0

function expect(label: string, cond: boolean, detail?: string): void {
  checks++
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

function bytesEqual(
  a: Uint8Array | Uint32Array | BigUint64Array,
  b: Uint8Array | Uint32Array | BigUint64Array,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Index-safe byte-array equality: every batch item must equal its scalar. */
function eqBytesArr(a: Uint8Array[], b: Uint8Array[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined || !deepEqualBytes(x, y)) return false
  }
  return true
}

/** Index-safe bitset-vs-boolean equality (jsonValid batch vs scalar). */
function eqBoolArr(a: Uint8Array, b: boolean[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined || (x === 1) !== y) return false
  }
  return true
}

/** Index-safe bigint-array equality (fnv1a64 batch vs scalar). */
function eqBigIntArr(a: BigUint64Array, b: bigint[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined || x !== y) return false
  }
  return true
}

const bigChunk = 'x'.repeat(64)
const query = `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}&name=Ada%20Lovelace`
const cookies = Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(' ')
const N = 32

const qItems = Array.from({ length: N }, () => enc.encode(query))
const cItems = Array.from({ length: N }, () => enc.encode(cookies))
const sseItems = Array.from({ length: N }, () => enc.encode(`data ${bigChunk}\n`))
const crcItems = Array.from({ length: 64 }, (_, i) => new Uint8Array(64).fill(i))
const fnvItems = Array.from({ length: 48 }, (_, i) => enc.encode(`key-${i}-${bigChunk}`))
const validItems = [
  enc.encode('{"a":1,"b":[true,null,"x"]}'),
  enc.encode('{"a":1,"b":[true,null,"x"]}'),
  enc.encode('{"a":1, broken'),
  enc.encode('[]'),
  enc.encode(''),
  enc.encode('{"x": {"y": [1, 2, 3]}}'),
  enc.encode('null'),
  enc.encode('[1,2,3]'),
  enc.encode('nope'),
  enc.encode('42'),
]
// Repeat validItems to N for a uniform batch.
const vItems = Array.from({ length: N }, (_, i) => validItems[i % validItems.length] as Uint8Array)

function trial(t: number): void {
  console.log(`\n--- trial ${t} ---`)

  // queryParsePacked: batch per-item vs scalar.
  const qBatch = rust.batch.queryParse(qItems)
  const qScalar = qItems.map((it) => rust.queryParsePacked(it))
  expect('queryParse batch==scalar per item', eqBytesArr(qBatch, qScalar))

  // cookieParsePacked.
  const cBatch = rust.batch.cookieParse(cItems)
  const cScalar = cItems.map((it) => rust.cookieParsePacked(it))
  expect('cookieParse batch==scalar per item', eqBytesArr(cBatch, cScalar))

  // sseEncode: batch vs scalar.
  const sBatch = rust.batch.sseEncode(sseItems, null, null, null)
  const sScalar = sseItems.map((it) => rust.sseEncodeEvent(null, it, null, null))
  expect('sseEncode batch==scalar per item', eqBytesArr(sBatch, sScalar))

  // crc32: flat u32 batch vs scalar.
  const crcBatch = rust.batch.crc32(crcItems)
  const crcScalar = crcItems.map((it) => rust.crc32(it))
  expect('crc32 batch==scalar per item', bytesEqual(crcBatch, crcScalar as unknown as Uint32Array))

  // fnv1a64: unsigned bigint batch vs scalar.
  const fnvBatch = rust.batch.fnv1a64(fnvItems)
  const fnvScalar = fnvItems.map((it) => rust.fnv1a64(it))
  expect('fnv1a64 batch==scalar per item', eqBigIntArr(fnvBatch, fnvScalar))

  // jsonValid: bitset batch vs scalar.
  const vBatch = rust.batch.jsonValid(vItems)
  const vScalar = vItems.map((it) => rust.jsonValid(it))
  expect('jsonValid batch==scalar per item', eqBoolArr(vBatch, vScalar))
}

const TRIALS = 5
for (let t = 1; t <= TRIALS; t++) trial(t)

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error('NATIVE BATCH PARITY FAILED')
  process.exit(1)
}
console.log('NATIVE BATCH PARITY OK — batch APIs are byte-correct vs scalar on this runtime.')
