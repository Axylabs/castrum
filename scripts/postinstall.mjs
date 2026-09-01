#!/usr/bin/env node
// scripts/postinstall.mjs — cross-platform native addon fallback builder.
//
// castrum ships PREBUILT addons for every `napi.targets` platform (the CI
// "build" job compiles them per-platform and the "publish" job stages all of
// them into one tarball), so on a supported platform this script is a fast
// no-op. It exists to keep the core CROSS-COMPATIBLE when that prebuilt path
// is NOT available:
//
//   - the host platform / libc is not in napi.targets (e.g. linux-armv7,
//     freebsd, android, x86 32-bit, …),
//   - a partial tarball shipped without this platform's artifact
//     (CASTRUM_PUBLISH_ALLOW_PARTIAL local publish), or
//   - the artifact failed to load and the user wants a matching rebuild.
//
// In those cases it compiles the addon FROM SOURCE in the consumer's
// node_modules (`cargo build --release`), so the core keeps working anywhere a
// Rust toolchain exists.
//
// Behaviour (in order):
//   1. If a loadable artifact for this host already exists next to the script
//      (a shipped prebuilt), do nothing — installs stay fast. Forced rebuild
//      with `npm install --build-from-source`.
//   2. Else if CASTRUM_SKIP_BUILD is set, or CI is detected (GitHub Actions
//      builds the addon explicitly), warn and skip.
//   3. Else if no `cargo`/`rustc` is on PATH, warn and skip (the runtime
//      loader then fails with a clear "build it" error if the addon is needed).
//   4. Else run `cargo build --release` and copy the resulting cdylib to every
//      artifact name the loader probes for this host, so whichever libc/name
//      variant it tries first, it finds a correct file.
//
// CASTRUM_REQUIRE_BUILD=1 turns every "warn and skip" above into a hard install
// failure — for strict environments that must guarantee a loadable addon.
//
// No dependency on the `@napi-rs/cli`: `build.rs` runs `napi_build::setup()`
// during a plain `cargo build`, and the produced cdylib IS the `.node` file the
// napi CLI would rename — so this works in a consumer's node_modules where the
// CLI (a devDependency) is not installed.
//
// The pure helpers are exported for tests (test/unit/native/postinstall.test.ts);
// the script only auto-runs when invoked directly (npm/bun postinstall hook).

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const IS_MAIN = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

const log = (msg) => console.log(`postinstall: ${msg}`)
const warn = (msg) => console.warn(`postinstall: WARNING: ${msg}`)

/**
 * Artifact names `src/native/loader.ts` probes for a host, mirroring its
 * `libcVariants` logic. A source build always produces the portable BASELINE
 * (not the optional x86-64-v3 SIMD variant), so this omits the v3 name — the
 * loader falls through from the absent v3 file to the baseline names below.
 *
 * @param platform `process.platform`-style value ('linux' | 'darwin' | 'win32' | …)
 * @param arch `process.arch`-style value ('x64' | 'arm64' | …)
 * @returns artifact file names, in loader probe order
 */
export function napiArtifactCandidates(platform, arch) {
  const libcVariants =
    platform === 'win32' ? ['msvc', 'gnu'] : platform === 'linux' ? ['gnu', 'musl'] : ['']
  const names = libcVariants.map(
    (libc) => `castrum.${platform}-${arch}${libc ? `-${libc}` : ''}.node`,
  )
  names.push('castrum.node')
  return names
}

/**
 * Path of the cdylib `cargo build --release` produces for the current host
 * (crate [lib] name = "castrum"; build.rs runs napi_build::setup()).
 *
 * @param root package root directory
 * @param platform `process.platform`-style value
 * @returns absolute path to the built cdylib
 */
export function cdylibArtifact(root, platform) {
  const release = join(root, 'target', 'release')
  if (platform === 'win32') return join(release, 'castrum.dll')
  if (platform === 'darwin') return join(release, 'libcastrum.dylib')
  return join(release, 'libcastrum.so')
}

function commandExists(cmd, env) {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', [cmd], { stdio: 'ignore', env })
      : spawnSync('which', [cmd], { stdio: 'ignore', env })
  return probe.status === 0
}

/**
 * Ensure a loadable native addon exists for this host, building from source as
 * a fallback when no prebuilt ships. Pure-ish and testable: every input
 * (`root`, `platform`, `arch`, `env`) can be injected, and `cargo` is only ever
 * invoked after all short-circuit checks pass.
 *
 * @param root package root (where the .node artifacts live / where to build)
 * @param opts overrides for testability: `{ platform, arch, env }`
 * @returns `{ status: 'skip', reason }` or `{ status: 'built', candidates }`
 */
export function ensureNativeAddon(root = ROOT, opts = {}) {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const env = opts.env ?? process.env

  const candidates = napiArtifactCandidates(platform, arch)
  const prebuilt = candidates.find((name) => {
    try {
      return statSync(join(root, name)).size > 0
    } catch {
      return false
    }
  })
  const force = env.npm_config_build_from_source === 'true'

  if (prebuilt && !force) {
    log(`prebuilt addon present (${prebuilt}) — nothing to build`)
    return { status: 'skip', reason: 'prebuilt' }
  }
  if (force) log('npm_config_build_from_source set — forcing a source rebuild')

  if (env.CASTRUM_SKIP_BUILD) {
    warn(
      'CASTRUM_SKIP_BUILD is set — skipping the source build. If no prebuilt ' +
        'ships for this platform the native addon will be missing at runtime.',
    )
    return { status: 'skip', reason: 'env' }
  }
  if (env.CI) {
    // GitHub Actions etc. install deps first, then build the addon explicitly
    // (bun run build / napi build) — don't double-build during bun install.
    if (!prebuilt) {
      warn('CI detected — skipping the source build (CI builds the addon explicitly).')
    }
    return { status: 'skip', reason: 'ci' }
  }

  if (!commandExists('cargo', env) || !commandExists('rustc', env)) {
    const msg =
      `no Rust toolchain (cargo/rustc) found — cannot build the castrum addon for ` +
      `${platform}/${arch}. Install Rust from https://rustup.rs and re-run ` +
      `npm install, or set CASTRUM_SKIP_BUILD=1 to silence this warning.`
    if (env.CASTRUM_REQUIRE_BUILD) throw new Error(msg)
    warn(msg)
    return { status: 'skip', reason: 'no-toolchain' }
  }

  log(
    `no prebuilt addon for ${platform}/${arch} — building from source ` +
      '(cargo build --release; requires network to crates.io, a few minutes on first run)',
  )
  // Windows needs the shell so `cargo` resolves via PATH/PATHEXT (cargo.exe).
  const run =
    process.platform === 'win32'
      ? spawnSync('cargo build --release', { cwd: root, stdio: 'inherit', shell: true })
      : spawnSync('cargo', ['build', '--release'], { cwd: root, stdio: 'inherit' })
  if (run.status !== 0) {
    const msg =
      `cargo build --release failed (exit ${run.status ?? 'unknown'}); the castrum ` +
      `native addon could not be built for ${platform}/${arch}.`
    if (env.CASTRUM_REQUIRE_BUILD) throw new Error(msg)
    warn(msg)
    return { status: 'skip', reason: 'build-failed' }
  }

  const built = cdylibArtifact(root, platform)
  if (!existsSync(built)) {
    const msg = `build finished but no cdylib found at ${built}`
    if (env.CASTRUM_REQUIRE_BUILD) throw new Error(msg)
    warn(msg)
    return { status: 'skip', reason: 'artifact-missing' }
  }

  // Copy the SAME correctly-built binary to every candidate name the loader
  // probes. Only one is ever loaded (the first existing candidate), and since
  // the file was built on this exact host its content always matches — so a
  // glibc build copied under the musl name is still the right binary for this
  // machine, and the loader finds a working file regardless of its probe order.
  for (const name of candidates) {
    copyFileSync(built, join(root, name))
  }
  log(`built + staged native addon for ${platform}/${arch}: ${candidates.join(', ')}`)
  return { status: 'built', candidates }
}

if (IS_MAIN) {
  try {
    ensureNativeAddon()
  } catch (err) {
    console.error(`\npostinstall: ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
