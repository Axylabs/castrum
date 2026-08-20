/**
 * Tests for the Rust JSON Patch FFI: `rust.jsonPatch` (RFC 6902) and
 * `rust.batch.jsonPatch` (packed zipped batch), pinned against the DOM result.
 *
 * Split from json.test.ts (which covers `rust.jsonParse` + `SchemaValidator`).
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder, toText } from '../../../src/shared/bytes'

describe('rust.jsonPatch', () => {
  test('replaces a field', () => {
    const doc = encoder.encode('{"name":"alice","age":30}')
    const patch = encoder.encode('[{"op":"replace","path":"/age","value":31}]')
    const out = rust.jsonPatch(doc, patch)
    expect(JSON.parse(toText(out))).toEqual({ name: 'alice', age: 31 })
  })

  test('supports add/remove on arrays', () => {
    const doc = encoder.encode('{"items":["a","b"]}')
    const patch = encoder.encode(
      '[{"op":"add","path":"/items/-","value":"c"},{"op":"remove","path":"/items/0"}]',
    )
    const out = rust.jsonPatch(doc, patch)
    expect(JSON.parse(toText(out))).toEqual({ items: ['b', 'c'] })
  })

  test('applies a real-world multi-op patch', () => {
    const doc = encoder.encode(
      JSON.stringify({
        id: 'usr_01H2X9K7',
        profile: { displayName: 'Alice', preferences: { theme: 'dark' } },
        roles: ['admin'],
      }),
    )
    const patch = encoder.encode(
      JSON.stringify([
        { op: 'replace', path: '/profile/preferences/theme', value: 'light' },
        { op: 'add', path: '/roles/-', value: 'reviewer' },
      ]),
    )
    const out = rust.jsonPatch(doc, patch)
    expect(JSON.parse(toText(out))).toEqual({
      id: 'usr_01H2X9K7',
      profile: { displayName: 'Alice', preferences: { theme: 'light' } },
      roles: ['admin', 'reviewer'],
    })
  })

  test('throws on invalid document or patch', () => {
    expect(() => rust.jsonPatch(encoder.encode('not-json'), encoder.encode('[]'))).toThrow()
    expect(() => rust.jsonPatch(encoder.encode('{}'), encoder.encode('not-json'))).toThrow()
  })

  test('throws with contextual error message', () => {
    let message = ''
    try {
      rust.jsonPatch(encoder.encode('{bad'), encoder.encode('[]'))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('invalid document')
  })

  test('applies move, copy, and test ops', () => {
    const moved = rust.jsonPatch(
      encoder.encode('{"arr":[1,2,3],"obj":{}}'),
      encoder.encode('[{"op":"move","from":"/arr/0","path":"/obj/first"}]'),
    )
    expect(JSON.parse(toText(moved))).toEqual({
      arr: [2, 3],
      obj: { first: 1 },
    })

    const copied = rust.jsonPatch(
      encoder.encode('{"a":{"x":1},"b":null}'),
      encoder.encode('[{"op":"copy","from":"/a","path":"/b"}]'),
    )
    expect(JSON.parse(toText(copied))).toEqual({ a: { x: 1 }, b: { x: 1 } })

    // `test` mismatch throws.
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"v":42}'),
        encoder.encode('[{"op":"test","path":"/v","value":43}]'),
      ),
    ).toThrow(/apply failed/)
  })

  test('rejects invalid RFC 6901 escapes (~2, trailing ~)', () => {
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"a/b":1}'),
        encoder.encode('[{"op":"replace","path":"/a~2b","value":2}]'),
      ),
    ).toThrow(/invalid patch/)
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"a":1}'),
        encoder.encode('[{"op":"replace","path":"/a~","value":2}]'),
      ),
    ).toThrow(/invalid patch/)
  })
})

describe('rust.batch.jsonPatch', () => {
  test('zips docs and patches, matching scalar results', () => {
    const docs = [encoder.encode('{"a":1}'), encoder.encode('{"items":["x"]}')]
    const patches = [
      encoder.encode('[{"op":"replace","path":"/a","value":2}]'),
      encoder.encode('[{"op":"add","path":"/items/-","value":"y"}]'),
    ]
    const results = rust.batch.jsonPatch(docs, patches)
    expect(results.length).toBe(2)
    expect(JSON.parse(decoder.decode(results[0]))).toEqual({ a: 2 })
    expect(JSON.parse(decoder.decode(results[1]))).toEqual({ items: ['x', 'y'] })
  })

  test('fails fast when the packed counts mismatch', () => {
    expect(() => rust.batch.jsonPatch([encoder.encode('{}')], [])).toThrow(/count/)
  })

  test('fails fast on an invalid item', () => {
    expect(() =>
      rust.batch.jsonPatch(
        [encoder.encode('{"a":1}'), encoder.encode('{bad')],
        [encoder.encode('[]'), encoder.encode('[]')],
      ),
    ).toThrow()
  })

  test('reports the failing item index', () => {
    let message = ''
    try {
      rust.batch.jsonPatch(
        [encoder.encode('{"a":1}'), encoder.encode('{bad'), encoder.encode('{"c":3}')],
        [encoder.encode('[]'), encoder.encode('[]'), encoder.encode('[]')],
      )
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('item 1')
    expect(message).toContain('invalid document')
  })

  test('empty batch returns an empty result set', () => {
    expect(rust.batch.jsonPatch([], [])).toEqual([])
  })

  test('reports failure on the first and last item with the right index', () => {
    for (const bad of [0, 2]) {
      const docs = [encoder.encode('{"a":1}'), encoder.encode('{"b":2}'), encoder.encode('{"c":3}')]
      docs[bad] = encoder.encode('{bad')
      const patches = [encoder.encode('[]'), encoder.encode('[]'), encoder.encode('[]')]
      let message = ''
      try {
        rust.batch.jsonPatch(docs, patches)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain(`item ${bad}`)
    }
  })
})
