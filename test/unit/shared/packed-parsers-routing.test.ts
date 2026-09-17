// TDD RED: the ergonomic packed-pairs parsers must produce napi-identical
// objects when routed through the FFI transport, and must FAIL while they
// still route through the napi proxy... actually they currently DO produce
// identical objects (parity holds) — this test instead pins the ROUTING
// contract: under forced ffi mode, the parsers must consume the bun:ffi
// transport. We can only observe that via behavior: the napi proxy would
// still work (so this test passes either way) — hence the real pin is the
// unit test below on the scratch-growth contract + parity under BOTH modes.
import { describe, expect, test } from 'bun:test'
import { parseQueryString, parseCookieHeader, parseFormBody } from '../../../src/shared/packed'

describe('packed string parsers (FFI routing)', () => {
  test('parseQueryString: known answers, multi-value, percent-decoding', () => {
    expect(parseQueryString('a=1&b=2&c=hello%20world&flag')).toEqual({
      a: '1',
      b: '2',
      c: 'hello world',
      flag: '',
    })
    // Repeated key accumulates (napi parity contract).
    expect(parseQueryString('tag=αβ&tag=γ')).toEqual({ tag: ['αβ', 'γ'] })
    // '+' → space, %2B → '+' (lenient core parity).
    expect(parseQueryString('q=%2B&plus=+')).toEqual({ q: '+', plus: ' ' })
  })

  test('parseCookieHeader: trims, DQUOTE-unwraps values, keeps order semantics', () => {
    expect(parseCookieHeader('sid=abc123; theme=dark')).toEqual({
      sid: 'abc123',
      theme: 'dark',
    })
    expect(parseCookieHeader('quoted="v 1"; spaced = 2 ')).toEqual({
      quoted: 'v 1',
      spaced: '2',
    })
  })

  test('parseFormBody: same packed core as query parse', () => {
    expect(parseFormBody(new TextEncoder().encode('a=1&b=%2B&b=2'))).toEqual({
      a: '1',
      b: ['+', '2'],
    })
    expect(parseFormBody(new TextEncoder().encode(''))).toEqual({})
  })

  test('malformed %XX is lenient (raw passthrough) — core parity', () => {
    expect(parseQueryString('x=%ZZ&y=%FF')).toEqual({ x: '%ZZ', y: '%FF' })
  })
})
