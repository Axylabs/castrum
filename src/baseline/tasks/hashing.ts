// src/baseline/tasks/hashing.ts — JS baseline: FNV-1a / crc32 / xxh3.

import * as CRC32 from 'crc-32'

export function nativeCrc32(bytes: Uint8Array): number {
  return CRC32.buf(bytes) >>> 0
}

export function nativeFnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn

  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }

  return hash
}
