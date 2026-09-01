/**
 * Tests for the postinstall cross-platform fallback builder
 * (`scripts/postinstall.mjs`): the artifact-candidate mapping must stay in
 * lockstep with what the loader (`src/native/loader.ts`) probes, and the
 * "prebuilt present / opt-out / CI / missing toolchain" short-circuits must
 * resolve WITHOUT ever invoking cargo.
 *
 * The build-from-source path itself (cargo + crates.io) is not exercised here —
 * it is the point of the script and would take minutes — but every decision
 * before it is covered deterministically via injected `root`/`platform`/`arch`/
 * `env`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNativeAddon, napiArtifactCandidates } from '../../../scripts/postinstall.mjs'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'castrum-postinstall-'))
}

describe('napiArtifactCandidates', () => {
  test('linux/x64 probes gnu, then musl, then the bare fallback', () => {
    expect(napiArtifactCandidates('linux', 'x64')).toEqual([
      'castrum.linux-x64-gnu.node',
      'castrum.linux-x64-musl.node',
      'castrum.node',
    ])
  })

  test('darwin has no libc suffix', () => {
    expect(napiArtifactCandidates('darwin', 'arm64')).toEqual([
      'castrum.darwin-arm64.node',
      'castrum.node',
    ])
  })

  test('win32/x64 probes msvc, then gnu', () => {
    expect(napiArtifactCandidates('win32', 'x64')).toEqual([
      'castrum.win32-x64-msvc.node',
      'castrum.win32-x64-gnu.node',
      'castrum.node',
    ])
  })
})

describe('ensureNativeAddon', () => {
  test('skips when a prebuilt artifact exists (cargo never invoked)', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'castrum.linux-x64-gnu.node'), 'prebuilt')
    const r = ensureNativeAddon(root, { platform: 'linux', arch: 'x64', env: {} })
    expect(r).toEqual({ status: 'skip', reason: 'prebuilt' })
  })

  test('skips when CASTRUM_SKIP_BUILD is set', () => {
    const r = ensureNativeAddon(makeRoot(), {
      platform: 'linux',
      arch: 'x64',
      env: { CASTRUM_SKIP_BUILD: '1' },
    })
    expect(r).toEqual({ status: 'skip', reason: 'env' })
  })

  test('skips when CI is detected (CI builds the addon explicitly)', () => {
    const r = ensureNativeAddon(makeRoot(), {
      platform: 'linux',
      arch: 'x64',
      env: { CI: 'true' },
    })
    expect(r).toEqual({ status: 'skip', reason: 'ci' })
  })

  test('warns (does not fail the install) when no Rust toolchain is present', () => {
    const r = ensureNativeAddon(makeRoot(), {
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '' },
    })
    expect(r).toEqual({ status: 'skip', reason: 'no-toolchain' })
  })

  test('CASTRUM_REQUIRE_BUILD turns a missing toolchain into a hard failure', () => {
    expect(() =>
      ensureNativeAddon(makeRoot(), {
        platform: 'linux',
        arch: 'x64',
        env: { PATH: '', CASTRUM_REQUIRE_BUILD: '1' },
      }),
    ).toThrow(/no Rust toolchain/)
  })
})
