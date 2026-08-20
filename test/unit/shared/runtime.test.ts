/**
 * Tests for src/shared/runtime.ts — the single runtime-detection seam.
 *
 * castrum is Bun-first but must also run under Node; this module is the only
 * place that inspects `typeof Bun`. These tests run under `bun test` (Bun).
 */

import { describe, expect, test } from 'bun:test'
import { isBun, isNode, nodeMajorVersion, runtimeName } from '../../../src/shared/runtime'

describe('runtime detection seam', () => {
  test('detects the current (Bun) runtime', () => {
    expect(isBun()).toBe(true)
    expect(isNode()).toBe(false)
    expect(runtimeName()).toBe('bun')
    expect(nodeMajorVersion()).toBeNull()
  })

  test('isBun and isNode are mutually exclusive', () => {
    expect(isBun() && isNode()).toBe(false)
  })
})
