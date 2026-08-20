/**
 * Tests for the Rust JSON FFI: `rust.jsonParse` (sonic-rs → JS value) and the
 * native `SchemaValidator` scalar/batch validation, cross-checked against the
 * JS baselines (`JSON.parse` and ajv).
 */

import { describe, expect, test } from 'bun:test'
import {
  nativeJsonSchemaValidate,
  nativeJsonSchemaValidateBatch,
} from '../../../src/bench/schema-baseline'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { opImpl } from '../../../src/selection'
import { encoder } from '../../../src/shared/bytes'

const SCHEMA = encoder.encode(
  JSON.stringify({
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'number' },
      name: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  }),
)

const VALID_DOC = encoder.encode(JSON.stringify({ id: 1, name: 'alice' }))
const INVALID_DOC = encoder.encode(JSON.stringify({ id: 'x', name: 42 }))

describe('rust.jsonParse', () => {
  test('parses to a JS value matching JSON.parse', () => {
    const bytes = encoder.encode('{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}')
    const parsed = rust.jsonParse(bytes) as Record<string, unknown>
    const expected = JSON.parse('{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}')

    expect(parsed.a).toBe(1)
    expect(parsed.b).toEqual([true, null, 'x'])
    expect(parsed.c).toEqual({ d: 2.5 })
    expect(parsed).toEqual(expected)
  })

  test('parses a large array of rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `u${i}` }))
    const parsed = rust.jsonParse(encoder.encode(JSON.stringify(rows))) as unknown[]
    expect(parsed.length).toBe(1000)
    expect((parsed[500] as { id: number }).id).toBe(500)
  })

  test('throws on invalid JSON', () => {
    expect(() => rust.jsonParse(encoder.encode('{not json'))).toThrow()
    expect(() => rust.jsonParse(new Uint8Array(0))).toThrow()
  })
})

describe('decodeJsonPacked (packed structural path)', () => {
  // The packed path is what `rust.jsonParse` uses on Bun (FFI-first). These
  // tests pin byte-parity with `JSON.parse` — the whole point is that the C
  // side parses once and the JS decoder assembles the value with no re-parse.

  test('deep-equals JSON.parse for nested values', () => {
    // NOTE: `-0` is intentionally NOT asserted — sonic-rs (like the napi
    // `json_parse` DOM path) normalizes `-0` to `0`, so the packed path
    // matches the addon, not JSC's JSON.parse, for that sign edge case.
    const src = '{"a":1,"b":[true,null,"x"],"c":{"d":2.5},"f":""}'
    expect(rust.jsonParse(encoder.encode(src))).toEqual(JSON.parse(src))
  })

  test('dedups repeated strings (single decode per unique string)', () => {
    // Keys and the value "v" repeat across rows — the string table must hold
    // each unique string once. Exercised through the public FFI path: the
    // result is still deep-equal to JSON.parse.
    const src = '[{"k":"v","n":"v"},{"k":"w","n":"v"}]'
    expect(rust.jsonParse(encoder.encode(src))).toEqual(JSON.parse(src))
  })

  test('large array of rows matches JSON.parse (numbers as f64)', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, score: i * 1.25 }))
    const parsed = rust.jsonParse(encoder.encode(JSON.stringify(rows))) as unknown[]
    expect(parsed).toEqual(JSON.parse(JSON.stringify(rows)))
    expect((parsed[999] as { score: number }).score).toBeCloseTo(1248.75)
  })

  test('duplicate object keys are last-wins, matching JSON.parse', () => {
    const src = '{"a":1,"a":2}'
    expect(rust.jsonParse(encoder.encode(src))).toEqual(JSON.parse(src))
  })

  test('big integers round-trip like JS numbers (f64 rounding)', () => {
    const src = '[9007199254740993,-9007199254740993,1e308]'
    expect(rust.jsonParse(encoder.encode(src))).toEqual(JSON.parse(src))
  })
})

describe('SchemaValidator.validate (scalar)', () => {
  const validator = rust.createSchemaValidator(SCHEMA)

  test('accepts a valid doc, matching ajv', () => {
    expect(validator.validate(VALID_DOC)).toBe(true)
    expect(nativeJsonSchemaValidate(VALID_DOC, SCHEMA)).toBe(true)
  })

  test('rejects an invalid doc, matching ajv', () => {
    expect(validator.validate(INVALID_DOC)).toBe(false)
    expect(nativeJsonSchemaValidate(INVALID_DOC, SCHEMA)).toBe(false)
  })

  test("is bound to the native addon (opImpl is 'native', never 'js')", () => {
    // Guards the exact regression class: if the consumer binding resolves to
    // 'js' (e.g. createSchemaValidator dropped from selection.json), schema
    // validation silently falls back to a JS validator (ajv) even though the
    // addon is faster — this is how the ignus core schema-validate regression
    // surfaced.
    expect(getAddon().opImpl('createSchemaValidator')).toBe('native')
    expect(opImpl('createSchemaValidator')).not.toBeNull()
  })
})

describe('SchemaValidator batch', () => {
  const validator = rust.createSchemaValidator(SCHEMA)

  test('count matches the JS baseline', () => {
    const docs = [VALID_DOC, VALID_DOC, INVALID_DOC, VALID_DOC]
    expect(rust.batch.schemaValidateCount(validator, docs)).toBe(3)
    expect(nativeJsonSchemaValidateBatch(docs, SCHEMA)).toBe(3)
  })
})

describe('SchemaValidator detailed errors', () => {
  const validator = rust.createSchemaValidator(SCHEMA)
  test('validateDetailed returns [] for a valid doc', () => {
    expect(validator.validateDetailed(VALID_DOC)).toEqual([])
  })

  test('validateDetailed reports instance path + keyword', () => {
    const errs = validator.validateDetailed(INVALID_DOC)
    expect(errs.length).toBeGreaterThan(0)
    const e = errs[0]
    expect(e?.instancePath).toBe('/id')
    expect(e?.keyword).toBe('type')
    expect(e?.schemaPath).toBe('/properties/id/type')
    expect(e?.message.length ?? 0).toBeGreaterThan(0)
  })

  test('validateFirstError returns null for a valid doc', () => {
    expect(validator.validateFirstError(VALID_DOC)).toBeNull()
  })

  test('validateFirstError returns a single error for an invalid doc', () => {
    const first = validator.validateFirstError(INVALID_DOC)
    expect(first).not.toBeNull()
    expect(first?.instancePath).toBe('/id')
  })

  test('agrees with validate()', () => {
    for (const doc of [VALID_DOC, INVALID_DOC]) {
      const ok = validator.validate(doc)
      const errs = validator.validateDetailed(doc)
      const first = validator.validateFirstError(doc)
      expect(ok).toBe(errs.length === 0)
      expect(ok ? first == null : first != null).toBe(true)
    }
  })

  test('collects multiple errors (pattern + additionalProperties)', () => {
    const schema = encoder.encode(
      JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[a-z]+$' },
        },
        additionalProperties: false,
      }),
    )
    const v = rust.createSchemaValidator(schema)
    const errs = v.validateDetailed(encoder.encode(JSON.stringify({ name: 'AB', extra: 1 })))
    const keywords = errs.map((e) => e.keyword)
    expect(keywords).toContain('pattern')
    expect(keywords).toContain('additionalProperties')
  })
})

describe('SchemaValidator.derive (one-pass validate + extract)', () => {
  const ORDERS_SCHEMA = encoder.encode(
    JSON.stringify({
      type: 'object',
      required: ['orderId', 'customer', 'lineItems', 'totalCents'],
      properties: {
        orderId: { type: 'string' },
        customer: {
          type: 'object',
          required: ['id', 'email'],
          properties: { id: { type: 'string' }, email: { type: 'string' } },
        },
        lineItems: {
          type: 'array',
          items: {
            type: 'object',
            required: ['sku', 'quantity'],
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
          },
        },
        totalCents: { type: 'integer' },
      },
      additionalProperties: false,
    }),
  )
  const ORDERS_DOC = encoder.encode(
    JSON.stringify({
      orderId: 'ord_1',
      customer: { id: 'cus_1', email: 'a@b.c' },
      lineItems: [
        { sku: 'A', quantity: 2 },
        { sku: 'B', quantity: 3 },
        { sku: 'C', quantity: 1 },
      ],
      totalCents: 108000,
    }),
  )
  const validator = rust.createSchemaValidator(ORDERS_SCHEMA)

  test('extracts array length + integer + string in one pass', () => {
    const r = validator.derive(ORDERS_DOC, ['/lineItems/-', '/totalCents', '/orderId'])
    expect(r.ok).toBe(true)
    // napi omits null fields, so assert the populated ones only.
    expect(r.values[0]).toMatchObject({ kind: 'int', int: 3 })
    expect(r.values[1]).toMatchObject({ kind: 'int', int: 108000 })
    expect(r.values[2]).toMatchObject({ kind: 'string', text: 'ord_1' })
  })

  test('missing path yields null value on a valid doc', () => {
    const r = validator.derive(ORDERS_DOC, ['/nope'])
    expect(r.ok).toBe(true)
    expect(r.values[0]).toBeNull()
  })

  test('schema-invalid doc: ok=false, values null', () => {
    const bad = encoder.encode(
      JSON.stringify({
        orderId: 'o',
        customer: { id: 'c', email: 'e@x' },
        lineItems: [{ sku: 123, quantity: 2 }],
        totalCents: 1,
      }),
    )
    const r = validator.derive(bad, ['/lineItems/-', '/totalCents'])
    expect(r.ok).toBe(false)
    expect(r.values[0]).toBeNull()
    expect(r.values[1]).toBeNull()
  })

  test('ok matches validate() (cross-check)', () => {
    const docs = [ORDERS_DOC, encoder.encode('{oops')]
    for (const doc of docs) {
      const expected = validator.validate(doc)
      const r = validator.derive(doc, ['/totalCents'])
      expect(r.ok).toBe(expected)
    }
  })

  test('invalid path throws', () => {
    expect(() => validator.derive(ORDERS_DOC, ['lineItems'])).toThrow()
    expect(() => validator.derive(ORDERS_DOC, ['/lineItems/0'])).toThrow()
  })
})
