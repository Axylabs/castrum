/**
 * Tests for the performance-proven registry helpers (src/shared/proven.ts):
 * `provenStatus`, `isProven`, `provenSurface`, `provenSummary`.
 *
 * These four helpers were exported from the package entry but never exercised —
 * this test wires them and pins their invariants against the `PROVEN_SURFACE`
 * registry (which is PURE DATA — no addon import, so this test never dlopens).
 */

import { describe, test, expect } from 'bun:test'
import {
  PROVEN_SURFACE,
  provenStatus,
  isProven,
  provenSurface,
  provenSummary,
} from '../../../src/shared/proven'
import type { PerformanceStatus } from '../../../src/shared/proven'

const STATUS_KEYS: readonly PerformanceStatus[] = [
  'proven',
  'parity',
  'not-competitive',
  'unmeasured',
]

describe('provenStatus', () => {
  test('returns the status for a known rust.<name> key', () => {
    // Pick a few representative entries to pin against.
    expect(provenStatus('fnv1a64')).toBe('proven')
    const statuses = PROVEN_SURFACE.map((e) => provenStatus(e.name))
    expect(statuses.every((s) => s !== undefined)).toBe(true)
  })

  test('returns undefined for an unknown op', () => {
    expect(provenStatus('definitely-not-an-op')).toBeUndefined()
    expect(provenStatus('')).toBeUndefined()
  })
})

describe('isProven', () => {
  test('true exactly when the registry status is "proven"', () => {
    for (const entry of PROVEN_SURFACE) {
      expect(isProven(entry.name)).toBe(entry.status === 'proven')
    }
  })

  test('false for unknown ops', () => {
    expect(isProven('definitely-not-an-op')).toBe(false)
  })
})

describe('provenSurface', () => {
  test('returns exactly the entries whose status is "proven"', () => {
    const expected = PROVEN_SURFACE.filter((e) => e.status === 'proven')
    const surface = provenSurface()
    expect(surface).toEqual(expected)
    expect(surface.length).toBeGreaterThan(0)
  })

  test('is consistent with isProven', () => {
    for (const entry of provenSurface()) {
      expect(isProven(entry.name)).toBe(true)
    }
  })
})

describe('provenSummary', () => {
  test('per-status counts match a manual tally of the registry', () => {
    const summary = provenSummary()
    for (const key of STATUS_KEYS) {
      expect(summary[key]).toBe(
        PROVEN_SURFACE.filter((e) => e.status === key).length,
      )
    }
  })

  test('counts sum to the full registry and agree with provenSurface', () => {
    const summary = provenSummary()
    const total = STATUS_KEYS.reduce((acc, key) => acc + summary[key], 0)
    expect(total).toBe(PROVEN_SURFACE.length)
    expect(summary.proven).toBe(provenSurface().length)
  })
})

describe('registry integrity (map key source)', () => {
  test('entry names are unique so the byName map cannot silently collapse', () => {
    const seen = new Set<string>()
    for (const entry of PROVEN_SURFACE) {
      expect(seen.has(entry.name)).toBe(false)
      seen.add(entry.name)
    }
  })

  test('every entry carries a valid status', () => {
    for (const entry of PROVEN_SURFACE) {
      expect(STATUS_KEYS).toContain(entry.status)
    }
  })
})
