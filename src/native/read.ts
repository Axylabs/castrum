// src/native/read.ts — runtime-native scalar and UTF-8 reads over output buffers.

import { createRequire } from 'node:module'
import { decodeUtf8 } from '../shared/codec'

interface BunFfiRead {
  read: { u32(ptr: number, offset?: number): number; u64(ptr: number, offset?: number): bigint }
  ptr(buffer: Uint8Array): number
  CString: new (ptr: number, byteOffset?: number, byteLength?: number) => string
}

let bunFfi: BunFfiRead | null = null
try {
  const mod = createRequire(import.meta.url)('bun:ffi') as Partial<BunFfiRead>
  bunFfi =
    mod.read && typeof mod.ptr === 'function' && typeof mod.CString === 'function'
      ? (mod as BunFfiRead)
      : null
} catch {
  bunFfi = null
}

/** A native output buffer pinned for repeated fast reads. */
export interface FfiBuf {
  readonly p: number
  readonly buf: Uint8Array
}

/** Pin a buffer and resolve its pointer once when `bun:ffi` is available. */
export const ffiBuf = (buf: Uint8Array): FfiBuf =>
  bunFfi ? { p: bunFfi.ptr(buf), buf } : { p: 0, buf }

const fallbackView = (buf: Uint8Array): DataView =>
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

/** Read a little-endian u32 from `b` at byte `offset`. */
export const ffiU32 = (b: FfiBuf, offset: number): number =>
  bunFfi ? bunFfi.read.u32(b.p, offset) : fallbackView(b.buf).getUint32(offset, true)

/** Read a little-endian u64 from `b` at byte `offset`. */
export const ffiU64 = (b: FfiBuf, offset: number): bigint =>
  bunFfi ? bunFfi.read.u64(b.p, offset) : fallbackView(b.buf).getBigUint64(offset, true)

/** Read a UTF-8 string of `len` bytes from `b` at byte `offset`. */
export const ffiString = (b: FfiBuf, offset: number, len: number): string => {
  if (len === 0) return ''
  return bunFfi
    ? new bunFfi.CString(b.p, offset, len)
    : decodeUtf8(b.buf.subarray(offset, offset + len))
}
