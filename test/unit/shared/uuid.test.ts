/**
 * Tests for the uuidv7 helper (src/shared/uuid.ts). Delegates to
 * Bun.randomUUIDv7 under Bun, crypto.randomUUID under Node — the decision
 * matrix (docs/bun-builtins-decision-matrix.md) measured Bun ~2x faster than
 * the FFI-crossing rust path, so this is the "don't reinvent the wheel" path.
 */

import { describe, test, expect } from 'bun:test'
import { uuidv7 } from '../../../src/shared/uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('uuidv7', () => {
  test('returns a well-formed UUID string', () => {
    const id = uuidv7()
    expect(id).toMatch(UUID_RE)
    expect(id.length).toBe(36)
  })

  test('is unique across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const id = uuidv7()
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  test('uses Bun.randomUUIDv7 when available (version nibble 7)', () => {
    if (typeof Bun !== 'undefined' && typeof Bun.randomUUIDv7 === 'function') {
      const id = uuidv7()
      // UUIDv7: the version nibble is the first hex char of the 3rd group.
      expect(id[14]).toBe('7')
    }
  })
})
