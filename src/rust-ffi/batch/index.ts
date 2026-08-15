// src/rust-ffi/batch/index.ts — Array-of-bytes batch namespace (barrel).
//
// Re-exports the `RustBatch` interface (./types.ts) and its builder
// (./build.ts) so existing `import { buildBatch, type RustBatch } from
// '../rust-ffi/batch'` call sites keep working.

export type { RustBatch } from './types'
export { buildBatch } from './build'
