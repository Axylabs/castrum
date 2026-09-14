// src/task/op.ts — pure task-op registry: numeric ids + packed-arg encoders.
//
// PURE by design (no addon, no module state) so the wire encoding is directly
// unit-testable. The ids MUST match the `OP_*` constants in `rust/task/ops.rs`;
// `test/unit/task/runtime.test.ts` pins the round-trip.

/** Numeric op ids — mirror `rust/task/ops.rs`. */
export const TASK_OP = {
  /** args `[u32 maxDecompressed LE][gzip bytes]` (0 = native 64 MiB default). */
  gzipDecompress: 1,
  /** args `[u32 rounds][u32 dkLen][u32 saltLen][salt][password]`. */
  pbkdf2Sha256: 2,
  /** `gzipDecompress` writing into a caller buffer (zero-copy output). */
  gzipDecompressInto: 3,
  /** args `[u32 pwLen][u32 phcLen][password][phc]` → body is one byte (1 = match). */
  argon2Verify: 4,
  /** args `[u32 maxDecompressed LE][brotli bytes]` (0 = native 64 MiB default). */
  brotliDecompress: 5,
  /** `brotliDecompress` writing into a caller buffer (zero-copy output). */
  brotliDecompressInto: 6,
  /** args `[u32 level][gzip bytes]` (level clamped to 0-9 natively). */
  gzipCompress: 7,
} as const

/** A task op name (`gzipDecompress`). */
export type TaskOpName = keyof typeof TASK_OP

/** Completion status codes (mirror `rust/task/ops.rs`). */
export const TASK_STATUS_OK = 0
/** The op returned an error; the body is the UTF-8 error message. */
export const TASK_STATUS_ERROR = 1
/** The task was cancelled before/while it ran; the body is empty. */
export const TASK_STATUS_CANCELLED = 2
/** The zero-copy destination was too small; the body is the exact size (u64 LE). */
export const TASK_STATUS_TOO_SMALL = 3
/** The op has no zero-copy form; fall back to the copy path. */
export const TASK_STATUS_UNSUPPORTED = 4

/** Shared zero-length payload (header-only ops). */
const EMPTY = new Uint8Array(0)

// Shared `[u32 header][bytes]` packing for the single-header codec ops (the
// `maxDecompressed` cap for decompress, the level for compress).
function packHeaderAndBytes(header: number, data: Uint8Array, out?: Uint8Array): Uint8Array {
  const need = 4 + data.length
  const dest = out !== undefined && out.length >= need ? out : new Uint8Array(need)
  // View-aware: `out` may be a subarray with a non-zero byteOffset.
  new DataView(dest.buffer, dest.byteOffset, need).setUint32(0, header >>> 0, true)
  dest.set(data, 4)
  return dest.subarray(0, need)
}

/**
 * Pack the `gzip.decompress` task args: `[u32 maxDecompressed LE][gzip bytes]`.
 *
 * @param data            Compressed gzip bytes.
 * @param maxDecompressed Output cap in bytes; `undefined`/`0` selects the
 *                        native 64 MiB decompression-bomb default.
 * @param out             Optional caller-owned destination (>= `4 + data.length`),
 *                        returned as a view. Native copies args on submit, so the
 *                        same buffer may be reused for the next submission — but
 *                        only while the caller stays SYNCHRONOUS (a zero-copy
 *                        retry re-submits after an await and must own its memory).
 * @returns A packed args buffer.
 */
export function encodeGzipDecompressArgs(
  data: Uint8Array,
  maxDecompressed?: number,
  out?: Uint8Array,
): Uint8Array {
  return packHeaderAndBytes(maxDecompressed ?? 0, data, out)
}

/**
 * Pack the `brotli.decompress` task args: `[u32 maxDecompressed LE][bytes]`.
 *
 * @param data            Compressed brotli bytes.
 * @param maxDecompressed Output cap in bytes (`undefined`/`0` → native 64 MiB).
 * @param out             Optional caller-owned destination (see the gzip form).
 * @returns A packed args buffer.
 */
export function encodeBrotliDecompressArgs(
  data: Uint8Array,
  maxDecompressed?: number,
  out?: Uint8Array,
): Uint8Array {
  return packHeaderAndBytes(maxDecompressed ?? 0, data, out)
}

/**
 * Pack the `gzip.compress` task HEADER: `[u32 level]`. The payload is passed
 * separately so it can be read in place (zero-copy input) instead of copied.
 *
 * @param level Deflate level (`0`-`9`, clamped natively).
 * @param out   Optional caller-owned destination (>= 4 bytes).
 * @returns The 4-byte header.
 */
export function encodeGzipCompressHeader(level = 6, out?: Uint8Array): Uint8Array {
  return packHeaderAndBytes(level, EMPTY, out)
}

/**
 * Pack the `argon2id.verify` task args:
 * `[u32 pwLen][u32 phcLen][password][phc]`. No `out` parameter on purpose: a
 * shared scratch would keep a plaintext password alive far longer than a
 * per-call allocation, which is the wrong trade for a secret.
 *
 * @param password Candidate password bytes.
 * @param phc      PHC string bytes (`$argon2id$...`).
 * @returns A packed args buffer owned by the caller (Rust copies it on submit).
 */
export function encodeArgon2VerifyArgs(password: Uint8Array, phc: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + password.length + phc.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, password.length >>> 0, true)
  view.setUint32(4, phc.length >>> 0, true)
  out.set(password, 8)
  out.set(phc, 8 + password.length)
  return out
}

/**
 * Safe upper bound on the gzip size of `n` input bytes: deflate's worst case is
 * stored blocks (5 bytes per block) plus the 18-byte gzip wrapper. The 16 KiB
 * block assumption is deliberately conservative (real blocks are 64 KiB), so a
 * destination sized with this can never be too small — no retry round trip.
 *
 * @param n Uncompressed input length in bytes.
 * @returns An upper bound in bytes.
 */
export function gzipCompressUpperBound(n: number): number {
  return n + 5 * (Math.ceil(n / 16384) + 1) + 18
}

/**
 * Starting capacity for a brotli zero-copy destination. Brotli carries no
 * ISIZE trailer, so there is no exact hint: this is a ratio guess, and the
 * needed-size retry lands the exact size if it falls short.
 *
 * @param compressedLen Compressed input length in bytes.
 * @returns A capacity guess in bytes (floored at the runtime's zero-copy size).
 */
export function brotliCapacityGuess(compressedLen: number): number {
  return Math.max(64 * 1024, compressedLen * 8)
}

/**
 * Pack the `pbkdf2.sha256` task args:
 * `[u32 rounds][u32 dkLen][u32 saltLen][salt][password]`.
 *
 * @param password Password bytes (the PBKDF2 secret).
 * @param salt     Salt bytes.
 * @param rounds   Iteration count (clamped to >= 1 natively).
 * @param dkLen    Derived-key length in bytes (default 32, capped at 1 MiB).
 * @returns A packed args buffer owned by the caller (Rust copies it on submit).
 */
export function encodePbkdf2Args(
  password: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  dkLen = 32,
): Uint8Array {
  const out = new Uint8Array(12 + salt.length + password.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, rounds >>> 0, true)
  view.setUint32(4, dkLen >>> 0, true)
  view.setUint32(8, salt.length >>> 0, true)
  out.set(salt, 12)
  out.set(password, 12 + salt.length)
  return out
}
