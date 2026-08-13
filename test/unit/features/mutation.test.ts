/**
 * Corruption-detection matrix: a single bit-flip in a valid artifact must be
 * REJECTED (or degrade safely) — never silently accepted as the original, and
 * never crash the process.
 *
 * Covers the codecs that carry integrity metadata (gzip CRC trailer, JWT
 * signature, signed cookies, CSRF token) plus the parsers where structural
 * corruption must not throw out of the process (websocket frames, multipart).
 */

import { describe, test, expect } from 'bun:test'
import { rust } from '../../../src/rust-ffi'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('corruption-detection matrix (bit-flips must be rejected)', () => {
  test('gzip: any deflate/trailer bit-flip fails CRC → decompress throws', () => {
    const data = encoder.encode('the quick brown fox jumps over the lazy dog '.repeat(10))
    const gz = rust.gzipCompress(data)
    // Round-trip sanity first.
    expect(rust.gzipDecompress(gz)).toEqual(data)

    // Flip one byte across the DEFLATE DATA + CRC region (skip the 10-byte
    // header and the final 4-byte ISIZE, which some decoders ignore).
    for (let i = 10; i < gz.length - 4; i += 7) {
      const bad = gz.slice()
      bad[i] = ((bad[i] ?? 0) ^ 0xff) & 0xff
      // gzip validates the CRC32 trailer over the uncompressed data, so ANY
      // corruption of the compressed stream must throw.
      expect(() => rust.gzipDecompress(bad)).toThrow()
    }
  })

  test('gzip: bad magic bytes are rejected', () => {
    const gz = rust.gzipCompress(encoder.encode('hello'))
    const bad = gz.slice()
    bad[0] = 0x00 // 0x1f 0x8b → 0x00 0x8b
    expect(() => rust.gzipDecompress(bad)).toThrow()
  })

  test('brotli: truncated/corrupted streams throw or return bounded output, never crash', () => {
    const data = encoder.encode('hello brotli world '.repeat(20))
    const br = rust.brotliCompress(data)
    for (const cut of [1, 2, 5, Math.floor(br.length / 2), br.length - 1]) {
      const truncated = br.slice(0, cut)
      try {
        const out = rust.brotliDecompress(truncated)
        // If it succeeds at all, the output must be bounded (never a garbage
        // read past the stream).
        expect(out.length).toBeLessThanOrEqual(data.length)
      } catch {
        // expected: invalid / truncated stream
      }
    }
  })

  test('ws frames: structural corruption never throws (reject or bounded decode)', () => {
    const payload = encoder.encode('hello websocket')
    const frame = rust.wsFrameEncode(1, payload, false, true)

    const ok = rust.wsFrameDecode(frame)
    expect(ok).not.toBeNull()
    expect(ok?.opcode).toBe(1)
    expect(decoder.decode(ok?.payload ?? new Uint8Array(0))).toBe('hello websocket')

    // Invalid opcode (reserved 0x03) — must not throw; may reject.
    const badOpcode = frame.slice()
    badOpcode[0] = 0x80 | 0x03
    expect(() => rust.wsFrameDecode(badOpcode)).not.toThrow()

    // RSV1 bit set — must not throw.
    const badRsv = frame.slice()
    badRsv[0] = ((badRsv[0] ?? 0) | 0x40) & 0xff
    expect(() => rust.wsFrameDecode(badRsv)).not.toThrow()

    // Corrupt the 7-bit length byte (flip MSB → 128+ payload) — must not crash.
    const badLen = frame.slice()
    badLen[1] = ((badLen[1] ?? 0) ^ 0x80) & 0xff
    expect(() => rust.wsFrameDecode(badLen)).not.toThrow()

    // Truncated frame — must not throw (returns null or partial).
    expect(() => rust.wsFrameDecode(frame.subarray(0, frame.length - 3))).not.toThrow()
  })

  test('jwt: signature / header / claims tampering → verify null', () => {
    const secret = encoder.encode('s3cr3t-key-0123456789')
    const claims = encoder.encode('{"sub":"123","role":"admin"}')
    const token = rust.jwtSignBytes(claims, secret)

    expect(rust.jwtVerify(token, secret)).not.toBeNull()

    // Tamper the signature (the final segment; flip the LAST base64url char).
    const badSig = token.slice()
    badSig[badSig.length - 1] = ((badSig[badSig.length - 1] ?? 0) ^ 0x01) & 0xff
    expect(rust.jwtVerify(badSig, secret)).toBeNull()

    // Tamper the header (flip a byte in the first segment).
    const badAlg = token.slice()
    badAlg[4] = ((badAlg[4] ?? 0) ^ 0x01) & 0xff
    expect(rust.jwtVerify(badAlg, secret)).toBeNull()

    // Tamper a claim byte (flip a byte after the first dot).
    const firstDot = token.indexOf(0x2e)
    const badClaims = token.slice()
    badClaims[firstDot + 1] = ((badClaims[firstDot + 1] ?? 0) ^ 0x01) & 0xff
    expect(rust.jwtVerify(badClaims, secret)).toBeNull()

    // Wrong secret.
    expect(rust.jwtVerify(token, encoder.encode('other-secret'))).toBeNull()
  })

  test('signed cookies + CSRF: tampering → verify null/false', () => {
    const secret = encoder.encode('s3cr3t-secret')
    const value = encoder.encode('session=abc123')
    const signed = rust.signCookie(value, secret)
    expect(rust.verifyCookie(signed, secret)).not.toBeNull()

    // Tamper the value part (first byte).
    const badValue = signed.slice()
    badValue[0] = ((badValue[0] ?? 0) ^ 0x01) & 0xff
    expect(rust.verifyCookie(badValue, secret)).toBeNull()

    // Tamper the signature part (after the last dot).
    const lastDot = signed.lastIndexOf(0x2e)
    const badSig = signed.slice()
    badSig[lastDot + 1] = ((badSig[lastDot + 1] ?? 0) ^ 0x01) & 0xff
    expect(rust.verifyCookie(badSig, secret)).toBeNull()

    // Wrong secret.
    expect(rust.verifyCookie(signed, encoder.encode('other-secret'))).toBeNull()

    // CSRF token: tamper → verify false.
    const csrf = rust.csrfToken(secret)
    expect(rust.csrfVerify(csrf, secret)).toBe(true)
    const badCsrf = csrf.slice()
    badCsrf[10] = ((badCsrf[10] ?? 0) ^ 0x01) & 0xff
    expect(rust.csrfVerify(badCsrf, secret)).toBe(false)
  })

  test('multipart: boundary inside a value must not split; truncated trailer is safe', () => {
    const boundaryText = '----abc123'
    const boundary = encoder.encode(boundaryText)
    const body = encoder.encode(
      `--${boundaryText}\r\n` +
        'Content-Disposition: form-data; name="a"\r\n\r\n' +
        `value with --${boundaryText} inside\r\n` +
        `--${boundaryText}--\r\n`,
    )

    const parts = rust.multipartParse(body, boundary)
    // The boundary-looking substring INSIDE the value (not on its own line)
    // must NOT create a new part.
    expect(parts.length).toBe(1)
    expect(decoder.decode(parts[0]?.data ?? new Uint8Array(0))).toContain('value with')

    // Truncated trailer → no crash, bounded result.
    const truncated = body.subarray(0, body.length - 3)
    expect(() => rust.multipartParse(truncated, boundary)).not.toThrow()

    // CRLF injection in a value must not create a header line.
    const crlfBody = encoder.encode(
      `--${boundaryText}\r\n` +
        'Content-Disposition: form-data; name="a"\r\n\r\n' +
        'evil\r\nX-Injected: 1\r\nstill a value\r\n' +
        `--${boundaryText}--\r\n`,
    )
    const parts2 = rust.multipartParse(crlfBody, boundary)
    expect(parts2.length).toBe(1)
    expect(decoder.decode(parts2[0]?.data ?? new Uint8Array(0))).toContain('evil')
  })
})
