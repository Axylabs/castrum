// src/shared/uuid.ts — UUIDv7 generation.
//
// Deliberately does NOT implement UUIDv7 in Rust: the decision matrix
// (docs/bun-builtins-decision-matrix.md) measured Bun.randomUUIDv7 ~2x faster
// than the FFI-crossing rust random-token path, so this delegates to the Bun
// built-in and falls back to crypto.randomUUID (RFC 4122 v4) under Node.

/** Generate a UUIDv7 (time-ordered) string, preferring Bun's native built-in. */
export function uuidv7(): string {
  const bun = (globalThis as { Bun?: { randomUUIDv7?: () => string } }).Bun;
  if (typeof bun?.randomUUIDv7 === "function") {
    return bun.randomUUIDv7();
  }
  // Node / non-Bun fallback: crypto.randomUUID (v4 — order not guaranteed).
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomUuid();
}

/** Last-resort synchronous UUIDv4 (only if crypto.randomUUID is unavailable). */
function fallbackRandomUuid(): string {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
