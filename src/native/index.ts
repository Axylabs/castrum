// src/native/index.ts — Native addon layer (barrel).
//
// Re-exports the addon type surface (./types.ts) and the lazy loader
// (./loader.ts). Importing this barrel does NOT dlopen the addon — use
// `getAddon()` / `lazyAddon` at call time.

export { getAddon, getAddonPath, lazyAddon } from './loader'
export * from './types'
