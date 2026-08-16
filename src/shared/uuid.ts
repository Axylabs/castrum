// src/shared/uuid.ts — UUIDv7 generation (facade).
//
// UUIDv7 delegates to the runtime adapter's uuid (`src/runtime/uuid.ts`):
// `Bun.randomUUIDv7` on Bun (measured ~2x faster than the FFI-crossing rust
// path) and `crypto.randomUUID` (RFC 4122 v4) under Node.

import { runtimeUuid } from '../runtime/uuid'

/**
 * Generate a UUIDv7 (time-ordered) string, preferring Bun's native built-in.
 * Under Node this falls back to `crypto.randomUUID` (v4).
 *
 * @returns A UUID string.
 */
export const uuidv7: () => string = runtimeUuid.uuidv7
