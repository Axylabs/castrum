// src/bench/encoding-baseline.ts — JS baselines for base64/hex encode-decode.
// Uses Buffer (Bun/Node native). Bench-local only.

import { Buffer } from 'node:buffer'
import { decoder, encoder } from '../shared/bytes'

export function nativeBase64Encode(input: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(input).toString('base64'))
}

export function nativeBase64Decode(input: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(decoder.decode(input), 'base64'))
}

export function nativeHexEncode(input: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(input).toString('hex'))
}

export function nativeHexDecode(input: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(decoder.decode(input), 'hex'))
}
