/**
 * Tests for src/shared/bench-classify.ts — the pure benchmark classification
 * used by the JSDoc annotator and the proven-surface audit.
 *
 * Covers:
 * - canonical + variant task aggregation (and cross-entry exclusion)
 * - majority-fail → effective "not-competitive" (auto-deprecate)
 * - static "not-competitive" + majority win → promotable (keeps deprecated)
 * - static "parity" is never auto-promoted by one good run
 * - unmeasured / missing-task handling
 * - display-ratio selection and formatRatio
 */

import { describe, test, expect } from 'bun:test'
import {
  classifyEntry,
  classifySurface,
  formatRatio,
  LOSS_TOLERANCE,
  PROMOTE_TOLERANCE,
  type Comparison,
} from '../../../src/shared/bench-classify'
import type { ProvenEntry } from '../../../src/shared/proven'

function cmp(rustName: string, ratio: number, label = 'label'): Comparison {
  return {
    label,
    nativeName: `native:${rustName.replace(/^rust:/, '')}`,
    rustName,
    nativeAvgMs: ratio,
    rustAvgMs: 1,
    ratio,
    faster: ratio >= 1 ? 'rust' : 'native',
  }
}

const provenEntry = (over: Partial<ProvenEntry> = {}): ProvenEntry => ({
  name: 'fn',
  label: 'Fn',
  nativeTask: 'native:fn',
  rustTask: 'rust:fn',
  status: 'proven',
  ...over,
})

describe('task aggregation', () => {
  test('groups the canonical comparison with `_`-suffixed variants', () => {
    const entry = provenEntry({
      name: 'jsonValid',
      rustTask: 'rust:json_valid',
    })
    const classified = classifyEntry(entry, [
      cmp('rust:json_valid', 3.0),
      cmp('rust:json_valid_large', 2.0),
      cmp('rust:json_valid_batch', 2.5),
      cmp('rust:json_valid_stress', 1.8),
    ])

    expect(classified.total).toBe(4)
    expect(classified.won).toBe(4)
    expect(classified.failed).toBe(0)
    expect(classified.majorityWin).toBe(true)
    expect(classified.majorityFail).toBe(false)
    expect(classified.live).toBe('proven')
    expect(classified.effective).toBe('proven')
    expect(classified.drifted).toBe(false)
    // Display ratio prefers the canonical comparison.
    expect(classified.ratio).toBeCloseTo(3.0, 5)
    expect(classified.tasks.find((t) => !t.isVariant)?.rustName).toBe('rust:json_valid')
    expect(
      classified.tasks.some((t) => t.isVariant && t.rustName === 'rust:json_valid_batch'),
    ).toBe(true)
  })

  test('excludes variants claimed by another registry entry (jwt_sign vs jwt_sign_bytes)', () => {
    const jwtSign = provenEntry({
      name: 'jwtSign',
      label: 'JWT sign',
      rustTask: 'rust:jwt_sign',
      status: 'not-competitive',
    })
    const jwtSignBytes = provenEntry({
      name: 'jwtSignBytes',
      label: 'JWT sign (bytes)',
      rustTask: 'rust:jwt_sign_bytes',
      status: 'parity',
    })
    const claimed = new Set(['rust:jwt_sign_bytes'])
    const forJwtSign = classifyEntry(
      jwtSign,
      [cmp('rust:jwt_sign', 0.5), cmp('rust:jwt_sign_bytes', 1.07)],
      claimed,
    )
    const forBytes = classifyEntry(
      jwtSignBytes,
      [cmp('rust:jwt_sign', 0.5), cmp('rust:jwt_sign_bytes', 1.07)],
      claimed,
    )

    // `rust:jwt_sign_bytes` belongs to jwtSignBytes, not jwtSign.
    expect(forJwtSign.total).toBe(1)
    expect(forJwtSign.tasks[0]?.rustName).toBe('rust:jwt_sign')
    expect(forBytes.total).toBe(1)
    expect(forBytes.tasks[0]?.rustName).toBe('rust:jwt_sign_bytes')
  })

  test('classifySurface shares one claimed-task set across entries', () => {
    const entries: readonly ProvenEntry[] = [
      provenEntry({ name: 'jwtSign', rustTask: 'rust:jwt_sign', status: 'not-competitive' }),
      provenEntry({ name: 'jwtSignBytes', rustTask: 'rust:jwt_sign_bytes', status: 'parity' }),
    ]
    const byName = classifySurface(entries, [
      cmp('rust:jwt_sign', 0.5),
      cmp('rust:jwt_sign_bytes', 1.07),
    ])
    expect(byName.get('jwtSign')?.total).toBe(1)
    expect(byName.get('jwtSignBytes')?.total).toBe(1)
  })
})

describe('majority-fail auto-deprecation', () => {
  test('overrides a static proven classification when a majority of tasks lose', () => {
    const entry = provenEntry({ status: 'proven' })
    const classified = classifyEntry(entry, [
      cmp('rust:fn', 3.0),
      cmp('rust:fn_large', 0.5),
      cmp('rust:fn_batch', 0.4),
    ])

    expect(classified.total).toBe(3)
    expect(classified.won).toBe(1)
    expect(classified.failed).toBe(2)
    expect(classified.majorityFail).toBe(true)
    expect(classified.live).toBe('not-competitive')
    expect(classified.effective).toBe('not-competitive')
    expect(classified.drifted).toBe(true)
    expect(classified.promotable).toBe(false)
    // Display ratio is the worst task so the deprecation number is honest.
    expect(classified.ratio).toBeCloseTo(0.4, 5)
  })

  test('a single losing task is a majority of one (deprecates)', () => {
    const classified = classifyEntry(provenEntry(), [cmp('rust:fn', 0.5)])
    expect(classified.total).toBe(1)
    expect(classified.majorityFail).toBe(true)
    expect(classified.effective).toBe('not-competitive')
  })

  test('a tie is NOT a majority fail (falls back to parity/static)', () => {
    const classified = classifyEntry(provenEntry(), [
      cmp('rust:fn', 3.0),
      cmp('rust:fn_large', 0.5),
      cmp('rust:fn_batch', 0.4),
      cmp('rust:fn_deep', 2.0),
    ])
    expect(classified.won).toBe(2)
    expect(classified.failed).toBe(2)
    expect(classified.majorityFail).toBe(false)
    expect(classified.majorityWin).toBe(false)
    expect(classified.live).toBe('parity')
    expect(classified.effective).toBe('proven') // static stands on a tie
    expect(classified.drifted).toBe(false)
  })
})

describe('promotable (static not-competitive)', () => {
  test('keeps deprecated status but flags a majority win as promotable', () => {
    const entry = provenEntry({ status: 'not-competitive' })
    const classified = classifyEntry(entry, [cmp('rust:fn', 1.6), cmp('rust:fn_large', 2.0)])

    expect(classified.majorityWin).toBe(true)
    expect(classified.promotable).toBe(true)
    expect(classified.effective).toBe('not-competitive') // never auto-removed
    expect(classified.drifted).toBe(false)
  })

  test('one good local run never removes the deprecated classification', () => {
    const classified = classifyEntry(provenEntry({ status: 'not-competitive' }), [
      cmp('rust:fn', 1.6),
    ])
    expect(classified.promotable).toBe(true)
    expect(classified.effective).toBe('not-competitive')
  })

  test('marginal losses never count as wins (no false promotion)', () => {
    const entry = provenEntry({ status: 'not-competitive' })
    const classified = classifyEntry(entry, [
      cmp('rust:fn', 0.8), // marginal loss — just above the clear-loss threshold
      cmp('rust:fn_large', 0.79),
    ])
    expect(classified.won).toBe(0)
    expect(classified.failed).toBe(0)
    expect(classified.majorityWin).toBe(false)
    expect(classified.majorityFail).toBe(false)
    expect(classified.promotable).toBe(false)
    expect(classified.live).toBe('parity') // tie-heavy → parity, not proven
  })
})

describe('static parity is not auto-promoted', () => {
  test('a majority win keeps the static parity classification', () => {
    const classified = classifyEntry(provenEntry({ status: 'parity' }), [
      cmp('rust:fn', 2.0),
      cmp('rust:fn_large', 1.8),
    ])
    expect(classified.majorityWin).toBe(true)
    expect(classified.live).toBe('proven')
    expect(classified.effective).toBe('parity') // static stands
    expect(classified.drifted).toBe(false)
    expect(classified.promotable).toBe(false)
  })
})

describe('unmeasured / missing tasks', () => {
  test('entry without a rustTask is unmeasured', () => {
    const classified = classifyEntry(provenEntry({ rustTask: '', status: 'unmeasured' }), [
      cmp('rust:fn', 3.0),
    ])
    expect(classified.total).toBe(0)
    expect(classified.live).toBe('unmeasured')
    expect(classified.effective).toBe('unmeasured')
    expect(classified.majorityFail).toBe(false)
  })

  test('entry with a rustTask but no matching comparison is unmeasured', () => {
    const classified = classifyEntry(provenEntry(), [cmp('rust:other', 3.0)])
    expect(classified.total).toBe(0)
    expect(classified.live).toBe('unmeasured')
    expect(classified.effective).toBe('unmeasured') // skipped by annotator/audit
    expect(classified.majorityFail).toBe(false)
  })
})

describe('tolerances and formatting', () => {
  test('task bands: won = ratio>=1, failed = clear loss, middle = tie', () => {
    const win = classifyEntry(provenEntry(), [cmp('rust:fn', 1.0)])
    expect(win.tasks[0]?.won).toBe(true)
    expect(win.tasks[0]?.failed).toBe(false)
    expect(win.majorityWin).toBe(true)

    const tie = classifyEntry(provenEntry(), [cmp('rust:fn', 1 / LOSS_TOLERANCE)])
    expect(tie.tasks[0]?.won).toBe(false) // marginal, not a win
    expect(tie.tasks[0]?.failed).toBe(false) // within tolerance, not a clear loss
    expect(tie.majorityWin).toBe(false)
    expect(tie.majorityFail).toBe(false)

    const clearLoss = classifyEntry(provenEntry(), [cmp('rust:fn', 1 / LOSS_TOLERANCE - 0.01)])
    expect(clearLoss.tasks[0]?.won).toBe(false)
    expect(clearLoss.tasks[0]?.failed).toBe(true)
    expect(clearLoss.majorityFail).toBe(true)
  })

  test('formatRatio summarizes the winner', () => {
    expect(formatRatio(3.179807)).toBe('3.18x rust')
    expect(formatRatio(0.5)).toBe('2.00x baseline')
    expect(formatRatio(1)).toBe('1.00x rust')
  })

  test('PROMOTE_TOLERANCE is exported for the audit', () => {
    expect(PROMOTE_TOLERANCE).toBe(1.5)
    expect(typeof classifyEntry).toBe('function')
  })
})
