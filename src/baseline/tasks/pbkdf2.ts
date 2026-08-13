// src/baseline/tasks/pbkdf2.ts — PBKDF2 baseline (node:crypto pbkdf2Sync).
//
// Bun has no synchronous PBKDF2 built-in (crypto.subtle.deriveBits is async),
// so the honest baseline for rust.pbkdf2Sha256 is node:crypto's pbkdf2Sync —
// a native OpenSSL-backed KDF. This baseline is runtime-agnostic (works under
// both Bun and Node).

import { pbkdf2Sync } from 'node:crypto'

/**
 * JS baseline PBKDF2-HMAC-SHA256. Returns derived-key bytes.
 */
export function nativePbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  dkLen: number,
): Uint8Array {
  const derived = pbkdf2Sync(Buffer.from(password), Buffer.from(salt), rounds, dkLen, 'sha256')
  return new Uint8Array(derived)
}
