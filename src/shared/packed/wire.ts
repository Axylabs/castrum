// src/shared/packed/wire.ts — Pure packed wire-format encode/decode helpers.
//
// The zero-allocation byte layouts shared by the batch/loader/rust-ffi layers:
//   - unpackers:  u32 arrays, bitsets, i64/u64 arrays, byte-results, multipart
//   - packers:    `[u32 count]{[u32 len][bytes]}` batches + string pairs
//   - decoders:   pairs, HTTP request, and the reusable pack-scratch pool
//
// This module is PURE (no addon dlopen): consumers that only need these
// helpers never touch the native layer. The native-backed ergonomic parsers
// live in ./parsers.ts.

import type { MultipartPart } from '../../native'
import { decoder, encoder, viewForArrayBuffer } from '../bytes'

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readU32(dv: DataView, offset: number): number {
  if (offset + 4 > dv.byteLength) {
    throw new RangeError('packed buffer: truncated u32')
  }

  return dv.getUint32(offset, true)
}

function readSlice(bytes: Uint8Array, offset: number, len: number): Uint8Array {
  if (len < 0 || offset + len > bytes.byteLength) {
    throw new RangeError('packed buffer: truncated bytes')
  }

  return bytes.subarray(offset, offset + len)
}

/**
 * Unpack a packed u32 array: `[u32 count]{[u32 value]}` → `Uint32Array`.
 * @throws {RangeError} when the buffer is shorter than `count` × 4 bytes.
 */
export function unpackU32Array(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength < 4) {
    return new Uint32Array(0)
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)

  if (count > Math.floor((bytes.byteLength - 4) / 4)) {
    throw new RangeError('packed buffer: invalid u32 count')
  }

  const out = new Uint32Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = readU32(dv, 4 + i * 4)
  }

  return out
}

/**
 * Unpack a packed bitset: `[u32 count]{bit per item}` → one 0/1 byte per item.
 * @throws {RangeError} when the buffer is shorter than `count` bits.
 */
export function unpackBitset(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4) {
    return new Uint8Array(0)
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)
  const expectedBytes = Math.ceil(count / 8)

  if (bytes.byteLength < 4 + expectedBytes) {
    throw new RangeError('packed buffer: truncated bitset')
  }

  const bits = bytes.subarray(4)
  const out = new Uint8Array(count)

  for (let i = 0; i < count; i++) {
    const byte = bits[i >> 3] ?? 0
    out[i] = (byte >> (i & 7)) & 1
  }

  return out
}

/**
 * Unpack a packed i64 array as SIGNED `BigInt64Array`.
 * @throws {RangeError} when the buffer is shorter than `count` × 8 bytes.
 */
export function unpackI64ArrayAsBigInt(bytes: Uint8Array): BigInt64Array {
  if (bytes.byteLength < 4) {
    return new BigInt64Array(0)
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)

  if (count > Math.floor((bytes.byteLength - 4) / 8)) {
    throw new RangeError('packed buffer: invalid i64 count')
  }

  const out = new BigInt64Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = dv.getBigInt64(4 + i * 8, true)
  }

  return out
}

/**
 * Unpack a packed i64 array as UNSIGNED `BigUint64Array`. Used by hash
 * batches (e.g. `fnv1a64`) so the bulk result matches the unsigned `bigint`
 * the scalar FFI returns.
 */
export function unpackU64ArrayAsBigInt(bytes: Uint8Array): BigUint64Array {
  if (bytes.byteLength < 4) {
    return new BigUint64Array(0)
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)

  if (count > Math.floor((bytes.byteLength - 4) / 8)) {
    throw new RangeError('packed buffer: invalid i64 count')
  }

  const out = new BigUint64Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = dv.getBigUint64(4 + i * 8, true)
  }

  return out
}

/**
 * Unpack a packed byte-results buffer: `[u32 count]{[u32 len][bytes]}` → one
 * `Uint8Array` slice per item. The slices reference `bytes`'s backing store
 * (zero-copy) — copy them if held beyond the buffer's lifetime.
 */
export function unpackByteResults(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength < 4) {
    return []
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)

  const out: Uint8Array[] = []
  let offset = 4

  for (let i = 0; i < count; i++) {
    const len = readU32(dv, offset)
    offset += 4

    const slice = readSlice(bytes, offset, len)
    offset += len

    out.push(slice)
  }

  return out
}

/**
 * Decode a packed multipart batch: `[u32 item_count]{[u32 parts_len]
 * [parts_packed]}` where each `parts_packed` is
 * `[u32 part_count]{[u32 name_len][name][u8 has_filename][u32 filename_len]
 * [filename][u8 has_ct][u32 ct_len][ct][u32 data_len][data]}`. Returns one
 * array of parts per input item.
 */
export function unpackMultipartParts(bytes: Uint8Array): MultipartPart[][] {
  if (bytes.byteLength < 4) {
    return []
  }

  const dv = dataView(bytes)
  const itemCount = readU32(dv, 0)
  const out: MultipartPart[][] = []
  let offset = 4

  for (let i = 0; i < itemCount; i++) {
    const partsLen = readU32(dv, offset)
    offset += 4
    const partsBytes = readSlice(bytes, offset, partsLen)
    offset += partsLen
    out.push(readMultipartPartsPacked(partsBytes))
  }

  return out
}

/** Decode a single `[u32 part_count]{…parts…}` packed buffer into objects. */
function readMultipartPartsPacked(bytes: Uint8Array): MultipartPart[] {
  if (bytes.byteLength < 4) {
    return []
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)
  const out: MultipartPart[] = []
  let offset = 4

  for (let i = 0; i < count; i++) {
    const nameLen = readU32(dv, offset)
    offset += 4
    const name = decoder.decode(readSlice(bytes, offset, nameLen))
    offset += nameLen

    const hasFilename = bytes[offset] ?? 0
    offset += 1
    const filenameLen = readU32(dv, offset)
    offset += 4
    const filenameBytes = readSlice(bytes, offset, filenameLen)
    offset += filenameLen

    const hasCt = bytes[offset] ?? 0
    offset += 1
    const ctLen = readU32(dv, offset)
    offset += 4
    const ctBytes = readSlice(bytes, offset, ctLen)
    offset += ctLen

    const dataLen = readU32(dv, offset)
    offset += 4
    const data = readSlice(bytes, offset, dataLen)
    offset += dataLen

    out.push({
      name,
      filename: hasFilename ? decoder.decode(filenameBytes) : null,
      contentType: hasCt ? decoder.decode(ctBytes) : null,
      data,
    })
  }

  return out
}

/** A decoded `[name, value]` pair from a packed buffer. */
export type Pair = [string, string]

/**
 * Decode a packed `[u32 count][u32 keyLen][key][u32 valLen][val]...` buffer
 * into `[name, value]` string pairs (see `packPairs` for the layout).
 */
export function readPairsPacked(bytes: Uint8Array): Pair[] {
  if (bytes.byteLength < 4) {
    return []
  }

  const dv = dataView(bytes)
  const count = readU32(dv, 0)

  if (count === 0) {
    return []
  }

  const out: Pair[] = []
  let offset = 4

  for (let i = 0; i < count; i++) {
    const keyLen = readU32(dv, offset)
    offset += 4

    const keyBytes = readSlice(bytes, offset, keyLen)
    offset += keyLen

    const valueLen = readU32(dv, offset)
    offset += 4

    const valueBytes = readSlice(bytes, offset, valueLen)
    offset += valueLen

    out.push([decoder.decode(keyBytes), decoder.decode(valueBytes)])
  }

  return out
}

/**
 * Fold `[name, value]` pairs into an object; repeated names collect into a
 * string array (query-string/cookie semantics).
 */
export function pairsToObject(pairs: Pair[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}

  for (const [key, value] of pairs) {
    const existing = out[key]

    if (existing === undefined) {
      out[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      out[key] = [existing, value]
    }
  }

  return out
}

/** A decoded HTTP request from the native packed parser. */
export interface ParsedHttpRequestPacked {
  method: string
  path: string
  version: string
  headers: Record<string, string>
}

/**
 * Decode a native `httpParseRequestPacked` buffer into a plain request object
 * (zero-alloc on the Rust side; this builds the JS strings once).
 */
export function readHttpPacked(bytes: Uint8Array): ParsedHttpRequestPacked {
  const dv = dataView(bytes)
  let offset = 0

  const methodLen = readU32(dv, offset)
  offset += 4
  const method = decoder.decode(readSlice(bytes, offset, methodLen))
  offset += methodLen

  const pathLen = readU32(dv, offset)
  offset += 4
  const path = decoder.decode(readSlice(bytes, offset, pathLen))
  offset += pathLen

  const versionLen = readU32(dv, offset)
  offset += 4
  const version = decoder.decode(readSlice(bytes, offset, versionLen))
  offset += versionLen

  const headerCount = readU32(dv, offset)
  offset += 4

  const headers: Record<string, string> = {}

  for (let i = 0; i < headerCount; i++) {
    const nameLen = readU32(dv, offset)
    offset += 4
    const name = decoder.decode(readSlice(bytes, offset, nameLen))
    offset += nameLen

    const valueLen = readU32(dv, offset)
    offset += 4
    const value = decoder.decode(readSlice(bytes, offset, valueLen))
    offset += valueLen

    headers[name] = value
  }

  return {
    method,
    path,
    version,
    headers,
  }
}

/** Total packed bytes for an item list: `[u32 count] { [u32 len][bytes] }`. */
export function packedTotal(items: readonly Uint8Array[]): number {
  let total = 4
  for (const item of items) {
    total += 4 + item.byteLength
  }
  return total
}

/**
 * Write `[u32 count] { [u32 len][bytes] }` for `items` into `target` starting
 * at `offset`, returning the offset just past the written bytes. Throws
 * `RangeError` when `target` is too small. Pass a reusable `DataView` (see
 * `viewForArrayBuffer`) to avoid re-creating one per hot call.
 */
export function writePack(
  items: readonly Uint8Array[],
  target: Uint8Array,
  offset = 0,
  dv?: DataView,
): number {
  const end = offset + packedTotal(items)
  if (end > target.byteLength) {
    throw new RangeError(`packed buffer: target too small (${target.byteLength} < ${end})`)
  }
  const view = dv ?? viewForArrayBuffer(target.buffer, target.byteOffset)
  view.setUint32(offset, items.length, true)
  let pos = offset + 4
  for (const item of items) {
    view.setUint32(pos, item.byteLength, true)
    pos += 4
    target.set(item, pos)
    pos += item.byteLength
  }
  return end
}

/**
 * Build a packed batch buffer. Returns an OWNED buffer (safe to hold across
 * later calls) — this is the public entry point. Hot internal paths that can
 * guarantee synchronous consumption should use `withPackScratch` instead.
 */
export function packBatch(items: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(packedTotal(items))
  writePack(items, out)
  return out
}

// ── Reusable packed-input scratch (hot batch path) ──────────────────
// Native batch calls read the packed buffer synchronously and return an
// independent result, so the input buffer may be reused across calls. A small
// free-list keeps the steady-state hot path allocation-free. The caller MUST
// NOT retain the subarray handed to `fn` past that call.

const packScratchFree: Uint8Array[] = []

function acquirePackScratch(min: number): Uint8Array {
  const buf = packScratchFree.pop() ?? new Uint8Array(0)
  if (buf.byteLength < min) {
    let size = Math.max(256, buf.byteLength * 2)
    while (size < min) size *= 2
    return new Uint8Array(size)
  }
  return buf
}

function releasePackScratch(buf: Uint8Array): void {
  packScratchFree.push(buf)
}

/**
 * Pack `items` into a reusable scratch and call `fn(packed)`, returning its
 * result. The scratch is returned to the pool when `fn` returns (or throws).
 */
export function withPackScratch<T>(items: readonly Uint8Array[], fn: (packed: Uint8Array) => T): T {
  const buf = acquirePackScratch(packedTotal(items))
  const end = writePack(items, buf)
  try {
    return fn(buf.subarray(0, end))
  } finally {
    releasePackScratch(buf)
  }
}

/**
 * Pack TWO item lists into two reusable scratches and call `fn(a, b)` — for
 * paired ops (jsonPatch / hmacSha256Verify / passwordVerify / urlResolve) that
 * feed two packed lists to one native call. Safe because the native call
 * consumes both inputs synchronously.
 */
export function withPackScratch2<T>(
  a: readonly Uint8Array[],
  b: readonly Uint8Array[],
  fn: (packedA: Uint8Array, packedB: Uint8Array) => T,
): T {
  const bufA = acquirePackScratch(packedTotal(a))
  const bufB = acquirePackScratch(packedTotal(b))
  const endA = writePack(a, bufA)
  const endB = writePack(b, bufB)
  try {
    return fn(bufA.subarray(0, endA), bufB.subarray(0, endB))
  } finally {
    releasePackScratch(bufA)
    releasePackScratch(bufB)
  }
}

/**
 * Pack `[name, value]` string pairs into the native `[u32 count]...` layout
 * that `readPairsPacked` / the batch validators consume.
 */
export function packPairs(pairs: Array<[string, string]>): Uint8Array {
  const encoded = pairs.map(([key, value]) => [encoder.encode(key), encoder.encode(value)] as const)

  let total = 4

  for (const [key, value] of encoded) {
    total += 8 + key.byteLength + value.byteLength
  }

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)

  dv.setUint32(0, encoded.length, true)

  let offset = 4

  for (const [key, value] of encoded) {
    dv.setUint32(offset, key.byteLength, true)
    offset += 4
    out.set(key, offset)
    offset += key.byteLength

    dv.setUint32(offset, value.byteLength, true)
    offset += 4
    out.set(value, offset)
    offset += value.byteLength
  }

  return out
}
