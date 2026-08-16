// src/baseline/tasks/url.ts — JS baseline: URL encode/decode.

import { decoder } from '../../shared/bytes'

export function nativeUrlEncode(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : decoder.decode(input)
  return encodeURIComponent(text)
}

export function nativeUrlDecode(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : decoder.decode(input)
  return decodeURIComponent(text)
}

const HEX_VALUES = new Uint8Array(256)
for (let i = 0; i < 10; i++) HEX_VALUES[0x30 + i] = i // '0'..'9'
for (let i = 0; i < 6; i++) {
  HEX_VALUES[0x41 + i] = 10 + i // 'A'..'F'
  HEX_VALUES[0x61 + i] = 10 + i // 'a'..'f'
}
// Anything else stays 0xFF = "not a hex digit".

/**
 * Raw-bytes percent-decoder mirroring Rust's `url_decode_bytes` (the baseline
 * for `rust.urlDecodeBytes`): `%XX` sequences decode to bytes, `+` stays a
 * literal `+` (no form-space mapping), and NO UTF-8 validation runs on the
 * output (unlike the strict `nativeUrlDecode`). A malformed `%XX` (truncated
 * or non-hex) throws — same as the Rust `url_decode_bytes` Result.
 */
export function nativeUrlDecodeBytes(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  let n = 0
  for (let i = 0; i < input.length; i++) {
    const b = input[i] ?? 0
    if (b === 0x25 /* % */) {
      const hi = input[i + 1]
      const lo = input[i + 2]
      if (hi === undefined || lo === undefined) {
        throw new Error('url decode: invalid %-encoding: malformed %XX sequence')
      }
      const hiV = HEX_VALUES[hi] ?? 0xff
      const loV = HEX_VALUES[lo] ?? 0xff
      if (hiV === 0xff || loV === 0xff) {
        throw new Error('url decode: invalid %-encoding: malformed %XX sequence')
      }
      out[n++] = (hiV << 4) | loV
      i += 2
    } else {
      out[n++] = b
    }
  }
  return out.subarray(0, n)
}
