// src/runtime/uuid.ts — UUIDv7 generation (Bun built-in, Node fallback).
//
// Deliberately does NOT implement UUIDv7 in Rust: the decision matrix measured
// `Bun.randomUUIDv7` ~2x faster than the FFI-crossing rust random-token path,
// so this delegates to the Bun built-in and falls back to
// `crypto.randomUUID` (RFC 4122 v4) under Node. Formerly in
// `src/shared/uuid.ts`; the branches now live here, selected once at load.

import { detectedRuntime } from './detect'
import type { UuidAdapter } from './types'

function bunUuidv7(): string {
  return (
    (globalThis as { Bun?: { randomUUIDv7?: () => string } }).Bun?.randomUUIDv7?.() ??
    globalThis.crypto.randomUUID()
  )
}

function nodeUuidv7(): string {
  return globalThis.crypto.randomUUID()
}

/** Build the uuid adapter for a runtime. */
export function createUuidAdapter(name: 'bun' | 'node' | 'unknown'): UuidAdapter {
  return name === 'bun' ? { uuidv7: bunUuidv7 } : { uuidv7: nodeUuidv7 }
}

/** The shared uuid adapter for the detected runtime (selected once at load). */
export const runtimeUuid: UuidAdapter = createUuidAdapter(detectedRuntime)
