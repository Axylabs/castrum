// src/baseline/index.ts — JS baseline implementations (benchmark reference).
//
// Pure-JS reference implementations the CPU benchmark compares the native
// surface against (`rust:*` vs `native:*` columns). Bench-only; not part of
// the shipped public API.

export * from './tasks/json'
export * from './tasks/http'
export * from './tasks/query'
export * from './tasks/cookie'
export * from './tasks/token'
export * from './tasks/websocket'
export * from './tasks/json-patch'
export * from './tasks/hmac'
export * from './tasks/validation'
export * from './tasks/hashing'
export * from './tasks/mime'
export * from './tasks/url'
// Backend-framework feature baselines
export * from './tasks/jwt'
export * from './tasks/password'
export * from './tasks/aead'
export * from './tasks/compress'
export * from './tasks/multipart'
export * from './tasks/template'
export * from './tasks/streaming'
// Bun built-in diagnostics (Bun-only by design — see bun-builtins.ts header)
export * from './tasks/bun-builtins'
// PBKDF2 baseline (node:crypto pbkdf2Sync)
export * from './tasks/pbkdf2'
