// bench/load-phase.ts — load/startup cost decomposition (fresh `bun` per phase).
//
// Answers "where does the ~36ms `import castrum` go?" by measuring each phase
// in its own fresh process (no shared cache):
//   fullImport      : import index.ts (TS graph + eager bun:ffi bind + self-test)
//   bindOnly        : import src/native/ffi.ts + getBunFFI()  (bind + self-test,
//                     no package graph)
//   fullImportNapi  : import index.ts with CASTRUM_FFI_MODE=napi (no ffi bind;
//                     constants falls back to the napi addon dlopen at import)
//   singleDlopen    : raw dlopen of ONE symbol (base dlopen + dlsym + JSC fn)
//   singleCall      : raw dlopen of ONE symbol + first call (adds trampoline JIT)
//   graphIngress    : import src/ingress/index.ts only (module graph cost)
//   graphRustFfi    : import src/rust-ffi/index.ts only (module graph cost)
//
// Run: bun bench/load-phase.ts

import { spawnSync } from 'node:child_process'

const ROOT = new URL('../', import.meta.url).pathname
const ADDON = new URL('../castrum.linux-x64-gnu.node', import.meta.url).pathname
const ITERATIONS = 10

const PHASES: Record<string, string> = {
  fullImport: `await import(${JSON.stringify(`${ROOT}index.ts`)});`,
  bindOnly: `const { getBunFFI } = await import(${JSON.stringify(`${ROOT}src/native/ffi.ts`)}); getBunFFI();`,
  fullImportNapi: `process.env.CASTRUM_FFI_MODE='napi'; await import(${JSON.stringify(`${ROOT}index.ts`)});`,
  singleDlopen: `const { dlopen } = require('bun:ffi'); dlopen(${JSON.stringify(ADDON)}, { castrum_crc32: { args: ['buffer','buffer_length'], returns: 'u32' } });`,
  singleCall: `const { dlopen } = require('bun:ffi'); const { symbols } = dlopen(${JSON.stringify(ADDON)}, { castrum_crc32: { args: ['buffer','buffer_length'], returns: 'u32' } }); symbols.castrum_crc32(new Uint8Array([1,2,3]), new Uint8Array([1,2,3]));`,
  graphIngress: `await import(${JSON.stringify(`${ROOT}src/ingress/index.ts`)});`,
  graphRustFfi: `await import(${JSON.stringify(`${ROOT}src/rust-ffi/index.ts`)});`,
}

function runOnce(body: string): number {
  const res = spawnSync('bun', ['-e', `const t0 = performance.now(); ${body} const ms = performance.now() - t0; console.log(ms)`], {
    encoding: 'utf8',
    maxBuffer: 1_000_000,
  })
  if (res.status !== 0) {
    throw new Error(`probe failed (${res.status}): ${res.stderr}`)
  }
  const lines = res.stdout.trim().split('\n')
  return Number(lines[lines.length - 1])
}

function stats(values: number[]): { min: number; p50: number } {
  const s = [...values].sort((a, b) => a - b)
  return { min: s[0]!, p50: s[Math.floor(s.length / 2)]! }
}

console.log('═══ Load-phase decomposition (fresh bun process per sample, ms) ═══')
const results: { phase: string; min: number; p50: number }[] = []
for (const [phase, body] of Object.entries(PHASES)) {
  const samples: number[] = []
  for (let i = 0; i < ITERATIONS; i++) samples.push(runOnce(body))
  const { min, p50 } = stats(samples)
  results.push({ phase, min, p50 })
  console.log(`${phase.padEnd(16)} min=${min.toFixed(2)}  p50=${p50.toFixed(2)}`)
}

// Derived rows
const find = (p: string) => results.find((r) => r.phase === p)!
console.log('\n═══ Derived ═══')
const tsGraph = find('fullImport').p50 - find('bindOnly').p50
const ffiBind = find('bindOnly').p50
const napiLoad = find('fullImportNapi').p50 - tsGraph
const jitOne = Math.max(find('singleCall').p50 - find('singleDlopen').p50, 0)
console.log(`TS module graph          ≈ ${tsGraph.toFixed(2)}ms  (fullImport − bindOnly)`)
console.log(`bun:ffi bind + self-test  = ${ffiBind.toFixed(2)}ms  (bindOnly)`)
console.log(`napi addon load (est)    ≈ ${napiLoad.toFixed(2)}ms  (fullImportNapi − TS graph)`)
console.log(`single dlopen            = ${find('singleDlopen').p50.toFixed(2)}ms`)
console.log(`single dlopen + 1st call = ${find('singleCall').p50.toFixed(2)}ms  (1st-call JIT ≈ ${jitOne.toFixed(2)}ms)`)
