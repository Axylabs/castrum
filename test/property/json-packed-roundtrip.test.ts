/**
 * Property test: JSON packed round-trips over seeded pseudo-random documents.
 *
 * Data-integrity guard for the structural (packed) JSON surface on the public
 * `rust.*` API: `jsonValid` must agree with `JSON.parse` success, `jsonParse`
 * must deep-equal `JSON.parse` (including Unicode), and `jsonSumIds` must sum
 * numeric `id` fields across an array and throw on non-arrays. All draws are
 * seeded (./seeded.ts) so a failure replays deterministically.
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../src/rust-ffi'
import { encoder } from '../../src/shared/bytes'
import { seededRandom } from './seeded'

const rand = seededRandom()
const enc = encoder

function randInt(n: number): number {
  return Math.floor(rand() * n)
}

/** A JSON-safe number within the f64-exact integer range. */
function randNumber(): number {
  return Math.floor(rand() * 2000) - 1000
}

function randString(): string {
  // Whole, complete strings (never astral characters split into lone
  // surrogates) — indexing a string by UTF-16 code unit can yield a lone
  // surrogate, which is a separate edge case pinned below.
  const words = ['abc', 'hello world', '_x-', 'café', 'naïve', '你好世界', 'emoji🚀test', '€uro', '🐉dragon', '']
  let s = ''
  const len = randInt(4)
  for (let i = 0; i < len; i++) {
    s += words[randInt(words.length)] ?? ''
  }
  return s
}

function randValue(depth: number): unknown {
  const k = randInt(6)
  if (depth <= 0 || k === 0) return null
  if (k === 1) return rand() > 0.5
  if (k === 2) return randNumber()
  if (k === 3) return randString()
  if (k === 4) {
    const arr: unknown[] = []
    const n = randInt(5)
    for (let i = 0; i < n; i++) arr.push(randValue(depth - 1))
    return arr
  }
  const obj: Record<string, unknown> = {}
  const n = randInt(5)
  for (let i = 0; i < n; i++) obj[`k${i}`] = randValue(depth - 1)
  return obj
}

describe('JSON packed round-trips (property, seeded)', () => {
  test('jsonValid agrees with JSON.parse success on generated docs', () => {
    for (let i = 0; i < 300; i++) {
      const bytes = enc.encode(JSON.stringify(randValue(4)))
      expect(rust.jsonValid(bytes)).toBe(true)
    }
  })

  test('jsonValid rejects malformed documents', () => {
    // Each of these is invalid JSON per the JSON grammar.
    const bad = ['{', '[1,', '{"a":}', '{"a":1,}', 'nope', '', '{"a":01}', '[1,]', '{"a" 1}']
    for (const b of bad) {
      expect(rust.jsonValid(enc.encode(b))).toBe(false)
    }
  })

  test('jsonParse deep-equals JSON.parse for valid docs (incl. Unicode)', () => {
    for (let i = 0; i < 300; i++) {
      const doc = JSON.stringify(randValue(4))
      expect(rust.jsonParse(enc.encode(doc))).toEqual(JSON.parse(doc))
    }
  })

  test('jsonSumIds sums numeric ids across an array; non-arrays throw', () => {
    for (let i = 0; i < 200; i++) {
      const items: unknown[] = []
      let sum = 0n
      const n = randInt(10)
      for (let j = 0; j < n; j++) {
        const id = Math.floor(rand() * 2000) - 1000
        items.push({ id })
        sum += BigInt(id)
      }
      expect(rust.jsonSumIds(enc.encode(JSON.stringify(items)))).toBe(sum)
    }
    expect(() => rust.jsonSumIds(enc.encode('{"a":1}'))).toThrow()
    expect(() => rust.jsonSumIds(enc.encode('nope'))).toThrow()
  })

  test('documented edge: lone-surrogate escapes pass jsonValid but both parsers throw', () => {
    // A JSON string containing a lone surrogate (`\ud800`) is grammatically
    // valid but has NO UTF-8 encoding. Both native paths (packed FFI + napi)
    // reject it, while `jsonValid` (structural IgnoredAny check) accepts it.
    // Pinned so this gate-vs-parse divergence is a KNOWN, reviewed contract
    // rather than a silent surprise. (See the generated-doc loop above, which
    // deliberately avoids lone surrogates.)
    const doc = enc.encode('"\\ude80"')
    expect(rust.jsonValid(doc)).toBe(true)
    expect(() => rust.jsonParse(doc)).toThrow()
  })
})
