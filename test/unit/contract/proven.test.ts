/**
 * Tests for src/shared/proven.ts — the baked "proven selection" registry.
 *
 * The registry (`PROVEN_SELECTION`) states which implementation is the
 * benchmark-proven winner per op: 'native' | 'js' | 'bun' (Bun built-in
 * delegation). These tests verify the baked winners are ACTUALLY what is
 * wired at runtime:
 *   - `opImpl(op)` (the consumer binding) agrees with the baked impl,
 *   - 'bun' entries match the Bun built-in delegation registry,
 *   - native/js entries match the addon's embedded `selection.json` decision,
 *   - the registry covers the FULL selection surface (no silent drops).
 *
 * This is the deterministic replacement for the old live `check:proven`
 * benchmark gate (which was flaky on noisy hosts): drift is caught here by a
 * plain unit test instead of by re-running the CPU benchmark.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { getAddon } from '../../../src/native'
import { BUILTIN_OPS, runtimeBuiltins } from '../../../src/runtime/builtins'
import { proven, rust } from '../../../src/rust-ffi'
import { opImpl } from '../../../src/selection'
import {
  isProven,
  PROVEN_SELECTION,
  provenEntry,
  provenImpl,
  provenStatus,
  provenSummary,
  provenSurface,
} from '../../../src/shared/proven'

const selectionOps = new Set<string>(
  Object.keys(
    (
      JSON.parse(readFileSync(new URL('../../../src/selection.json', import.meta.url), 'utf8')) as {
        ops: Record<string, unknown>
      }
    ).ops,
  ),
)
const builtinOps = new Set<string>(BUILTIN_OPS)
const allKnownOps = new Set<string>([...selectionOps, ...builtinOps])

describe('proven selection registry', () => {
  test('is populated and sane (no duplicate names, valid impl/status)', () => {
    expect(PROVEN_SELECTION.length).toBeGreaterThan(0)
    const names = PROVEN_SELECTION.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length) // no duplicates
    for (const e of PROVEN_SELECTION) {
      expect(e.name.length).toBeGreaterThan(0)
      expect(['native', 'js', 'bun']).toContain(e.impl)
      expect(['proven', 'parity', 'unmeasured']).toContain(e.status)
    }
  })

  test('covers the full baked selection surface (no silent drops)', () => {
    const registry = new Set(PROVEN_SELECTION.map((e) => e.name))
    // every committed selection.json op is represented
    for (const op of selectionOps) expect(registry.has(op)).toBe(true)
    // every Bun built-in delegation is represented
    for (const op of builtinOps) expect(registry.has(op)).toBe(true)
    // and the registry has no rogue entries
    for (const name of registry) expect(allKnownOps.has(name)).toBe(true)
  })

  test('baked winners are correctly wired (opImpl agrees)', () => {
    for (const e of PROVEN_SELECTION) {
      if (e.impl === 'bun') {
        // under Bun the built-in is delegated; the consumer binding is 'js'
        expect(runtimeBuiltins.has(e.name)).toBe(true)
        expect(opImpl(e.name)).toBe('js')
      } else {
        expect(opImpl(e.name)).toBe(e.impl)
      }
    }
  })

  test('native/js entries match the embedded addon decision (selection.json)', () => {
    const addon = getAddon()
    for (const e of PROVEN_SELECTION) {
      if (e.impl === 'bun') continue // bun is a Bun-only override on top of selection.json
      expect(addon.opImpl(e.name)).toBe(e.impl)
    }
  })

  test('helpers resolve consistently', () => {
    for (const e of PROVEN_SELECTION) {
      expect(provenEntry(e.name)?.impl).toBe(e.impl)
      expect(provenImpl(e.name)).toBe(e.impl)
      expect(provenStatus(e.name)).toBe(e.status)
      expect(typeof isProven(e.name)).toBe('boolean')
    }
    expect(provenImpl('definitely-not-an-op')).toBeNull()
    expect(provenEntry('definitely-not-an-op')).toBeUndefined()
    expect(provenStatus('definitely-not-an-op')).toBeNull()
    expect(isProven('definitely-not-an-op')).toBe(false)
    expect(provenSurface()).toBe(PROVEN_SELECTION)
    expect(provenSummary()).toMatch(/native|js|bun/)
  })

  test('proven is the full rust.* surface (public API)', () => {
    expect(proven).toBe(rust)
    expect(typeof proven.fnv1a64).toBe('function')
    expect(typeof proven.crc32).toBe('function')
    expect(typeof proven.jsonValid).toBe('function')
    expect(proven.transport()).toBe(rust.transport())
  })
})
