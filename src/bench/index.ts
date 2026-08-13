// src/bench/index.ts — CPU benchmark entry (barrel).
//
// `runBenchmark` drives the task framework in ./run.ts; ./types.ts defines
// the task/measure/report shapes. Bench-only; not part of the public API.

export { runBenchmark } from './run'
export * from './types'
