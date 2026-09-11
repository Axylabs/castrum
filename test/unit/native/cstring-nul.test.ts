// test/unit/native/cstring-nul.test.ts — the `cstring`-arg NUL contract.
//
// `bun:ffi` transcodes a JS string passed to a `cstring` ARG into a
// NUL-TERMINATED UTF-8 buffer (Bun's docs: the engine "transcodes the string to
// a null-terminated UTF-8 buffer that lives for the duration of the call, so
// you don't need to encode it into a Buffer yourself"). The C convention it
// inherits means an embedded `U+0000` SILENTLY TRUNCATES the value native-side.
//
// That trade is a win for NUL-free text (developer config, header names, MIME
// extensions, base64 keys): it removes an encode per call. It is a BUG wherever
// the callee answers with a VERDICT or the exact bytes ARE the result:
//
//   rust.validateEmail(bytes of 'a@b.com\0<script>')  === true   ← shipped bug
//   rust.regexEscape('abc\0def')                      === 'abc'  ← shipped bug
//
// Two layers now prevent that: byte-input APIs cross as `buffer`/`buffer_length`
// (exact length, zero transcode — also measured FASTER), and every remaining
// `cstring` ARG reachable from user input is guarded. These tests pin both, so
// a future "let the engine transcode it instead" refactor cannot regress it.

import { describe, expect, test } from 'bun:test'
import { getBunFFI } from '../../../src/native/ffi'
import { rust } from '../../../src/rust-ffi'

const NUL = '\u0000'
const enc = new TextEncoder()

describe('cstring-arg NUL contract', () => {
  describe('byte-input verdicts cross as (buffer, buffer_length)', () => {
    test('validateEmail', () => {
      expect(rust.validateEmail(enc.encode('a@b.com'))).toBe(true)
      // A NUL BYTE used to truncate (bytes → JS string → cstring ARG), so the
      // prefix validated and a non-address was reported valid.
      expect(rust.validateEmail(enc.encode(`a@b.com${NUL}<script>alert(1)</script>`))).toBe(false)
      expect(rust.validateEmail(enc.encode(`a@b.com${NUL}`))).toBe(false)
      expect(rust.validateEmail(enc.encode('not-an-address'))).toBe(false)
    })

    test('validateUuid', () => {
      const uuid = '123e4567-e89b-42d3-a456-426614174000'
      expect(rust.validateUuid(enc.encode(uuid))).toBe(true)
      expect(rust.validateUuid(enc.encode(`${uuid}${NUL}x`))).toBe(false)
    })

    test('validateIpv4', () => {
      expect(rust.validateIpv4(enc.encode('1.2.3.4'))).toBe(true)
      expect(rust.validateIpv4(enc.encode(`1.2.3.4${NUL}junk`))).toBe(false)
    })

    test('validateIpv6', () => {
      expect(rust.validateIpv6(enc.encode('::1'))).toBe(true)
      expect(rust.validateIpv6(enc.encode(`::1${NUL}junk`))).toBe(false)
    })

    test('hexValidateBatch keeps one verdict per input line', () => {
      const good = '507f1f77bcf86cd799439011'
      expect([...rust.hexValidateBatch([good, 'zz'], 24)]).toEqual([1, 0])

      // A NUL inside the joined `\n`-separated list would truncate native-side,
      // so entries after it would produce NO verdict (and a bad id could pass as
      // its own prefix).
      const withNul = rust.hexValidateBatch([good, `zz${NUL}`, good], 24)
      expect(withNul.length).toBe(3)
      expect([...withNul]).toEqual([1, 0, 1])
    })
  })

  describe('the cstring ARG forms stay guarded too (second layer)', () => {
    test('string-form validators reject rather than truncate', () => {
      const ffi = getBunFFI()
      expect(ffi).not.toBeNull()
      if (!ffi) return
      expect(ffi.validateEmail('a@b.com')).toBe(true)
      expect(ffi.validateEmail(`a@b.com${NUL}<script>`)).toBe(false)
      expect(ffi.validateUuid(`123e4567-e89b-42d3-a456-426614174000${NUL}x`)).toBe(false)
      expect(ffi.validateIpv4(`1.2.3.4${NUL}junk`)).toBe(false)
      expect(ffi.validateIpv6(`::1${NUL}junk`)).toBe(false)
    })

    test('regexEscape escapes the whole string, NUL included', () => {
      expect(rust.regexEscape('a.c(x)')).toBe('a\\.c\\(x\\)')
      // Previously returned 'abc' — the NUL threw away 'def'.
      const text = `abc${NUL}def`
      const escaped = rust.regexEscape(text)
      expect(escaped.length).toBe(text.length)
      expect(escaped).toBe(text)
      expect(rust.regexEscape(`${NUL}(`)).toBe(`${NUL}\\(`)
    })
  })

  describe('byte-exact ops use the byte sibling', () => {
    test('wsAcceptKey hashes the FULL key, not a NUL-truncated prefix', () => {
      const key = 'dGhlIHNhbXBsZSBub25jZQ=='
      // `wsAcceptKey` is `Uint8Array | string` (bytes under napi, a string via
      // the cstring/byte decode under bun:ffi) — normalize for comparison.
      const good = String(rust.wsAcceptKey(enc.encode(key)))
      // RFC 6455's own example vector.
      expect(good).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

      const full = String(rust.wsAcceptKey(enc.encode(`${key}${NUL}junk`)))
      // Through the `cstring` ARG this used to EQUAL `good`: the suffix was
      // silently dropped and the accept value was computed for a prefix.
      expect(full).not.toBe(good)
      expect(full.length).toBe(28)

      // The string namespace takes the same byte path when a NUL is present.
      expect(rust.text.wsAcceptKey(key)).toBe(good)
      expect(rust.text.wsAcceptKey(`${key}${NUL}junk`)).toBe(full)
    })

    test('mimeFromExtension does not resolve a NUL-suffixed extension', () => {
      expect(rust.mimeFromExtension(enc.encode('.js'))).toBe('text/javascript')
      // A NUL used to truncate the decoded extension, so '.js\0evil' resolved as
      // '.js' — a Content-Type picked from a prefix. Unknown instead.
      expect(rust.mimeFromExtension(enc.encode(`.js${NUL}evil`))).toBe('application/octet-stream')
    })
  })

  describe('metrics: no silent series collision', () => {
    test('a NUL in a label value fails loudly instead of recording a prefix', () => {
      const registry = rust.createMetricsRegistry()
      const series = registry.counter('requests_total', ['path'])
      registry.record(series, ['/a'], 1)
      // Truncating to '/a' would silently corrupt the first series' count.
      expect(() => registry.record(series, [`/a${NUL}b`], 1)).toThrow(/NUL/)
      // The clean series is untouched by the rejected write.
      expect(registry.render()).toContain('path="/a"')
    })

    test('a NUL in a metric name or label key throws at declare time', () => {
      const registry = rust.createMetricsRegistry()
      expect(() => registry.counter(`bad${NUL}name`)).toThrow(/NUL/)
      expect(() => registry.counter('ok_name', [`k${NUL}`])).toThrow(/NUL/)
    })
  })
})
