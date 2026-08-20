// src/native/ffi/build/util.ts — shared helpers + per-bind context for the
// BunFFI surface builders.
//
// Pure helpers (no symbol/bind state): the C ABI "needed-size" convention
// (`growExact`), decoder parity (`writeOrThrow`), packed-verdict unpacking
// (`unpackRateCheck`), length math (`b64Len`, `argon2PhcLength`), the cstring
// return decoder (`cstr`), and the u8 flag coercion (`flag`).
//
// `BuildCtx` carries the per-`bind()` state that every domain builder needs:
// the probe-gated `lenOrView`/`oneArg` argument adapters and the pooled
// scratch buffers (encode scratch, jsonSum/date/rate verdict scratches). It is
// created once in `build()` (src/native/ffi/build.ts) and destructured at the
// top of each domain builder so the method bodies read exactly as before.

/**
 * Per-bind context for the domain builders. Created by `build()`.
 */
export interface BuildCtx {
  /** `true` when the engine's `buffer`/`buffer_length` ABI pair is live. */
  useBufferLength: boolean
  /**
   * The length slot for a `(ptr,len)` pair: the view itself under
   * `buffer_length` (the engine reads byteLength off it — an atomic snapshot),
   * or the explicit length under `(ptr,usize)`. Bind-time constant → JIT-folded.
   */
  lenOrView: (v: Uint8Array) => Uint8Array | number
  /** Single-buffer input adapter: pass the view twice under `buffer_length`. */
  oneArg: (raw: (...a: unknown[]) => number | bigint, v: Uint8Array) => number | bigint
  /** Growable pooled scratch for STRING-returning encode wrappers. */
  scratchFor: (size: number) => Uint8Array
  /** Pooled 9-byte scratch for `jsonSumIds` (packed `[u8 ok][i64 sum LE]`). */
  jsonSumOut: Uint8Array
  jsonSumView: DataView
  /** Pooled 9-byte scratch for `parseHttpDate`. */
  dateScratch: Uint8Array
  dateScratchView: DataView
  /** Pooled 13-byte scratch for the rate-limiter checks. */
  rateScratch: Uint8Array
  rateScratchView: DataView
}

/** Coerce an optional boolean to the C `u8` flag (1/0). */
export const flag = (v?: boolean): number => (v ? 1 : 0)

/**
 * Write with the C ABI's "needed" convention. The C side returns the EXACT
 * total bytes the result requires: `0` = real error (throw immediately — no
 * re-run, no grow-to-max allocation storm on invalid input), `w > out.length`
 * = buffer too small with `w` the exact required size (allocate once, retry),
 * else `w` is the written count. A miss therefore costs at most ONE retry with
 * an exact buffer — never a doubling loop that re-runs the whole native op
 * (which is what made FFI gzip/brotli/jsonPatch slower than napi).
 */
export function growExact(
  write: (out: Uint8Array) => number,
  initial: number,
  max: number,
  error: string,
): Uint8Array {
  let cap = Math.min(Math.max(initial, 16), max)
  for (;;) {
    const out = new Uint8Array(cap)
    const w = Number(write(out))
    if (w === 0) throw new Error(error)
    if (w <= out.length) return out.subarray(0, w)
    if (w > max) throw new Error(error)
    cap = Math.min(w, max)
  }
}

/** Decoder parity: a `0` write on non-empty input throws (napi `Result`). */
export function writeOrThrow(w: number, inputLen: number, label: string): number {
  if (w === 0 && inputLen !== 0) {
    throw new Error(`${label}: invalid input or output buffer too small`)
  }
  return w
}

/** Unpack the packed rate-limit verdict `[u8 allowed][u32 remaining LE][i64 reset_ms LE]`. */
export function unpackRateCheck(
  out: Uint8Array,
  view: DataView,
): {
  allowed: boolean
  remaining: number
  resetMs: number
} {
  return {
    allowed: out[0] === 1,
    remaining: view.getUint32(1, true),
    resetMs: Number(view.getBigInt64(5, true)),
  }
}

/** base64 (no-pad) length of `n` bytes. */
export const b64Len = (n: number): number =>
  n === 0 ? 0 : Math.ceil(n / 3) * 4 - ((3 - (n % 3)) % 3)

/**
 * Exact length of an argon2id PHC string for the given params
 * (m/t/p/salt_len/out_len).
 * Format: `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt b64>$<hash b64>`.
 * The salt b64 length is base64-no-pad of the CALLER's salt byte length
 * (`SaltString::encode_b64`) — NOT a fixed 16 bytes. Hardcoding 22
 * under-counts salts >16 bytes (e.g. the 18-byte "salty-salt-16bytes" →
 * 24 chars) and growExact would re-run the whole ~tens-of-ms hash on the
 * retry (measured 2× slowdown). Pre-sizing exactly keeps `passwordHash` a
 * single native pass.
 */
export function argon2PhcLength(
  m: number,
  t: number,
  p: number,
  saltLen: number,
  outLen: number,
): number {
  return (
    15 + // "$argon2id$v=19$"
    2 + // "m="
    String(m).length +
    3 + // ",t="
    String(t).length +
    3 + // ",p="
    String(p).length +
    1 + // "$" before the salt
    b64Len(saltLen) + // salt b64 (no-pad — depends on the caller's salt length)
    1 + // "$" before the hash
    b64Len(outLen)
  )
}

/**
 * cstring-return (the engine clones the NUL-terminated string at call time)
 * → the JS string directly (native transfer — zero encode); a `null` return
 * is the C failure sentinel → throw.
 */
export function cstr(s: string | null, label: string): string {
  if (s === null) throw new Error(label)
  return s
}
