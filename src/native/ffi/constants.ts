// src/native/ffi/constants.ts — caps / sizing heuristics / self-test
// vectors for the bun:ffi transport (pure data, no logic).
//
// The caps mirror the Rust napi layer (decompression-bomb guard, JSON-patch
// output bound). The sizing heuristics are ALLOCATION caps only — `growExact`
// in the core covers any residual miss with one exact-size retry, so a guess
// that is too small costs one extra native pass, never a wrong result.

// ── Caps mirrored from the Rust napi layer ────────────────────────
/** rust/payload/compress.rs DEFAULT_MAX_DECOMPRESSED (64 MiB decompression-bomb
 * guard — must stay in sync; do not raise without benchmarking). */
export const MAX_DECOMPRESSED = 64 * 1024 * 1024
/** rust/json/json_patch_ops.rs MAX_JSON_PATCH_OUTPUT (128 MiB). */
export const MAX_JSON_PATCH_OUTPUT = 128 * 1024 * 1024

// ── Output-buffer sizing heuristics (measured) ─────────────────────
// These are ALLOCATION caps only, not correctness bounds: `growExact` covers
// any residual miss with at most one exact-size retry (no re-run loop), so a
// guess that is too small costs one extra native pass, never a wrong result.
//
// Compress: a 75 KiB input compresses to <1 KiB, so a 16 KiB initial is
// plenty and single-pass; the 1 MiB ceiling bounds incompressible data.
/** gzip/brotli compress: initial output-buffer size (bytes). */
export const COMPRESS_INITIAL_CAP = 16 * 1024
/** gzip/brotli compress: ceiling that bounds incompressible input (bytes). */
export const COMPRESS_MAX_CAP = 1024 * 1024
/** gzip/brotli compress: small-input slack added above `data.length` (bytes). */
export const COMPRESS_HEADROOM = 64
// Decompress (no trailer / expensive trailer): typical JSON/text ratios.
/** gzip decompress: output-size guess multiplier over the input length. */
export const DECOMPRESS_GUESS_MULTIPLIER_GZIP = 16
/** brotli decompress: output-size guess multiplier over the input length. */
export const DECOMPRESS_GUESS_MULTIPLIER_BROTLI = 32
/** decompress: 4 MiB over-alloc bound used as a last-resort initial size. */
export const DECOMPRESS_FALLBACK_CAP = 4 * 1024 * 1024
/** decompress: minimum initial output size (bytes). */
export const DECOMPRESS_MIN_INITIAL = 1024
// JWT: token ≈ header(~36) + payload(≈4/3× claims) + sig(~43) + 2 dots. The
// old `claims.length + 128` under-sized a typical token (measured 168 B for a
// 30 B claim → grow-retry double-run, making ffi slower than napi). 2×+128
// with a 256-byte floor covers typical claims in one pass.
/** jwt sign: claims-length multiplier for the initial output-size guess. */
export const JWT_INITIAL_MULTIPLIER = 2
/** jwt sign: fixed byte slack added to the claims-length guess. */
export const JWT_INITIAL_EXTRA = 128
/** jwt sign: minimum initial output size (bytes). */
export const JWT_INITIAL_FLOOR = 256

// ── Known-good vectors for the bind-time self-test ───────────────
// These mirror the Rust `#[cfg(test)]` vectors in rust/ffi.rs.
/** Self-test vector: ASCII "hello" (hex-encodes to `68656c6c6f`). */
export const SELFTEST_HEX = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello" -> 68656c6c6f
/** Self-test vector: JSON `{"a":1}` (validates via the packed JSON ops). */
export const SELFTEST_JSON = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]) // "{\"a\":1}"

/** Empty view for `null` body slots in (ptr, len) pairs — the C side treats
 * len 0 as "no body" regardless of the pointer value. */
export const EMPTY_VIEW = new Uint8Array(0)
