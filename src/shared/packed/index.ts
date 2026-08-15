// src/shared/packed/index.ts — Packed wire-format helpers (barrel).
//
// Re-exports the pure wire encode/decode helpers (./wire.ts), the native
// JSON-Schema validator + batch helpers (./schema.ts), and the ergonomic
// string parsers (./parsers.ts). Importing this barrel does NOT dlopen the
// addon — only calling a parser in ./parsers.ts does (lazy).

export * from './wire'
export * from './schema'
export * from './parsers'
