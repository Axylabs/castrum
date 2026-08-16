// src/runtime/uuid.ts — UUIDv7 generation (Bun built-in, Node fallback).
//
// Deliberately does NOT implement UUIDv7 in Rust: the decision matrix measured
// `Bun.randomUUIDv7` ~2x faster than the FFI-crossing rust random-token path,
// so this delegates to the Bun built-in and falls back to
// `crypto.randomUUID` (RFC 4122 v4) under Node. Formerly in
// `src/shared/uuid.ts`; the branches now live here, selected once at load.

import { detectedRuntime } from './detect'
import type { UuidAdapter } from './types'

/** Last-resort synchronous UUIDv4 (only if `crypto.randomUUID` is unavailable). */
function fallbackRandomUuid(): string {
  const bytes = new Uint8Array(16)
  const c = globalThis.crypto
  if (c?.getRandomValues) {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40 // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function bunUuidv7(): string {
  return (
    (globalThis as { Bun?: { randomUUIDv7?: () => string } }).Bun?.randomUUIDv7?.() ??
    globalThis.crypto?.randomUUID?.() ??
    fallbackRandomUuid()
  )
}

function nodeUuidv7(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomUuid()
}

/** Build the uuid adapter for a runtime. */
export function createUuidAdapter(name: 'bun' | 'node' | 'unknown'): UuidAdapter {
  return name === 'bun' ? { uuidv7: bunUuidv7 } : { uuidv7: nodeUuidv7 }
}

/** The shared uuid adapter for the detected runtime (selected once at load). */
export const runtimeUuid: UuidAdapter = createUuidAdapter(detectedRuntime)
