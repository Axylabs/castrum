// src/baseline/tasks/bun-builtins.ts — DIAGNOSTIC baselines that race castrum
// ops against Bun's native built-ins (Bun.hash, Bun.password, Bun.CryptoHasher,
// Bun.gzipSync/brotliCompressSync, Bun.randomUUIDv7, Bun.validators).
//
// Purpose: answer "for the same workload, does a Bun built-in beat the castrum
// op?" — the raw material for docs/bun-builtins-decision-matrix.md and for
// deciding where @flux/native should delegate to Bun instead of calling Rust.
//
// These are NOT wired into the proven-audit: the task names they feed use the
// `diag:` prefix so scripts/check-proven.ts (which matches PROVEN_SURFACE
// rustTask names and their `_`-suffixed variants) never aggregates them.
//
// Every function guards `typeof Bun` so the module still loads under Node —
// the tasks are only driven by `bun run check` (always Bun), but a stray
// import under Node must not throw.
//
// NOTE: unlike the rest of src/baseline, these baselines are Bun-only BY
// DESIGN — they exist specifically to measure Bun's built-ins.

/** Bun.hash (default wyhash) over bytes. Runtime returns bigint; typed number|bigint. */
export function nativeBunHashWyhash(bytes: Uint8Array): number | bigint {
  if (typeof Bun === 'undefined') return 0n
  return Bun.hash(bytes) as number | bigint
}

/** Bun.hash.crc32 over bytes (unsigned 32-bit). */
export function nativeBunHashCrc32(bytes: Uint8Array): number {
  if (typeof Bun === 'undefined') return 0
  return Bun.hash.crc32(bytes) as number
}

/** Bun.hash.xxHash3 over bytes (64-bit). */
export function nativeBunHashXxh3(bytes: Uint8Array): bigint {
  if (typeof Bun === 'undefined') return 0n
  return Bun.hash.xxHash3(bytes) as bigint
}

/** Bun.CryptoHasher HMAC-SHA256 (synchronous). */
export function nativeBunHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (typeof Bun === 'undefined') return new Uint8Array(0)
  const hasher = new Bun.CryptoHasher('sha256', key)
  hasher.update(data)
  return hasher.digest()
}

/**
 * Bun.password.hashSync argon2id with a REDUCED cost (4 MiB, 1 iteration) so
 * the comparison stays snappy and matches castrum's own bench cost
 * (mCost 4096 / tCost 1). Bun generates the salt internally.
 */
export function nativeBunPasswordHash(password: Uint8Array, _salt: Uint8Array): string {
  if (typeof Bun === 'undefined') return ''
  return Bun.password.hashSync(new TextDecoder().decode(password), {
    algorithm: 'argon2id',
    memoryCost: 4096, // KiB == 4 MiB (matches rust mCost 4096)
    timeCost: 1,
  })
}

/** Lazy memoized argon2id hash for the fixture password (for verifySync). */
let _bunArgonHash: string | null = null
/** Get a Bun argon2id hash for the (constant) fixture password, computing once. */
export function bunArgonHashForVerify(password: Uint8Array): string {
  if (_bunArgonHash === null) {
    _bunArgonHash = nativeBunPasswordHash(password, new Uint8Array(0))
  }
  return _bunArgonHash
}

/** Bun.password.verifySync against the memoized argon2id hash. */
export function nativeBunPasswordVerify(password: Uint8Array): boolean {
  if (typeof Bun === 'undefined') return false
  return Bun.password.verifySync(
    new TextDecoder().decode(password),
    bunArgonHashForVerify(password),
  )
}

/**
 * Bun.password.hashSync bcrypt at `cost`. Bun generates the salt internally;
 * bcrypt strings are capped at 72 input bytes (Bun SHA-256s longer inputs).
 */
export function nativeBunPasswordHashBcrypt(password: Uint8Array, cost: number): string {
  if (typeof Bun === 'undefined') return ''
  return Bun.password.hashSync(new TextDecoder().decode(password), {
    algorithm: 'bcrypt',
    cost,
  })
}

/** Lazy memoized bcrypt hash for the fixture password (for verifySync). */
let _bunBcryptHash: string | null = null
/** Get a Bun bcrypt hash for the (constant) fixture password, computing once. */
export function bunBcryptHashForVerify(password: Uint8Array, cost: number): string {
  if (_bunBcryptHash === null) {
    _bunBcryptHash = nativeBunPasswordHashBcrypt(password, cost)
  }
  return _bunBcryptHash
}

/** Bun.password.verifySync against the memoized bcrypt hash. */
export function nativeBunPasswordVerifyBcrypt(password: Uint8Array, cost: number): boolean {
  if (typeof Bun === 'undefined') return false
  return Bun.password.verifySync(
    new TextDecoder().decode(password),
    bunBcryptHashForVerify(password, cost),
  )
}

/** Bun.randomUUIDv7 (UUIDv7, time-ordered). */
export function nativeBunRandomUuidV7(): string {
  if (typeof Bun === 'undefined') return ''
  return Bun.randomUUIDv7()
}

/** Bun.gzipSync — synchronous gzip compression. */
export function nativeBunGzipCompress(bytes: Uint8Array): Uint8Array {
  if (typeof Bun === 'undefined') return new Uint8Array(0)
  return Bun.gzipSync(toPlainBuffer(bytes))
}

/** Bun.gunzipSync — synchronous gzip decompression. */
export function nativeBunGunzip(bytes: Uint8Array): Uint8Array {
  if (typeof Bun === 'undefined') return new Uint8Array(0)
  return Bun.gunzipSync(toPlainBuffer(bytes))
}

/** Coerce a `Uint8Array<ArrayBufferLike>` to the strict `Uint8Array<ArrayBuffer>` some Bun APIs demand. */
function toPlainBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as unknown as Uint8Array<ArrayBuffer>
}
