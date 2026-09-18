/**
 * test/unit/ingress/regex-dos.test.ts — ReDoS / resource-limit regression pin
 * for schema `pattern`.
 *
 * Trust boundary: `pattern` / `patternProperties` are supplied by the schema
 * author (the application developer), while the validated document is
 * attacker-controlled. `fast_schema` compiles these with `fancy-regex`, which
 * delegates regular (non-backtracking) patterns to the linear `regex` crate and
 * bounds patterns that do require backtracking with a 1,000,000-step limit
 * (`fancy-regex` default). A limit miss surfaces as `Err`, which both the fast
 * path and the `jsonschema` DOM fallback treat as a non-match — never a hang,
 * crash, or unbounded walk. These tests pin that:
 *
 *   1. The classic nested-quantifier pattern `^(a+)+$` is evaluated in LINEAR
 *      time on a large non-matching input (the Elysia analogue).
 *   2. The pattern is genuinely compiled/evaluated (matching text is accepted).
 *   3. A lookaround pattern that forces the backtracking VM is bounded by the
 *      engine's backtrack limit rather than running unbounded.
 *   4. The full ingress path (`createIngressHandler` + `jsonWriteHandler`) stays
 *      bounded on a large non-matching body.
 *
 * See SECURITY.md §"Schema `pattern` is trusted author input". The engine is
 * the SAME one the authoritative `jsonschema` fallback uses, so routing a
 * pattern to the fallback is not a mitigation.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler, jsonWriteHandler } from '../../../src/ingress/handlers'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

/**
 * Wall-clock budget for each operation. Deliberately generous: the measured
 * cost of the linear cases is ~0.1 ms for 50 KB, so this is >1000x headroom and
 * cannot flake on a loaded box. The discard case (no backtrack limit) is
 * effectively non-terminating — the universe would end first — so even a
 * 1000x-loaded budget still discriminates.
 */
const BUDGET_MS = 2_000

function schemaFor(pattern: string): Uint8Array {
  return encoder.encode(JSON.stringify({ type: 'string', pattern }))
}

function jsonStringOf(value: string): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

describe('schema pattern ReDoS regression pin', () => {
  test('nested-quantifier pattern is linear on a 50 KB non-matching string', () => {
    const validator = rust.createSchemaValidator(schemaFor('^(a+)+$'))
    // 50 KB of 'a' followed by '!' cannot match `^(a+)+$`; a naive
    // backtracking engine explores exponentially many paths here.
    const doc = jsonStringOf(`${'a'.repeat(50 * 1024)}!`)

    const t0 = performance.now()
    const ok = validator.validate(doc)
    const elapsed = performance.now() - t0

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  test('the pattern is actually evaluated (matching text is accepted)', () => {
    const validator = rust.createSchemaValidator(schemaFor('^(a+)+$'))
    // If the pattern were silently dropped (unsupported → fallback that is not
    // wired), the negative case would also pass. Pin both verdicts so the
    // regression pin above cannot pass vacuously.
    expect(validator.validate(encoder.encode('"aaa"'))).toBe(true)
    expect(validator.validate(encoder.encode('"aaab"'))).toBe(false)
  })

  test('backtracking patterns are bounded by the engine backtrack limit', () => {
    // The lookahead forces the fancy-regex backtracking VM. Without the
    // 1,000,000-step default limit, `(a+)+` is re-evaluated at every input
    // position and grows without bound; with it, each attempt errors out and
    // is treated as a non-match.
    const validator = rust.createSchemaValidator(schemaFor('(?=(a+)+$)a'))
    const doc = jsonStringOf(`${'a'.repeat(2_000)}b`)

    const t0 = performance.now()
    const ok = validator.validate(doc)
    const elapsed = performance.now() - t0

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  test('ingress schema validation stays bounded on a large non-matching body', async () => {
    const schema = schemaFor('^(a+)+$')
    const h = createIngressHandler({ requireJsonBody: true, schema, enableBodySizeGuard: true }, {})
    const body = JSON.stringify(`${'a'.repeat(50 * 1024)}!`)
    const write = jsonWriteHandler(h, { maxBodyBytes: 256 * 1024 })

    const t0 = performance.now()
    const res = await write(
      new Request('http://localhost:9999/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )
    const elapsed = performance.now() - t0

    expect(res.status).toBe(422)
    await res.text() // must not hang or throw
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })
})
