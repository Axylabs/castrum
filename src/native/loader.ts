// src/native/loader.ts — Native addon path resolution + lazy loading.
//
// Importing this module does NOT dlopen the addon; `getAddon()` /
// `lazyAddon()` trigger loading exactly once on first use. This keeps
// `import castrum` as cheap as possible on Bun.

import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { resolveEnvVar } from '../shared/env'
import type { NativeAddon } from './types'

const require = createRequire(import.meta.url)

/**
 * Resolve the addon path given EXPLICIT inputs (pure — unit-testable).
 *
 * `resolveAddonPath()` is a thin wrapper that reads `process.env` and the
 * module location; this function contains all the resolution logic so tests
 * can exercise env-override / multi-root / missing-addon behavior without
 * mutating the process-global cache.
 *
 * @param envOverride an explicit `CASTRUM_NATIVE_LIBRARY_PATH`-style path, or
 *   `undefined` for none (the real call passes the env-var value)
 * @param baseDir the directory of the current module (`dist/` or `src/native`)
 * @param platform `process.platform`
 * @param arch `process.arch`
 * @returns the first existing candidate path (throws if none exists)
 */
export function resolveAddonPathFrom(
  envOverride: string | undefined,
  baseDir: string,
  platform: string,
  arch: string,
): string {
  // napi-rs artifact naming: castrum.<platform>-<arch>[-<libc>].node
  // e.g. linux-x64-gnu, linux-x64-musl, win32-x64-msvc, darwin-arm64.
  const libcVariants =
    platform === 'win32' ? ['msvc', 'gnu'] : platform === 'linux' ? ['gnu', 'musl'] : ['']

  const names = libcVariants.map(
    (libc) => `castrum.${platform}-${arch}${libc ? `-${libc}` : ''}.node`,
  )
  names.push('castrum.node')

  const candidates: string[] = []

  // Explicit override (napi-rs convention + castrum/legacy aliases). May be a
  // direct file path or a directory that contains the .node artifact.
  if (envOverride) {
    // A DIRECT file override must resolve to a FILE (a .node/loadable path).
    // If the override is a DIRECTORY, only the joined `dir/<name>.node`
    // candidates are valid — pushing the directory itself used to make
    // `require(<dir>)` fail with MODULE_NOT_FOUND (no package.json/index inside).
    const isFile = (p: string): boolean => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    }
    const overrideCandidates: string[] = []
    if (existsSync(envOverride) && isFile(envOverride)) {
      candidates.push(envOverride)
      overrideCandidates.push(envOverride)
    }
    for (const name of names) {
      const candidate = join(envOverride, name)
      candidates.push(candidate)
      overrideCandidates.push(candidate)
    }
    // A SET-but-misconfigured override must not silently fall through to the
    // package roots — that would mask a typo'd path (a stale/root addon could
    // load while the user believes their override is active). Throw a clear
    // error instead, pointing at the expected override locations.
    if (!overrideCandidates.some((c) => existsSync(c))) {
      throw new Error(
        `Could not find castrum native addon.\n` +
          `CASTRUM_NATIVE_LIBRARY_PATH (or NAPI_RS_NATIVE_LIBRARY_PATH) is set to ` +
          `"${envOverride}" but no loadable addon was found there.\n` +
          `Expected one of:\n${overrideCandidates.map((c) => `  - ${c}`).join('\n')}\n` +
          `Fix the path, or unset the variable to fall back to the package layout.`,
      )
    }
  }

  // Candidate roots cover BOTH layouts:
  //   - source layout (Bun, raw TS): <pkg>/src/native → <pkg> via ".."/"../.."
  //   - bundled layout (Node, dist/): <pkg>/dist → <pkg> via ".."
  const roots = [
    baseDir, // <pkg>/dist (bundled) or <pkg>/src/native
    join(baseDir, '..'), // <pkg> when bundled into <pkg>/dist
    join(baseDir, '..', '..'), // <pkg> when running from <pkg>/src/native
  ]

  for (const root of roots) {
    for (const name of names) {
      candidates.push(join(root, name))
    }
  }

  // Local dev fallback: <pkg>/target/release/<name>.node (cargo-built artifact
  // not yet copied to the package root). Note the artifact NAME must be
  // appended — a bare directory is not loadable (regression guarded in tests).
  for (const name of names) {
    candidates.push(join(baseDir, '..', '..', 'target', 'release', name))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not find castrum native addon.\n` +
      `Run: bun run build\n` +
      `Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  )
}

function resolveAddonPath(): string {
  return resolveAddonPathFrom(
    resolveEnvVar('CASTRUM_NATIVE_LIBRARY_PATH', [
      'NAPI_RS_NATIVE_LIBRARY_PATH',
      'RUST_BENCH_NATIVE_LIBRARY_PATH',
    ]),
    dirname(fileURLToPath(import.meta.url)),
    process.platform,
    process.arch,
  )
}

let cachedPath: string | undefined

/** Resolve the addon file path exactly once (lazy). */
export function getAddonPath(): string {
  cachedPath ??= resolveAddonPath()
  return cachedPath
}

let cachedAddon: NativeAddon | undefined

/**
 * Load the native addon exactly once, lazily.
 *
 * The first call triggers loading (see {@link getAddonPath} for resolution).
 */
export function getAddon(): NativeAddon {
  if (cachedAddon === undefined) {
    const addonPath = getAddonPath()
    let loaded: NativeAddon
    try {
      loaded = require(addonPath)
    } catch (err) {
      const cause = err instanceof Error ? `\n  Underlying cause: ${err.message}` : ''
      throw new Error(
        `Failed to load castrum native addon from:\n  ${addonPath}\n` +
          `The addon exists but could not be loaded (ABI mismatch, missing system ` +
          `libraries, or a corrupt/partial artifact).\n` +
          `Run: bun run build\n` +
          `If the problem persists, verify the binary was built for this platform/CPU.` +
          cause,
      )
    }

    if (resolveEnvVar('CASTRUM_DEBUG', ['RUST_BENCH_DEBUG']) !== undefined) {
      console.log('Native addon loaded from:', addonPath)
      console.log('Exported keys:', Object.keys(loaded).sort())
    }

    cachedAddon = loaded
  }
  return cachedAddon
}

/**
 * A lazily-loading proxy over the native addon.
 *
 * Use this in modules that only touch the addon at call time (e.g. the FFI
 * wrappers) so that importing them does not dlopen the addon until the first
 * real native call. All existing `addon.X` / `new addon.Y(...)` call sites
 * keep working unchanged.
 */
export function lazyAddon<T extends object>(loader: () => T): T {
  let loaded: T | undefined
  return new Proxy({} as T, {
    get(_target, prop: string | symbol) {
      loaded ??= loader()
      return Reflect.get(loaded, prop)
    },
  })
}
