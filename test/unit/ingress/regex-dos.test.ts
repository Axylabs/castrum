/**
 * test/unit/ingress/regex-dos.test.ts — ReDoS / resource-limit regression pins
 * for schema `pattern`.
 *
 * Trust boundary: `pattern` / `patternProperties` are supplied by the schema
 * author (the application developer), while the validated document is
 * attacker-controlled. `fast_schema` compiles these with `fancy-regex` (the
 * repo pins 0.19.0), which has three relevant regimes:
 *
 *   1. Regular patterns (no lookaround/backreference) are delegated to the
 *      linear `regex` crate. The classic nested-quantifier example `^(a+)+$`
 *      is in this regime — measured ~0.1 ms for a 50 KB non-match — so it is
 *      NOT a ReDoS on this path. Test 1 pins a resource bound for it; that
 *      assertion alone does not prove which engine handled it.
 *   2. Patterns that force the backtracking VM (a backreference, possibly with
 *      lookaround) run under a 1,000,000-step cap (`fancy-regex` default). A
 *      cap miss becomes a non-match on the fast path and a
 *      `backtrack_limit` validation error on the `jsonschema` fallback — the
 *      accept/reject outcome is the same. This cap is genuinely load-bearing:
 *      `^((a+)+)+\1$` (nested quantifiers + backreference) is exponential
 *      without it (already >10 s at n=30 in a direct fancy-regex probe) and a
 *      constant ~25 ms across 1 KB..50 KB with it. Tests 3–5 pin this,
 *      including that the fallback behaves identically.
 *   3. A hard construct wrapping an otherwise-regular inner (e.g.
 *      `(?=(a+)+$)a`) never enters the VM for the inner quantifier; it costs
 *      quadratic time from per-position delegate scanning and the cap does not
 *      fire (measured ~4x per doubling; 50 KB ≈ 3.3 s). Test 6 records this
 *      regime; body-size limits — not the cap — bound it.
 *
 * `jsonschema` (the authoritative DOM fallback) uses the SAME fancy-regex
 * engine with the same default cap, so routing a pattern to the fallback is
 * **not** a mitigation (pinned by forcing the DOM path with `propertyNames`).
 *
 * See SECURITY.md §"Schema `pattern` is trusted author input".
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler, jsonWriteHandler } from '../../../src/ingress/handlers'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

/**
 * Wall-clock budget for each operation. Deliberately generous relative to the
 * measured costs (0.1 ms–35 ms), so a loaded CI box cannot make these flake.
 * The exponential cases this guards against are not merely slower than the
 * budget — they do not terminate (regime 2 >10 s already at n=30), so the
 * margin does not weaken the discrimination.
 */
const BUDGET_MS = 2_000

function schemaFor(pattern: string): Uint8Array {
  return encoder.encode(JSON.stringify({ type: 'string', pattern }))
}

function jsonStringOf(value: string): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

describe('schema pattern ReDoS regression pins', () => {
  test('classic nested-quantifier pattern completes within a resource bound', () => {
    // `^(a+)+$` is a regular pattern delegated to the linear `regex` engine
    // (regime 1). 50 KB of 'a' + '!' cannot match; a naive backtracker is
    // exponential here. Measured ~0.1 ms, i.e. >10,000x the budget of margin.
    // This test proves the operation is resource-bounded, NOT which engine ran
    // it — the VM cap is pinned separately in test 3.
    const validator = rust.createSchemaValidator(schemaFor('^(a+)+$'))
    const doc = jsonStringOf(`${'a'.repeat(50 * 1024)}!`)

    const t0 = performance.now()
    const ok = validator.validate(doc)
    const elapsed = performance.now() - t0

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  test('the pattern is actually evaluated (matching text is accepted)', () => {
    const validator = rust.createSchemaValidator(schemaFor('^(a+)+$'))
    // If the pattern were silently dropped, the negative case would also pass.
    // Pin both verdicts so the resource pins cannot pass vacuously.
    expect(validator.validate(encoder.encode('"aaa"'))).toBe(true)
    expect(validator.validate(encoder.encode('"aaab"'))).toBe(false)
  })

  test('VM-only exponential pattern is bounded by the 1,000,000-step cap', () => {
    // `^((a+)+)+\1$` requires the backtracking VM (the backreference is not a
    // regular feature) and is exponential in the nested quantifiers. Direct
    // fancy-regex 0.19.0 probe: default cap -> Err(BacktrackLimitExceeded) in
    // ~28 ms even at n=50,000; cap removed (backtrack_limit(usize::MAX)) ->
    // Ok(false) at n=25 takes 1.9 s and n=30 already exceeds 10 s. This is the
    // pin that the cap is load-bearing: `is_match` returns Err, which the
    // validator maps to a non-match via `unwrap_or(false)`.
    const validator = rust.createSchemaValidator(schemaFor('^((a+)+)+\\1$'))
    const doc = jsonStringOf(`${'a'.repeat(50 * 1024)}b`)

    const t0 = performance.now()
    const ok = validator.validate(doc)
    const elapsed = performance.now() - t0

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  test('the jsonschema DOM fallback is bounded the same way (not a mitigation)', () => {
    // `propertyNames` is outside the fast-schema subset, so the WHOLE schema
    // falls back to the `jsonschema` crate. Same VM-only pattern and input:
    // measured ~25 ms, identical to the fast path — routing a pattern to the
    // fallback does not change the bound (same fancy-regex engine + default cap).
    const validator = rust.createSchemaValidator(schemaFor('^((a+)+)+\\1$'))
    // Force the DOM path by adding an unsupported keyword.
    const dom = rust.createSchemaValidator(
      encoder.encode(
        JSON.stringify({
          type: 'string',
          propertyNames: {},
          pattern: '^((a+)+)+\\1$',
        }),
      ),
    )
    const doc = jsonStringOf(`${'a'.repeat(50 * 1024)}b`)

    const t0 = performance.now()
    const fastOk = validator.validate(doc)
    const t1 = performance.now()
    const domOk = dom.validate(doc)
    const t2 = performance.now()

    expect(fastOk).toBe(false)
    expect(domOk).toBe(false)
    expect(t1 - t0).toBeLessThan(BUDGET_MS)
    expect(t2 - t1).toBeLessThan(BUDGET_MS)
  })

  test('ingress schema validation stays bounded on a large non-matching body', async () => {
    const schema = schemaFor('^((a+)+)+\\1$')
    const h = createIngressHandler({ requireJsonBody: true, schema, enableBodySizeGuard: true }, {})
    const body = JSON.stringify(`${'a'.repeat(50 * 1024)}b`)
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

  test('lookaround over a regular inner stays polynomial (cap does not apply)', () => {
    // Regime 3: `(?=(a+)+$)a` is quadratic from per-position delegate scanning;
    // removing the cap does NOT change it (direct probe: 427 ms vs 430 ms at
    // n=20,000), so this is not a cap assertion — it records that the cost
    // stays polynomial at a modest size. Bounded in practice by `maxBodyBytes`.
    const validator = rust.createSchemaValidator(schemaFor('(?=(a+)+$)a'))
    const doc = jsonStringOf(`${'a'.repeat(5 * 1024)}b`)

    const t0 = performance.now()
    const ok = validator.validate(doc)
    const elapsed = performance.now() - t0

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })
})
