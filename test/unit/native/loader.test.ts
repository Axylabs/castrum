/**
 * Tests for the native addon loader's path resolution
 * (`resolveAddonPathFrom` in src/native/loader.ts).
 *
 * The pure resolver is tested directly (with temp dirs) so env-override /
 * multi-root / missing-addon behavior is covered WITHOUT mutating the
 * process-global addon cache that `getAddon()` relies on.
 */

import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAddonPathFrom } from '../../../src/native/loader'

// Explicit platform/arch are passed to the pure resolver, so the test is
// self-consistent regardless of the host machine.
const PLATFORM = 'linux'
const ARCH = 'x64'
const ARTIFACT = `castrum.${PLATFORM}-${ARCH}-gnu.node`

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'castrum-loader-'))
}

describe('resolveAddonPathFrom', () => {
  test('env override as a directory: resolves dir/<name>.node', () => {
    const dir = makeDir()
    const target = join(dir, ARTIFACT)
    writeFileSync(target, '')
    const p = resolveAddonPathFrom(dir, makeDir(), PLATFORM, ARCH)
    expect(p).toBe(target)
  })

  test('env override as a direct file: resolves the file itself', () => {
    const file = join(makeDir(), 'my-addon.node')
    writeFileSync(file, '')
    const p = resolveAddonPathFrom(file, makeDir(), PLATFORM, ARCH)
    expect(p).toBe(file)
  })

  test('env override directory with NO matching artifact throws', () => {
    // Regression: an empty override directory must not be pushed as a require
    // candidate (used to fail with MODULE_NOT_FOUND) — it must error cleanly.
    expect(() => resolveAddonPathFrom(makeDir(), makeDir(), PLATFORM, ARCH)).toThrow(
      /Could not find castrum native addon/,
    )
  })

  test('no override: resolves from the module dir root', () => {
    const root = makeDir()
    writeFileSync(join(root, ARTIFACT), '')
    const p = resolveAddonPathFrom(undefined, root, PLATFORM, ARCH)
    expect(p).toBe(join(root, ARTIFACT))
  })

  test('no override: walks up parent roots (src/native → pkg)', () => {
    const root = makeDir()
    // baseDir = <pkg>/src/native; artifact at <pkg> (via ".." and "../..")
    const baseDir = join(root, 'src', 'native')
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(join(root, ARTIFACT), '')
    const p = resolveAddonPathFrom(undefined, baseDir, PLATFORM, ARCH)
    expect(p).toBe(join(root, ARTIFACT))
  })

  test('no override: falls back to target/release', () => {
    const root = makeDir()
    const baseDir = join(root, 'src', 'native')
    mkdirSync(join(root, 'target', 'release'), { recursive: true })
    const target = join(root, 'target', 'release', ARTIFACT)
    writeFileSync(target, '')
    const p = resolveAddonPathFrom(undefined, baseDir, PLATFORM, ARCH)
    expect(p).toBe(target)
  })

  test('missing addon everywhere throws a helpful error', () => {
    expect(() => resolveAddonPathFrom(undefined, makeDir(), PLATFORM, ARCH)).toThrow(
      /bun run build/,
    )
  })

  test('set-but-misconfigured override throws instead of falling back to roots', () => {
    // A typo'd CASTRUM_NATIVE_LIBRARY_PATH must not silently resolve from the
    // package roots (that would mask the misconfiguration).
    expect(() =>
      resolveAddonPathFrom('/definitely/not/a/real/override', makeDir(), PLATFORM, ARCH),
    ).toThrow(/CASTRUM_NATIVE_LIBRARY_PATH/)
  })
})
