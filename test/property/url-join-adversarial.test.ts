/**
 * Property test: `urlResolve` SSRF-safety invariants over seeded inputs.
 *
 * `rust.urlResolve` is an RFC 3986 resolver; the WHATWG URL baseline differs
 * on PATH details (non-ASCII percent-encoding, `%2e%2e` collapsing, trailing
 * slash). The SSRF-relevant invariant is that BOTH resolve to the same
 * `(scheme, host)` — an SSRF filter keyed on the resolved host must never see
 * a divergent host, and the resolver must never emit a backslash (a classic
 * filter-bypass). This pins those invariants over seeded fuzz + a hostile
 * internal-address corpus. All draws are seeded (./seeded.ts) for replay.
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../src/rust-ffi'
import { decoder, encoder } from '../../src/shared/bytes'
import { seededRandom } from './seeded'
import { nativeUrlResolve } from '../../src/bench/url-join-baseline'

const rand = seededRandom()

const SEGMENTS = [
  'a',
  'b',
  'v2',
  'items',
  '42',
  '..',
  '.',
  '',
  'x%20y',
  '%2e%2e',
  '%2F',
  'a%2Fb',
  'user@host',
  '~t',
  '*s*',
  '?q=1',
  '#f',
  '..%2f',
  '%2e%2e%2f',
  'café',
  '你好',
  '-',
  '_',
  '/',
]

const BASES = [
  encoder.encode('http://example.com/api/users?page=1'),
  encoder.encode('https://app.example.com:8443/deep/path/to/resource'),
  encoder.encode('http://127.0.0.1/'),
  encoder.encode('http://[::1]:8080/x'),
]

/** `protocol//host` (drops userinfo + path) — what an SSRF host filter sees. */
function hostPort(u: string): string | null {
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host}`
  } catch {
    return null
  }
}

/** Resolve a reference against `base` with BOTH engines; null on throw. */
function resolveBoth(base: Uint8Array, ref: string): { expected: string | null; actual: string | null } {
  const refBytes = encoder.encode(ref)
  let expected: string | null = null
  try {
    expected = decoder.decode(nativeUrlResolve(base, refBytes))
  } catch {
    expected = null
  }
  let actual: string | null = null
  try {
    actual = decoder.decode(rust.urlResolve(base, refBytes))
  } catch {
    actual = null
  }
  return { expected, actual }
}

describe('urlResolve SSRF-safety (property, seeded)', () => {
  test('resolved (scheme, host) always matches the WHATWG baseline', () => {
    for (let i = 0; i < 500; i++) {
      const base = BASES[Math.floor(rand() * BASES.length)] ?? BASES[0] ?? new Uint8Array(0)
      if (base.byteLength === 0) continue
      const parts: string[] = []
      const n = Math.floor(rand() * 4)
      for (let j = 0; j < n; j++) {
        parts.push(SEGMENTS[Math.floor(rand() * SEGMENTS.length)] ?? '')
      }
      const ref = parts.join('/')
      const { expected, actual } = resolveBoth(base, ref)
      // Both parse → the resolved host must agree (SSRF invariant).
      if (expected !== null && actual !== null) {
        expect(hostPort(actual)).toBe(hostPort(expected))
      }
      // The resolver never emits a backslash (no backslash-normalization
      // divergence that could bypass a downstream filter).
      if (actual !== null) {
        expect(actual).not.toContain('\\')
      }
    }
  })

  test('hostile SSRF corpus resolves to the same (scheme, host) as WHATWG', () => {
    const base = encoder.encode('http://example.com/api/users?page=1')
    const corpus = [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      '//internal.example/secret',
      '//127.0.0.1/',
      'http://user:pass@internal/x',
      'http://internal.example:80@evil.com/y',
      'http://localhost/',
      'http://0x7f000001/',
      'http://2130706433/',
    ]
    for (const ref of corpus) {
      const { expected, actual } = resolveBoth(base, ref)
      if (expected !== null && actual !== null) {
        expect(hostPort(actual)).toBe(hostPort(expected))
      }
    }
  })

  test('documented divergence: non-ASCII path bytes stay raw (RFC 3986), not %-encoded', () => {
    // Pin the RFC 3986 behavior as a conscious contract: rust keeps UTF-8 bytes
    // raw in the path while WHATWG percent-encodes them. Not a bug — but it
    // must be deliberate, so callers who need WHATWG-style output normalize.
    const base = encoder.encode('https://example.com/base')
    const actual = decoder.decode(rust.urlResolve(base, encoder.encode('café')))
    expect(actual).toBe('https://example.com/café')
  })
})
