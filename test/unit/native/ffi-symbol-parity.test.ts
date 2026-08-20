/**
 * FFI symbol-parity guard (source-level): every `castrum_*` C-ABI export in
 * rust/ffi.rs must be bound in src/native/ffi.ts's `dlopen` symbol map, and
 * every bound symbol must exist in Rust.
 *
 * Closes the drift class where a NEW `castrum_*` export (or a renamed one) is
 * silently never bound — it would compile and ship, but simply never be
 * called — and where a bound symbol that no longer exists in Rust would fail
 * at dlopen time (caught late, in production). The bind-time self-test
 * (src/native/ffi.ts) is the VALUE backstop (wrong results → napi fallback);
 * this test is the COMPLETENESS backstop (missing bindings are caught here).
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

// The C-ABI surface lives in rust/ffi/ (a folder since the ffi.rs split) —
// scan every .rs file so a symbol moved between the domain files is still seen.
const ffiDir = new URL('../../../rust/ffi/', import.meta.url)
const rustSource = readdirSync(ffiDir)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => readFileSync(new URL(f, ffiDir), 'utf8'))
  .join('\n')
const ffiSource = readFileSync(new URL('../../../src/native/ffi.ts', import.meta.url), 'utf8')
// The bind-time self-test lives in src/native/ffi/build/*.ts (per-domain
// `selfTest*` functions) after the transport-core decomposition — scan the
// whole folder for wrapper coverage.
const selftestDir = new URL('../../../src/native/ffi/build/', import.meta.url)
const selftestSource = readdirSync(selftestDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(f, selftestDir), 'utf8'))
  .join('\n')

/** All `castrum_*` C-ABI export names declared in rust/ffi/. */
function rustExports(src: string): Set<string> {
  const names = new Set<string>()
  // Direct `extern "C" fn castrum_x(...)` declarations...
  for (const m of src.matchAll(/extern "C" fn (castrum_\w+)/g)) {
    const name = m[1]
    if (name) names.add(name)
  }
  // ...plus macro-generated exports (compress_to_out!, validator_c_abi!). The
  // invocation is formatted multi-line in rust/ffi/ (name on its own line
  // after the macro + `(`), so allow whitespace/newlines before the name.
  for (const m of src.matchAll(/(?:compress_to_out|validator_c_abi)!\s*\(\s*(castrum_\w+)/g)) {
    const name = m[1]
    if (name) names.add(name)
  }
  return names
}

/** Symbol-map keys in the `dlopen(path, { castrum_x: {...} })` call. */
function ffiBoundSymbols(src: string): Set<string> {
  const names = new Set<string>()
  // The dlopen symbol-map entries are the only `castrum_x: {` occurrences in
  // the file (the `(sym.castrum_x as RawN)` bindings never use `: {`).
  for (const m of src.matchAll(/(castrum_\w+):\s*\{/g)) {
    const name = m[1]
    if (name) names.add(name)
  }
  return names
}

/** Distinct BunFFI wrapper methods exercised by the bind-time self-test. */
function selfTestCovers(src: string): Set<string> {
  const methods = new Set<string>()
  // The per-domain self-tests in ffi/build/*.ts each take `b: BunFFI` and call
  // `b.<method>(`; the builders call `sym.castrum_*` instead, so scanning the
  // build folder for `b.` calls is a precise coverage map.
  for (const m of src.matchAll(/\bb\.(\w+)\(/g)) {
    const name = m[1]
    if (name) methods.add(name)
  }
  return methods
}

describe('FFI symbol parity (source-level)', () => {
  test('every castrum_* Rust export is bound in the ffi.ts symbol map', () => {
    const rust = rustExports(rustSource)
    const bound = ffiBoundSymbols(ffiSource)
    const unbound = [...rust].filter((s) => !bound.has(s))
    expect(unbound).toEqual([])
  })

  test('every bound symbol exists in rust/ffi.rs (no stale bindings)', () => {
    const rust = rustExports(rustSource)
    const bound = ffiBoundSymbols(ffiSource)
    const stale = [...bound].filter((s) => !rust.has(s))
    expect(stale).toEqual([])
  })

  test('the symbol sets are exactly equal', () => {
    const rust = rustExports(rustSource)
    const bound = ffiBoundSymbols(ffiSource)
    expect(rust.size).toBe(bound.size)
    expect([...rust].sort()).toEqual([...bound].sort())
  })

  test('the bind-time self-test exercises a broad set of wrappers', () => {
    const covered = selfTestCovers(selftestSource)
    // Current coverage is ~40 of 47 wrappers; floor guards against the
    // self-test being gutted (a silent loss of the ffi value backstop).
    expect(covered.size).toBeGreaterThanOrEqual(30)
  })
})
