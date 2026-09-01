/**
 * Tests for the batch fixed-width hex validator (`rust.hexValidateBatch`) and
 * the JS-RegExp escaper (`rust.regexEscape`) — public-surface behavior plus
 * addon (napi) parity for both transports.
 */

import { describe, expect, test } from 'bun:test'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { encoder as enc } from '../../../src/shared/bytes'

describe('hexValidateBatch', () => {
  test('one verdict per line, mixed case', () => {
    const input = '507f1f77bcf86cd799439011\n507F1F77BCF86CD799439012\nnothexhere!!\nshort'
    expect(Array.from(rust.hexValidateBatch(enc.encode(input), 24))).toEqual([1, 1, 0, 0])
  })

  test('trailing newline adds no extra verdict', () => {
    const out = rust.hexValidateBatch(enc.encode('deadbeef\nDEADBEEF\n'), 8)
    expect(Array.from(out)).toEqual([1, 1])
  })

  test('CRLF tolerated; empty line invalid; empty input → empty output', () => {
    expect(Array.from(rust.hexValidateBatch(enc.encode('ab\r\ncd\n'), 2))).toEqual([1, 1])
    expect(Array.from(rust.hexValidateBatch(enc.encode('\nab'), 2))).toEqual([0, 1])
    expect(rust.hexValidateBatch(enc.encode(''), 24).byteLength).toBe(0)
  })

  test('wrong width fails the line even if all-hex', () => {
    expect(Array.from(rust.hexValidateBatch(enc.encode('abcdef'), 3))).toEqual([0])
    expect(Array.from(rust.hexValidateBatch(enc.encode('abc'), 3))).toEqual([1])
  })

  test('width guard throws', () => {
    expect(() => rust.hexValidateBatch(enc.encode('ab'), 0)).toThrow()
    expect(() => rust.hexValidateBatch(enc.encode('ab'), 4097)).toThrow()
  })

  test('matches the addon (napi) output byte-for-byte', () => {
    const addon = getAddon()
    const input = enc.encode('507f1f77bcf86cd799439011\nzz\n')
    const expected = Array.from(addon.hexValidateBatch(input, 24))
    expect(Array.from(rust.hexValidateBatch(input, 24))).toEqual(expected)
  })
})

describe('regexEscape', () => {
  test('escapes every metacharacter exactly once', () => {
    // (string concat — a template literal here would trip noTemplateCurlyInString)
    const metas = '\\.*+?^$' + '{}()|[]'
    // Reference implementation of the same contract (MDN escapeRegExp).
    const expected = metas.replace(/[\\.*+?^${}()|[\]]/g, '\\$&')
    expect(rust.regexEscape(metas)).toBe(expected)
    expect(expected.startsWith('\\\\')).toBe(true) // leading backslash doubled
  })

  test('plain text and non-metachar punctuation pass through', () => {
    expect(rust.regexEscape('hello world 123')).toBe('hello world 123')
    expect(rust.regexEscape('a-b/c:d')).toBe('a-b/c:d') // -, / : are not RegExp metachars
  })

  test('multi-byte UTF-8 is preserved byte-exact', () => {
    expect(rust.regexEscape('héllo→世界')).toBe('héllo→世界')
  })

  test('defuses wildcard injection (literal semantics)', () => {
    const needle = rust.regexEscape('a.c')
    expect(new RegExp(needle, 'i').test('abc')).toBe(false) // "." must not match "b"
    expect(new RegExp(needle, 'i').test('A.C')).toBe(true)
  })

  test('accepts bytes or strings; matches the addon output', () => {
    const s = 'a.c*(x)'
    expect(rust.regexEscape(enc.encode(s))).toBe(rust.regexEscape(s))
    const addon = getAddon()
    expect(rust.regexEscape(s)).toBe(addon.regexEscape(s))
  })
})
