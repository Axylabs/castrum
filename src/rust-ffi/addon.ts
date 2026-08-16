// src/rust-ffi/addon.ts — Shared lazy addon accessor for the FFI layer.
//
// All rust-ffi namespaces share a single lazily-loading proxy: importing this
// module does NOT dlopen the addon — the first native call triggers loading
// exactly once.

import { getAddon, lazyAddon, type NativeAddon } from '../native'

/** The shared lazy addon proxy (typed as the full native surface). */
export const addon: NativeAddon = lazyAddon(getAddon)
