// src/rust-ffi/into.ts — pooled `*Into` output-write helper (napi fallback).

/**
 * Write `bytes` into a caller-owned `output` buffer, or throw when it does not
 * fit.
 *
 * Shared tail of the pooled (`*Into`) napi-fallback paths: every op copies the
 * allocating result into the caller buffer with the same capacity check, error
 * message, and byte-length return. The bun:ffi `_into` path never reaches this
 * helper — the C ABI streams straight into `output`.
 *
 * @param op Label for the error message (e.g. `"gzip compress"`).
 * @param output The caller-owned destination buffer.
 * @param bytes The allocating op result to copy in.
 * @returns The number of bytes written (`bytes.length`).
 */
export function writeInto(op: string, output: Uint8Array, bytes: Uint8Array): number {
  if (output.length < bytes.length) throw new Error(`${op}: output buffer too small`)
  output.set(bytes)
  return bytes.length
}
