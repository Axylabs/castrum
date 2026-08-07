import { scryptSync } from "node:crypto";

export interface PasswordHashOptions {
  mCost?: number;
  tCost?: number;
  pCost?: number;
  outLen?: number;
}

/**
 * JS baseline password hash: Node's built-in scrypt (a memory-hard KDF, the
 * same class of "expensive by design" work as argon2id). Raw derived key bytes
 * out — NOT a PHC string (the Rust side emits a PHC string), so this is a
 * timing reference, not a byte-parity check.
 */
export function nativePasswordHash(
  password: Uint8Array,
  salt: Uint8Array,
  options?: PasswordHashOptions | null,
): Uint8Array {
  const outLen = options?.outLen ?? 32;
  const derived = scryptSync(Buffer.from(password), Buffer.from(salt), outLen);
  return new Uint8Array(derived);
}
