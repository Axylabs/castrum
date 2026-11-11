// native.ts — dependency-light native bridge entry for framework runtimes.

export { createNativeBridge } from './src/native/bridge'
export type { NativeBridge, NativeBridgeOptions } from './src/native/bridge'
export type { BunFFI, FfiMode } from './src/native/ffi/types'
export type { NativeAddon } from './src/native/types'
export { ffiBuf, ffiString, ffiU32, ffiU64 } from './src/native/read'
export type { FfiBuf } from './src/native/read'
