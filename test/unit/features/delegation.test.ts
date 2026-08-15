/**
 * Cross-transport parity tests for the Bun-delegated scalar surface (BUN_WINS).
 *
 * Under Bun, `rust.crc32` / `rust.xxh3` / `rust.hmacSha256` /
 * `rust.randomToken` / `rust.gzipCompress` / `rust.urlEncode` /
 * `rust.urlDecode` / `rust.base64Encode` / `rust.httpDate` delegate to Bun
 * built-ins (the optimal-by-default path). These tests pin that the delegated
 * output is IDENTICAL to the raw addon's output (same format/semantics) so the
 * public surface never drifts from the native contract. Under Node both sides
 * use the addon, so the assertions still hold.
 */
import { describe, expect, test } from 'bun:test'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder, toText } from '../../../src/shared/bytes'
import { isBun } from '../../../src/shared/runtime'

const TEXT = 'hello world hello world hello world'

describe('Bun delegation parity (rust.* vs addon)', () => {
  const data = encoder.encode(TEXT)
  const key = encoder.encode('secret-key')

  test('crc32 matches Bun.hash.crc32 and the addon', () => {
    const expected = (isBun() ? Bun.hash.crc32(data) : getAddon().crc32(data)) >>> 0
    expect(rust.crc32(data)).toBe(expected)
    expect(rust.crc32(data)).toBe(getAddon().crc32(data) >>> 0)
  })

  test('xxh3 matches Bun.hash.xxHash3 and the addon', () => {
    const expected = isBun() ? Bun.hash.xxHash3(data) : getAddon().xxh3(data)
    expect(rust.xxh3(data)).toBe(expected)
    expect(rust.xxh3(data)).toBe(getAddon().xxh3(data))
  })

  test('hmacSha256 returns the same hex digest as Bun.CryptoHasher and the addon', () => {
    const addonHex = new (getAddon().HmacSigner)(key).sign(data)
    const rustHex = encoder.encode(rust.hmacSha256(key, data))
    expect(Array.from(rustHex)).toEqual(Array.from(addonHex))
    expect(rustHex.byteLength).toBe(64) // hex contract: 2x 32-byte digest
    if (isBun()) {
      const hasher = new Bun.CryptoHasher('sha256', key)
      hasher.update(data)
      const bunHex = encoder.encode(Buffer.from(hasher.digest()).toString('hex'))
      expect(Array.from(rustHex)).toEqual(Array.from(bunHex))
    }
  })

  test('gzipCompress decompresses to the original through both transports', () => {
    const compressed = rust.gzipCompress(data)
    expect(decoder.decode(rust.gzipDecompress(compressed))).toBe(TEXT)
    if (isBun()) {
      // Cross-transport: the addon decompresses Bun's output and vice versa
      // (only the gzip header OS byte differs: 0xFF vs 0x03).
      const bunCompressed = Bun.gzipSync(data as unknown as Uint8Array<ArrayBuffer>)
      expect(decoder.decode(rust.gzipDecompress(bunCompressed))).toBe(TEXT)
      expect(decoder.decode(Bun.gunzipSync(compressed as unknown as Uint8Array<ArrayBuffer>))).toBe(
        TEXT,
      )
    }
  })

  test('randomToken returns byteLen*2 lowercase-hex bytes', () => {
    for (const len of [1, 8, 16, 32]) {
      const tok = rust.randomToken(len)
      expect(tok.length).toBe(len * 2)
      expect(/^[0-9a-f]+$/.test(toText(tok))).toBe(true)
    }
    // Allocation guard preserved on the delegated path.
    expect(() => rust.randomToken(16 * 1024 * 1024 + 1)).toThrow()
  })

  test('urlEncode matches encodeURIComponent and the addon (byte-for-byte)', () => {
    const input = encoder.encode('hello world & foo=bar?q=1')
    const expected = isBun()
      ? encoder.encode(encodeURIComponent(decoder.decode(input)))
      : getAddon().urlEncode(input)
    expect(Array.from(encoder.encode(rust.urlEncode(input)))).toEqual(Array.from(expected))
    expect(Array.from(encoder.encode(rust.urlEncode(input)))).toEqual(
      Array.from(getAddon().urlEncode(input)),
    )
  })

  test('urlDecode matches decodeURIComponent and the addon (byte-for-byte)', () => {
    const input = encoder.encode('hello%20world%20%26%20foo%3Dbar')
    const expected = isBun()
      ? encoder.encode(decodeURIComponent(decoder.decode(input)))
      : getAddon().urlDecode(input)
    expect(Array.from(rust.urlDecode(input))).toEqual(Array.from(expected))
    expect(Array.from(rust.urlDecode(input))).toEqual(Array.from(getAddon().urlDecode(input)))
  })

  test('base64Encode (standard padded) matches Buffer and the addon', () => {
    const input = encoder.encode('hello world hello world hello world')
    const expected = isBun()
      ? encoder.encode(Buffer.from(input).toString('base64'))
      : getAddon().base64Encode(input)
    expect(Array.from(encoder.encode(rust.base64Encode(input)))).toEqual(Array.from(expected))
    expect(Array.from(encoder.encode(rust.base64Encode(input)))).toEqual(
      Array.from(getAddon().base64Encode(input)),
    )
  })

  test('httpDate matches Date.toUTCString() and the addon', () => {
    const secs = 1_700_000_000
    const expected = isBun()
      ? encoder.encode(new Date(secs * 1000).toUTCString())
      : getAddon().httpDate(secs)
    expect(Array.from(encoder.encode(rust.httpDate(secs)))).toEqual(Array.from(expected))
    expect(Array.from(encoder.encode(rust.httpDate(secs)))).toEqual(
      Array.from(getAddon().httpDate(secs)),
    )
  })
})
