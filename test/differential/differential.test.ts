/**
 * Differential transport-lane harness.
 *
 * Runs ONE corpus through every in-process lane and asserts they agree on the
 * fields that SHOULD agree, while pinning the known-divergent fields
 * explicitly:
 *
 *   - `fast` (path 1, `createIngressFast`) vs `baked` (path 2,
 *     `createIngressHandler` routes): the two wire formats intentionally
 *     DIFFER, so only semantic fields are compared (status + ok/error code),
 *     never raw bytes.
 *   - `baked` copy vs `zero-copy` (`copyBody: false`): the same wire format, so
 *     the responses must be byte-identical (after the per-request `requestId`
 *     is redacted).
 *   - `ffi` vs `napi`: the transport is selected once per process, so this lane
 *     runs the harness in a subprocess (`transport-runner.ts`) twice with
 *     `CASTRUM_FFI_MODE=ffi`/`=napi` and diffs the normalized output. Skipped
 *     when the in-process bun:ffi transport is unavailable.
 *
 * Cross-runtime (Bun vs Node) parity is deliberately OUT of scope here — it is
 * owned by `bun run test:node` (node-smoke / node-enterprise).
 */

import { expect, test } from 'bun:test'
import { CORPUS } from './corpus'
import {
  assertLanesAgree,
  diffLaneResults,
  FULL_FIELDS,
  type LaneResult,
  runLane,
  SEMANTIC_FIELDS,
  transportAvailable,
} from './lanes'

interface PinnedCase {
  readonly description: string
  readonly fast: { status: number; ok: boolean | null; errorCode: string | null }
  readonly baked: { status: number; ok: boolean | null; errorCode: string | null }
}

/**
 * Cases where the RAW fast pipeline and the PRE-BAKED route legitimately
 * disagree — every entry pins the exact divergence so a regression in either
 * layer is visible, and a NEW divergence fails the agreement assertion.
 */
const KNOWN_FAST_VS_BAKED: Readonly<Record<string, PinnedCase>> = {
  'options-plain': {
    description: 'the OPTIONS route handler always answers 204; the raw pipeline does not',
    fast: { status: 200, ok: true, errorCode: null },
    baked: { status: 204, ok: true, errorCode: null },
  },
  'post-wrong-content-type': {
    description: 'the JSON-write route enforces Content-Type (415); the raw pipeline does not',
    fast: { status: 200, ok: true, errorCode: null },
    baked: { status: 415, ok: false, errorCode: 'unsupported_media_type' },
  },
  'aborted-get': {
    description:
      'route handlers short-circuit an aborted Request.signal to 499; the raw fast path ignores it',
    fast: { status: 200, ok: true, errorCode: null },
    baked: { status: 499, ok: null, errorCode: null },
  },
}

function caseOf(lane: LaneResult, id: string): LaneResult['cases'][number] {
  const found = lane.cases.find((c) => c.id === id)
  expect(found).toBeDefined()
  return found as LaneResult['cases'][number]
}

test('fast (path 1) and baked (path 2) agree on normalized semantics', async () => {
  const fast = await runLane('fast', CORPUS)
  const baked = await runLane('baked', CORPUS)

  // Every field-level divergence must be one of the explicitly pinned cases.
  const unexpected = diffLaneResults(fast, baked, SEMANTIC_FIELDS).filter(
    (d) => !(d.id in KNOWN_FAST_VS_BAKED),
  )
  expect(unexpected).toEqual([])

  // And the pinned cases must diverge in EXACTLY the documented way.
  for (const [id, pin] of Object.entries(KNOWN_FAST_VS_BAKED)) {
    const f = caseOf(fast, id)
    const b = caseOf(baked, id)
    expect({ status: f.status, ok: f.ok, errorCode: f.errorCode }).toEqual(pin.fast)
    expect({ status: b.status, ok: b.ok, errorCode: b.errorCode }).toEqual(pin.baked)
  }
})

test('baked copy and zero-copy responses are byte-identical over the corpus', async () => {
  const copy = await runLane('baked', CORPUS)
  const zero = await runLane('zero-copy', CORPUS)
  assertLanesAgree(copy, zero, FULL_FIELDS, 'copy vs zero-copy')
})

test.skipIf(!transportAvailable())(
  'bun:ffi and napi transports normalize identically (subprocess)',
  async () => {
    const ffi = await runLane('transport-ffi', CORPUS)
    const napi = await runLane('transport-napi', CORPUS)
    assertLanesAgree(ffi, napi, FULL_FIELDS, 'ffi vs napi')
  },
)

test('the harness detects an intentionally perturbed lane (divergence self-test)', async () => {
  // Run the same lane twice; the second run has one case's status flipped
  // in-memory. The diff/assert machinery MUST flag it — this is the
  // injected-regression self-test that proves the harness can fail. The
  // perturbation lives only in this test; the shipped lanes never set `mutate`.
  const baseline = await runLane('baked', CORPUS)
  const perturbed = await runLane('baked', CORPUS, {
    mutate: (result) => ({
      lane: result.lane,
      cases: result.cases.map((c, i) =>
        i === 0 ? { ...c, status: c.status === 200 ? 503 : 200 } : c,
      ),
    }),
  })

  const diffs = diffLaneResults(baseline, perturbed, FULL_FIELDS)
  expect(diffs.length).toBeGreaterThan(0)
  expect(() => assertLanesAgree(baseline, perturbed, FULL_FIELDS, 'perturbed lane')).toThrow(
    /diverged/,
  )
})

test('corpus covers the required valid / invalid / edge categories', () => {
  expect(CORPUS.length).toBeGreaterThanOrEqual(40)
  const ids = new Set(CORPUS.map((c) => c.id))
  const required = [
    'post-empty-body',
    'post-oversized',
    'post-bad-json',
    'get-query-bad-percent',
    'get-query-invalid-utf8',
    'get-dup-header',
    'get-query-proto',
    'get-cookie-proto',
    'post-json-proto',
    'aborted-get',
    'post-exact-limit',
    'options-preflight-allowed',
    'schema-missing-key',
  ]
  for (const id of required) {
    expect(ids.has(id)).toBe(true)
  }
})
