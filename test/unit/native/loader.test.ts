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
import { resolveAddonPathFrom, supportsX8664V3 } from '../../../src/native/loader'

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

describe('supportsX8664V3', () => {
  test('true when all v3 flags are present', () => {
    const cpuinfo = `
processor : 0
flags     : fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat
pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc
arch_perfmon rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3
fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand
hypervisor lahf_lm abm 3dnowprefetch cpuid_fault bmi1 avx2 bmi2 umip
`
    expect(supportsX8664V3(cpuinfo)).toBe(true)
  })

  test('false when any v3 flag is missing (partial SSE4.2 machine)', () => {
    // avx2 present but bmi2/fma absent → must NOT prefer the v3 binary (a
    // SIGILL on an unsupported CPU is not catchable from JS).
    const cpuinfo = `
flags     : fpu sse sse2 ssse3 sse4_1 sse4_2 avx avx2 f16c
`
    expect(supportsX8664V3(cpuinfo)).toBe(false)
  })

  test('false when cpuinfo is empty/unreadable', () => {
    expect(supportsX8664V3('')).toBe(false)
    // `undefined` reads the real /proc/cpuinfo (production path) — not
    // deterministically assertable here, so only the empty-string path is
    // pinned. The resolver's own linux/x64 gating covers the rest.
  })
})

describe('resolveAddonPathFrom — dual-binary CPU-detect (v3 variant)', () => {
  const V3 = 'castrum.linux-x64-v3-gnu.node'
  const V3_CPUINFO = `flags: avx2 bmi2 fma sse4_2`
  const BASE_CPUINFO = `flags: sse2 sse4_2`

  test('prefers the v3 variant when the CPU supports it and the file exists', () => {
    const root = makeDir()
    writeFileSync(join(root, ARTIFACT), '')
    writeFileSync(join(root, V3), '')
    const p = resolveAddonPathFrom(undefined, root, PLATFORM, ARCH, V3_CPUINFO)
    expect(p).toBe(join(root, V3))
  })

  test('falls back to the baseline variant when v3 is unsupported', () => {
    const root = makeDir()
    writeFileSync(join(root, ARTIFACT), '')
    writeFileSync(join(root, V3), '')
    const p = resolveAddonPathFrom(undefined, root, PLATFORM, ARCH, BASE_CPUINFO)
    expect(p).toBe(join(root, ARTIFACT))
  })

  test('falls back to the baseline variant when v3 is supported but absent', () => {
    const root = makeDir()
    writeFileSync(join(root, ARTIFACT), '')
    const p = resolveAddonPathFrom(undefined, root, PLATFORM, ARCH, V3_CPUINFO)
    expect(p).toBe(join(root, ARTIFACT))
  })

  test('v3 preference never applies on non-linux/x64 platforms', () => {
    const root = makeDir()
    writeFileSync(join(root, 'castrum.darwin-arm64.node'), '')
    writeFileSync(join(root, V3), '')
    const p = resolveAddonPathFrom(undefined, root, 'darwin', 'arm64', V3_CPUINFO)
    expect(p).toBe(join(root, 'castrum.darwin-arm64.node'))
  })
})
