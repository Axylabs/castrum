// scripts/ensure-dts-typescript.mjs — guarantee the TypeScript that
// dts-bundle-generator resolves has the pre-7 JS API (`ts.sys`), regardless of
// the installer's linker.
//
// The repo pins the project compiler to TypeScript 7 (native) and gives
// `dts-bundle-generator` its own copy via nested `overrides` — which only
// resolve under Bun's HOISTED linker. Under an isolated/pnpm tree the tool
// resolves TS 7 instead (whose package root exports only `{ version }`) and
// `build:js:types` dies with:
//   Cannot read properties of undefined (reading 'getCurrentDirectory')
//
// This preflight copies the pinned `typescript-dts` (5.9.3) alias into the
// tool's `node_modules` when its resolved compiler is not 5.x. It is a no-op
// when the nested override already resolved correctly.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()
const toolDir = join(cwd, 'node_modules', 'dts-bundle-generator')

if (!existsSync(join(toolDir, 'package.json'))) {
  console.error('ensure-dts-typescript: dts-bundle-generator is not installed')
  process.exit(1)
}

/** Version string from a package.json, or null. */
function versionAt(pkgJsonPath) {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    return null
  }
}

const nestedTs = join(toolDir, 'node_modules', 'typescript', 'package.json')
const resolvedVersion =
  versionAt(nestedTs) ?? versionAt(join(cwd, 'node_modules', 'typescript', 'package.json'))

if (resolvedVersion && resolvedVersion.split('.')[0] === '5') {
  process.exit(0) // already the pre-7 compiler — nothing to do
}

const alias = join(cwd, 'node_modules', 'typescript-dts')
if (!existsSync(join(alias, 'package.json'))) {
  console.error('ensure-dts-typescript: the `typescript-dts` alias is missing — run `bun install`')
  process.exit(1)
}

const destDir = join(toolDir, 'node_modules')
mkdirSync(destDir, { recursive: true })
rmSync(join(destDir, 'typescript'), { recursive: true, force: true })
cpSync(alias, join(destDir, 'typescript'), { recursive: true, dereference: true })
console.log(
  `ensure-dts-typescript: pinned dts-bundle-generator to typescript-dts ` +
    `(resolved was ${resolvedVersion ?? 'missing'})`,
)
