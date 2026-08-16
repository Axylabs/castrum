// src/native/ffi.ts — Bun-only C-ABI fast path via `bun:ffi` (transport core).
//
// Bun JIT-compiles `bun:ffi` calls down to direct native calls (~10-20ns
// crossing), versus ~100-350ns for a Node-API call. The same cdylib that Node
// loads through napi-rs ALSO exports `extern "C"` symbols (`rust/ffi.rs`), so
// under Bun we can `dlopen` it and call the hot scalar functions directly.
//
// Structure: this file is the transport CORE (dlopen + symbol binding +
// per-call wrappers). The pure pieces live beside it: `ffi/types.ts` (BunFFI /
// FfiMode / Raw signatures), `ffi/constants.ts` (caps + sizing + self-test
// vectors), `ffi/selftest.ts` (the bind-time self-test). This file re-exports
// `getBunFFI` + `BunFFI` so existing importers keep working unchanged.
//
// Safety / correctness strategy:
//   - Lazily bound (no addon/ffi work until first use).
//   - A one-time SELF-TEST runs at bind time (ffi/selftest.ts); any failure
//     disables ffi and falls back to the napi addon.
//   - Decoders that can fail ARE exposed with parity error semantics: a `0`
//     write on non-empty input throws (the napi decoders throw rather than
//     return a short buffer).
//   - Never called under Node (falls back to napi immediately).
//
// Buffer ABI: input/out pointers are `(ptr, len)` pairs; the JS wrapper passes
// `(view, view.length)` and bun:ffi converts the TypedArray to its pointer.

import type { FFITypeOrString } from 'bun:ffi'
import { decodeUtf8, encodeUtf8 } from '../shared/codec'
import { resolveEnvVar } from '../shared/env'
import { isBun } from '../shared/runtime'
import {
  COMPRESS_HEADROOM,
  COMPRESS_INITIAL_CAP,
  COMPRESS_MAX_CAP,
  DECOMPRESS_FALLBACK_CAP,
  DECOMPRESS_GUESS_MULTIPLIER_BROTLI,
  DECOMPRESS_GUESS_MULTIPLIER_GZIP,
  DECOMPRESS_MIN_INITIAL,
  EMPTY_VIEW,
  MAX_DECOMPRESSED,
  MAX_JSON_PATCH_OUTPUT,
} from './ffi/constants'
import { selfTest } from './ffi/selftest'
import type {
  BunFFI,
  FfiMode,
  Raw2,
  Raw3,
  Raw4,
  Raw5,
  Raw6,
  Raw7,
  Raw8,
  Raw9,
  Raw10,
  Raw12,
  RawCStr,
} from './ffi/types'
// Static import: loader.ts has no side effects (path resolution only — no
// dlopen), so this adds zero import-time cost while letting `bind()` reuse the
// exact same resolved `.node` path the napi fallback uses (the shared seam).
import { getAddonPath } from './loader'

// Re-export the type surface so `import type { BunFFI } from '../native/ffi'`
// keeps working (existing call sites).
export type { BunFFI, FfiMode } from './ffi/types'

let cached: BunFFI | null | undefined
/**
 * Resolved buffer ABI mode, set once by `bind()`. `null` = ffi unavailable
 * (Node / `CASTRUM_FFI_MODE=napi` / failed self-test), `'buffer-pair'` = the
 * engine-native `buffer`/`buffer_length` pair is live, `'ptr-len'` = the
 * explicit `(ptr, usize)` fallback.
 */
let bufferAbiMode: 'buffer-pair' | 'ptr-len' | null = null

// ── Transport selection (CASTRUM_FFI_MODE) ───────────────────────

function resolveFfiMode(): FfiMode {
  const raw = resolveEnvVar('CASTRUM_FFI_MODE', ['RUST_FFI_MODE'])
  switch (raw) {
    case 'ffi':
      return 'ffi'
    case 'napi':
      return 'napi'
    default:
      return 'auto'
  }
}

/**
 * Lazily bind the Bun ffi fast path, or return `null` when unavailable
 * (Node, `CASTRUM_FFI_MODE=napi`, missing symbols, or a failed self-test).
 * `undefined` caches "not yet attempted".
 *
 * Under `CASTRUM_FFI_MODE=ffi` a bind/self-test failure THROWS instead of
 * returning null — the caller asked for the primary transport explicitly.
 */
export function getBunFFI(): BunFFI | null {
  if (cached !== undefined) {
    return cached
  }
  cached = bind()
  return cached
}

/**
 * Which buffer ABI the live `bun:ffi` binding uses, or `null` when the
 * transport is unavailable (Node, `CASTRUM_FFI_MODE=napi`, or a failed
 * self-test). `'buffer-pair'` = the engine-native `buffer`/`buffer_length`
 * pair (atomic ptr+byteLength snapshot) is in use; `'ptr-len'` = the explicit
 * `(ptr, usize)` fallback (older Bun / probe failure). Lazy — triggers the
 * same one-time bind as {@link getBunFFI}. Under `CASTRUM_FFI_MODE=ffi` on Bun
 * this is guaranteed non-null; a bind/self-test failure THROWS, matching
 * `getBunFFI`.
 */
export function ffiBufferMode(): 'buffer-pair' | 'ptr-len' | null {
  if (cached === undefined) {
    getBunFFI()
  }
  return bufferAbiMode
}

/**
 * Probe whether this Bun build accepts the `buffer`/`buffer_length` ABI pair in
 * `dlopen`. Bun's docs list `buffer_length` as engine-native (dlopen-supported),
 * but an earlier canary threw "invalid ABI type" for it. If that regressed (or
 * a future Bun removes it), we silently keep explicit `(ptr, len)` pairs. The
 * full bind-time self-test is the safety net either way.
 */
function probeBufferLength(dlopen: typeof import('bun:ffi')['dlopen'], path: string): boolean {
  try {
    const { symbols, close } = dlopen(path, {
      // bun-types lacks the `buffer_length` literal — cast it; runtime support
      // is exactly what this probe is verifying.
      castrum_crc32: {
        args: ['buffer', 'buffer_length'] as unknown as readonly FFITypeOrString[],
        returns: 'u32',
      },
    })
    // `buffer_length` is `buffer`'s length twin — pass the SAME view twice
    // (the engine reads ptr + byteLength off that object at call time).
    const view = new Uint8Array([1, 2, 3])
    const out = (symbols as Record<string, (a: unknown, b: unknown) => unknown>).castrum_crc32?.(
      view,
      view,
    )
    close()
    return typeof out === 'number' && out >= 0
  } catch {
    return false
  }
}

function bind(): BunFFI | null {
  bufferAbiMode = null // reset — the mode below is only valid for a live bind
  const mode = resolveFfiMode()
  if (!isBun()) {
    if (mode === 'ffi') {
      throw new Error(
        'CASTRUM_FFI_MODE=ffi is invalid here: bun:ffi is a Bun-only transport ' +
          '(this process is not Bun). Use CASTRUM_FFI_MODE=auto (default) so Node ' +
          'uses the napi fallback.',
      )
    }
    return null
  }
  if (mode === 'napi') {
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen } = require('bun:ffi') as typeof import('bun:ffi')
    // Resolve the SAME addon file napi uses (./loader.ts — statically imported
    // above; it only resolves the path, it never dlopens the addon).
    const path = getAddonPath()

    // Probe `buffer`/`buffer_length` (the engine reads ptr + len off the SAME
    // TypedArray at call time — an atomic snapshot) once; when supported we use
    // it for the input-only hot fns (one JS arg instead of two), else `(ptr,len)`.
    const useBufferLength = probeBufferLength(dlopen, path)
    bufferAbiMode = useBufferLength ? 'buffer-pair' : 'ptr-len'

    // String ABI specs ("ptr"/"usize"/"u32"...): accepted by bun:ffi and typed
    // via `FFITypeOrString` in bun-types. usize == uint64 on the host ABI.
    // Symbol keys must be the exact `#[no_mangle] extern "C"` names in
    // rust/ffi.rs. Every `(ptr,len)` pair is passed as `(view, view.length)`.
    // The 8 input-only single-buffer fns use `inputAbi`; everything else keeps
    // `(ptr,len)` because the output length is the caller's write cap.
    const inputAbi: readonly FFITypeOrString[] = useBufferLength
      ? (['buffer', 'buffer_length'] as unknown as readonly FFITypeOrString[])
      : ['ptr', 'usize']
    // Phase 1.1: extend `buffer`/`buffer_length` to EVERY `(ptr,len)` pair, not
    // just the input-only fns. The engine reads ptr + byteLength off the SAME
    // view at call time (atomic snapshot), so call sites pass the view twice
    // (see `lenOrView` below). Conversion is POSITIONAL and pair-aware: each
    // `ptr` consumes its following `usize` as a length. Scalar args that happen
    // to be `usize` (the opaque `inner` handle of `castrum_ingress_handle_packed`
    // and the `max` param of gzip/brotli decompress) are passed through
    // unchanged — a blind `usize`→`buffer_length` map would corrupt them.
    const abi = (shape: readonly string[]): readonly FFITypeOrString[] => {
      if (!useBufferLength) return shape as readonly FFITypeOrString[]
      const out: FFITypeOrString[] = []
      for (let i = 0; i < shape.length; i++) {
        const t = shape[i]
        if (t === 'ptr') {
          out.push('buffer' as unknown as FFITypeOrString)
          out.push('buffer_length' as unknown as FFITypeOrString)
          i++ // consume the paired `usize`
        } else {
          out.push(t as FFITypeOrString)
        }
      }
      return out
    }
    // `u64_fast` returns a plain `number` when the value fits (< 2^53) instead
    // of a BigInt — bun-types lacks the literal, so bind it via a typed const
    // (same cast pattern as the `buffer_length` probe above). Every bytes-written
    // return fits in a double, so this removes the per-call BigInt boxing on the
    // hot scalar / `*_into` / packed-parser / ingress calls.
    const U64_FAST = 'u64_fast' as unknown as FFITypeOrString
    const { symbols } = dlopen(path, {
      castrum_crc32: { args: inputAbi, returns: 'u32' },
      castrum_fnv1a64: { args: inputAbi, returns: 'u64' },
      castrum_xxh3: { args: inputAbi, returns: 'u64' },
      castrum_json_valid: { args: inputAbi, returns: 'u8' },
      castrum_utf8_valid: { args: inputAbi, returns: 'u8' },
      castrum_hex_encode: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_hex_decode: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_url_encode: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_url_decode: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      // String-input validators: `cstring` ARG (the engine transcodes the JS
      // string in-engine — no JS-side encode; Rust borrows via CStr::from_ptr).
      castrum_validate_email: { args: ['cstring'], returns: 'u8' },
      castrum_validate_uuid: { args: ['cstring'], returns: 'u8' },
      castrum_validate_ipv4: { args: ['cstring'], returns: 'u8' },
      castrum_validate_ipv6: { args: ['cstring'], returns: 'u8' },
      castrum_json_sum_ids: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_hmac_sha256_verify: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: 'u8',
      },
      castrum_csrf_verify: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: 'u8' },
      castrum_password_verify: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: 'u8' },
      castrum_password_verify_bcrypt: {
        // `phc` crosses as a `cstring` ARG; `password` stays a `(ptr,len)` pair.
        args: abi(['ptr', 'usize', 'cstring']),
        returns: 'u8',
      },
      castrum_ws_accept_key: { args: ['cstring'], returns: 'cstring' },
      castrum_ws_accept_key_into: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_etag: { args: abi(['ptr', 'usize', 'u8']), returns: 'cstring' },
      castrum_etag_into: { args: abi(['ptr', 'usize', 'u8', 'ptr', 'usize']), returns: U64_FAST },
      castrum_conditional_is_not_modified: {
        args: abi(['usize', 'ptr', 'usize', 'ptr', 'usize', 'u8']),
        returns: 'u8',
      },
      castrum_media_type_matcher_matches: {
        args: abi(['usize', 'ptr', 'usize']),
        returns: 'u8',
      },
      castrum_accept_negotiator_negotiate: {
        args: abi(['usize', 'ptr', 'usize']),
        returns: 'cstring',
      },
      castrum_jwt_signer_sign: {
        args: abi(['usize', 'ptr', 'usize', 'i64', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_jwt_signer_verify: {
        args: abi(['usize', 'ptr', 'usize', 'i64', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_template_render: {
        args: abi(['usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_schema_validator_validate: {
        args: abi(['usize', 'ptr', 'usize']),
        returns: 'u8',
      },
      castrum_rate_limiter_check: {
        // `key` crosses as a `cstring` ARG (text, no NUL in the intended use).
        args: abi(['usize', 'cstring', 'i64', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_rate_limiter_check_key: {
        args: abi(['usize', 'i64', 'i64', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_random_token: { args: ['u32'], returns: 'cstring' },
      castrum_random_token_into: { args: ['u32', ...abi(['ptr', 'usize'])], returns: U64_FAST },
      castrum_base64_encode: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'u8', 'u8']),
        returns: U64_FAST,
      },
      castrum_base64_decode: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'u8', 'u8']),
        returns: U64_FAST,
      },
      castrum_hmac_sha256: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_sign_cookie: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: 'cstring' },
      castrum_sign_cookie_into: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_verify_cookie: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: 'cstring' },
      castrum_verify_cookie_into: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_csrf_token: { args: abi(['ptr', 'usize']), returns: 'cstring' },
      castrum_csrf_token_into: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_password_hash: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'u32', 'u32', 'u32', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_password_hash_bcrypt: {
        args: abi(['ptr', 'usize', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_pbkdf2_sha256: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'u32', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_aead_encrypt: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize', 'u8', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_aead_decrypt: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize', 'u8', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_ws_frame_encode: {
        args: abi(['u8', 'ptr', 'usize', 'u8', 'u8', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_json_patch: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_gzip_compress: {
        args: abi(['ptr', 'usize', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_gzip_decompress: {
        args: abi(['ptr', 'usize', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_brotli_compress: {
        args: abi(['ptr', 'usize', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_brotli_decompress: {
        args: abi(['ptr', 'usize', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_gzip_isize: { args: abi(['ptr', 'usize']), returns: 'u32' },
      castrum_http_parse_request_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_query_parse_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_cookie_parse_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_http_date_into: { args: ['f64', ...abi(['ptr', 'usize'])], returns: U64_FAST },
      castrum_sse_encode_into: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize', 'u8', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      // ── Excluded-surface additions ──
      castrum_jwt_sign_bytes: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'i64', 'i64']),
        returns: 'cstring',
      },
      castrum_jwt_sign_bytes_into: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'i64', 'i64', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_ws_frame_decode_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_multipart_parse_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_form_parse_packed: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      // ── Phase 3 — stateless napi-only scalars (now FFI) ──────────
      // Structural parse: parses ONCE, emits a packed token stream with a
      // deduped string table so JS assembles the value with NO second parse.
      castrum_json_parse_packed: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_parse_media_type: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_parse_http_date: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_parse_accept_encoding: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_url_encode_query: { args: abi(['ptr', 'usize']), returns: 'cstring' },
      castrum_url_resolve: {
        args: abi(['ptr', 'usize', 'ptr', 'usize']),
        returns: 'cstring',
      },
      castrum_url_builder_resolve: {
        args: abi(['usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_mime_from_extension: { args: ['cstring'], returns: 'cstring' },
      castrum_jwt_verify: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'i64']),
        returns: 'cstring',
      },
      castrum_ingress_handle_packed: {
        args: abi(['usize', 'ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      // Raw-components sibling of `castrum_ingress_handle_packed`: `url`/`ip`
      // are `cstring` ARGs (Bun transcodes the JS strings to call-scoped
      // NUL-terminated buffers in-engine — no JS-side Buffer.write encode);
      // rid/headers/body are `(ptr,len)` byte slices; out is `(ptr,len)`.
      castrum_ingress_handle_components: {
        args: abi([
          'usize',
          'u8',
          'cstring',
          'cstring',
          'ptr',
          'usize',
          'ptr',
          'usize',
          'ptr',
          'usize',
          'ptr',
          'usize',
        ]),
        returns: U64_FAST,
      },
      castrum_ingress_layout: { args: abi(['ptr', 'usize']), returns: U64_FAST },
      // Per-route native stack (`@ignex/native` also dlopens these exact names
      // itself; castrum binds them for the bind-time self-test + parity guard).
      castrum_route_compile: { args: abi(['ptr', 'usize']), returns: U64_FAST },
      castrum_route_run: {
        args: abi(['usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_route_destroy: { args: ['usize'], returns: 'void' },
    })

    const bindings = build(symbols as Record<string, (...a: unknown[]) => unknown>, useBufferLength)
    if (!selfTest(bindings)) {
      if (mode === 'ffi') {
        throw new Error(
          'CASTRUM_FFI_MODE=ffi: the bun:ffi bind-time self-test failed, so the ' +
            'primary transport cannot be trusted on this Bun/addon combination. ' +
            'Unset CASTRUM_FFI_MODE (or use CASTRUM_FFI_MODE=auto) to fall back to napi.',
        )
      }
      return null
    }
    return bindings
  } catch (err) {
    if (mode === 'ffi') {
      const cause = err instanceof Error ? `: ${err.message}` : ''
      throw new Error(`CASTRUM_FFI_MODE=ffi: failed to bind bun:ffi${cause}`)
    }
    return null
  }
}

// Types for the raw dlopen'd functions (bun:ffi converts Uint8Array -> ptr for
// `ptr` args; `usize`/`u64`/`i64` returns surface as BigInt).

const flag = (v?: boolean): number => (v ? 1 : 0)

/**
 * Write with the C ABI's "needed" convention. The C side returns the EXACT
 * total bytes the result requires: `0` = real error (throw immediately — no
 * re-run, no grow-to-max allocation storm on invalid input), `w > out.length`
 * = buffer too small with `w` the exact required size (allocate once, retry),
 * else `w` is the written count. A miss therefore costs at most ONE retry with
 * an exact buffer — never a doubling loop that re-runs the whole native op
 * (which is what made FFI gzip/brotli/jsonPatch slower than napi).
 */
function growExact(
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
function writeOrThrow(w: number, inputLen: number, label: string): number {
  if (w === 0 && inputLen !== 0) {
    throw new Error(`${label}: invalid input or output buffer too small`)
  }
  return w
}

/** Unpack the packed rate-limit verdict `[u8 allowed][u32 remaining LE][i64 reset_ms LE]`. */
function unpackRateCheck(
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
const b64Len = (n: number): number => (n === 0 ? 0 : Math.ceil(n / 3) * 4 - ((3 - (n % 3)) % 3))

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
function argon2PhcLength(m: number, t: number, p: number, saltLen: number, outLen: number): number {
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

function build(
  sym: Record<string, (...a: unknown[]) => unknown>,
  useBufferLength: boolean,
): BunFFI {
  const crc32 = sym.castrum_crc32 as (...a: unknown[]) => number | bigint
  const fnv = sym.castrum_fnv1a64 as (...a: unknown[]) => number | bigint
  const xxh = sym.castrum_xxh3 as (...a: unknown[]) => number | bigint
  const jsonValid = sym.castrum_json_valid as (...a: unknown[]) => number | bigint
  const utf8Valid = sym.castrum_utf8_valid as (...a: unknown[]) => number | bigint
  const hexEncode = sym.castrum_hex_encode as Raw4
  const hexDecode = sym.castrum_hex_decode as Raw4
  const urlEncode = sym.castrum_url_encode as Raw4
  const urlDecode = sym.castrum_url_decode as Raw4
  const validateEmail = sym.castrum_validate_email as (...a: unknown[]) => number | bigint
  const validateUuid = sym.castrum_validate_uuid as (...a: unknown[]) => number | bigint
  const validateIpv4 = sym.castrum_validate_ipv4 as (...a: unknown[]) => number | bigint
  const validateIpv6 = sym.castrum_validate_ipv6 as (...a: unknown[]) => number | bigint
  const jsonSumRaw = sym.castrum_json_sum_ids as Raw4

  // Single-buffer input fns: with the probe-gated `buffer/buffer_length` ABI the
  // engine reads ptr + byteLength off the SAME TypedArray at call time (an
  // atomic snapshot — pass the view twice, per Bun's docs); with `(ptr,len)` we
  // pass the length explicitly. The branch is on a bind-time constant, so the
  // JIT folds it away at the call site.
  const oneArg = (raw: (...a: unknown[]) => number | bigint, v: Uint8Array): number | bigint =>
    useBufferLength ? raw(v, v) : raw(v, v.length)
  // Phase 1.1: under `buffer`/`buffer_length` the engine reads ptr + byteLength
  // off the SAME view, so every `(ptr,len)` pair passes the view itself for the
  // length slot (atomic snapshot, one JS arg fewer); under `(ptr,usize)` it's
  // the explicit length. The branch is a bind-time constant → JIT folds it.
  const lenOrView = (v: Uint8Array): Uint8Array | number => (useBufferLength ? v : v.length)
  const hmacVerify = sym.castrum_hmac_sha256_verify as Raw6
  const csrfVerify = sym.castrum_csrf_verify as Raw4
  const passwordVerify = sym.castrum_password_verify as Raw4
  const passwordVerifyBcrypt = sym.castrum_password_verify_bcrypt as Raw3
  const wsAcceptKey = sym.castrum_ws_accept_key as RawCStr
  const wsAcceptKeyInto = sym.castrum_ws_accept_key_into as Raw4
  const etagCStr = sym.castrum_etag as RawCStr
  const etagIntoRaw = sym.castrum_etag_into as Raw5
  const conditionalIsNotModifiedRaw = sym.castrum_conditional_is_not_modified as Raw6
  const mediaTypeMatcherMatchesRaw = sym.castrum_media_type_matcher_matches as Raw3
  const acceptNegotiatorNegotiateRaw = sym.castrum_accept_negotiator_negotiate as RawCStr
  const jwtSignerSignRaw = sym.castrum_jwt_signer_sign as Raw6
  const jwtSignerVerifyRaw = sym.castrum_jwt_signer_verify as Raw6
  const templateRenderRaw = sym.castrum_template_render as Raw5
  const schemaValidatorValidateRaw = sym.castrum_schema_validator_validate as Raw3
  const rateLimiterCheckRaw = sym.castrum_rate_limiter_check as Raw5
  const rateLimiterCheckKeyRaw = sym.castrum_rate_limiter_check_key as Raw5
  const randomToken = sym.castrum_random_token as RawCStr
  const randomTokenInto = sym.castrum_random_token_into as Raw3
  const base64Encode = sym.castrum_base64_encode as Raw6
  const base64Decode = sym.castrum_base64_decode as Raw6
  const hmacSha256 = sym.castrum_hmac_sha256 as Raw6
  const signCookie = sym.castrum_sign_cookie as RawCStr
  const signCookieInto = sym.castrum_sign_cookie_into as Raw6
  const verifyCookie = sym.castrum_verify_cookie as RawCStr
  const verifyCookieInto = sym.castrum_verify_cookie_into as Raw6
  const csrfToken = sym.castrum_csrf_token as RawCStr
  const csrfTokenInto = sym.castrum_csrf_token_into as Raw4
  const passwordHash = sym.castrum_password_hash as Raw10
  const passwordHashBcrypt = sym.castrum_password_hash_bcrypt as Raw5
  const pbkdf2 = sym.castrum_pbkdf2_sha256 as Raw8
  const aeadEncrypt = sym.castrum_aead_encrypt as Raw9
  const aeadDecrypt = sym.castrum_aead_decrypt as Raw9
  const wsFrameEncode = sym.castrum_ws_frame_encode as Raw7
  const jsonPatch = sym.castrum_json_patch as Raw6
  const gzipCompress = sym.castrum_gzip_compress as Raw5
  const gzipDecompress = sym.castrum_gzip_decompress as Raw5
  const brotliCompress = sym.castrum_brotli_compress as Raw5
  const brotliDecompress = sym.castrum_brotli_decompress as Raw5
  const gzipIsize = sym.castrum_gzip_isize as Raw2
  const httpParsePacked = sym.castrum_http_parse_request_packed as Raw4
  const queryParsePacked = sym.castrum_query_parse_packed as Raw4
  const cookieParsePacked = sym.castrum_cookie_parse_packed as Raw4
  const httpDateIntoRaw = sym.castrum_http_date_into as Raw3
  const sseEncodeIntoRaw = sym.castrum_sse_encode_into as Raw10
  const jwtSignBytes = sym.castrum_jwt_sign_bytes as RawCStr
  const jsonParsePackedSym = sym.castrum_json_parse_packed as Raw4
  const jwtSignBytesInto = sym.castrum_jwt_sign_bytes_into as Raw8
  const wsFrameDecodePacked = sym.castrum_ws_frame_decode_packed as Raw4
  const multipartParsePacked = sym.castrum_multipart_parse_packed as Raw6
  const formParsePacked = sym.castrum_form_parse_packed as Raw4
  // Phase 3 — stateless napi-only scalars.
  const parseMediaTypeSym = sym.castrum_parse_media_type as Raw4
  const parseHttpDateSym = sym.castrum_parse_http_date as Raw4
  const parseAcceptEncodingSym = sym.castrum_parse_accept_encoding as Raw4
  const urlEncodeQuerySym = sym.castrum_url_encode_query as (...a: unknown[]) => string | null
  const urlResolveSym = sym.castrum_url_resolve as (...a: unknown[]) => string | null
  const urlBuilderResolveRaw = sym.castrum_url_builder_resolve as Raw5
  const mimeFromExtensionSym = sym.castrum_mime_from_extension as (...a: unknown[]) => string | null
  const jwtVerifySym = sym.castrum_jwt_verify as (...a: unknown[]) => string | null
  const ingressHandlePacked = sym.castrum_ingress_handle_packed as Raw7
  const ingressHandleComponentsSym = sym.castrum_ingress_handle_components as Raw12
  const ingressLayoutSym = sym.castrum_ingress_layout as Raw2
  const routeCompileSym = sym.castrum_route_compile as Raw2
  const routeRunSym = sym.castrum_route_run as Raw5
  const routeDestroySym = sym.castrum_route_destroy as (a: unknown) => void

  // ── Encoder / decoder `Into` helpers ──────────────────────────────
  const hexEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    // Mirror napi error semantics: a too-small buffer throws, not returns 0.
    // Hex encode always writes exactly `input.length * 2` bytes on success.
    if (output.length < input.length * 2) {
      throw new Error('hex encode: output buffer too small')
    }
    return Number(hexEncode(input, lenOrView(input), output, lenOrView(output)))
  }

  const urlEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlEncode(input, lenOrView(input), output, lenOrView(output)))
    // Every input byte encodes to >= 1 output byte, so a 0 write on non-empty
    // input means the buffer was too small (napi throws there too). Empty
    // input legitimately writes 0.
    if (w === 0 && input.length !== 0) {
      throw new Error('url encode: output buffer too small')
    }
    return w
  }

  const hexDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(hexDecode(input, lenOrView(input), output, lenOrView(output)))
    return writeOrThrow(w, input.length, 'hex decode')
  }

  const urlDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlDecode(input, lenOrView(input), output, lenOrView(output)))
    return writeOrThrow(w, input.length, 'url decode')
  }

  const base64DecodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true (rust/crypto/base64.rs).
    const w = Number(
      base64Decode(
        input,
        lenOrView(input),
        output,
        lenOrView(output),
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    return writeOrThrow(w, input.length, 'base64 decode')
  }

  const base64EncodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true.
    const w = Number(
      base64Encode(
        input,
        lenOrView(input),
        output,
        lenOrView(output),
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    // Empty input legitimately writes 0 bytes — only a 0 write on NON-empty
    // input is a real error (same convention as the decode/etag paths).
    return writeOrThrow(w, input.length, 'base64 encode')
  }

  // cstring-return (the engine clones the NUL-terminated string at call time)
  // → the JS string directly (native transfer — zero encode); a `null` return
  // is the C failure sentinel → throw.
  const cstr = (s: string | null, label: string): string => {
    if (s === null) throw new Error(label)
    return s
  }

  const etagInto = (data: Uint8Array, output: Uint8Array, weak?: boolean): number => {
    // Native pooled `_into`: writes 10/12 bytes directly into the caller
    // buffer (no cstring round-trip). Needed-size convention: a write larger
    // than `output.length` reports the exact required size → throw.
    const w = Number(etagIntoRaw(data, lenOrView(data), flag(weak), output, lenOrView(output)))
    if (w === 0) {
      throw new Error('etag: invalid input')
    }
    if (w > output.length) {
      throw new Error('etag: output buffer too small')
    }
    return w
  }

  // Pooled 9-byte scratch for jsonSumIds (the packed `[u8 ok][i64 sum LE]`
  // output). The wrapper returns the BigInt VALUE (no byte aliasing escapes),
  // so a single reused buffer + cached DataView is safe — removes the per-call
  // Uint8Array + DataView allocs (measured ~400ns of the FFI wrapper cost).
  const jsonSumOut = new Uint8Array(9)
  const jsonSumView = new DataView(jsonSumOut.buffer)

  // ── Reusable scratch for the STRING-returning encode wrappers ────────
  // Each wrapper writes its result and decodes it into an immutable JS string
  // (or primitive) SYNCHRONOUSLY before the next call reuses the buffer — the
  // same safety rationale as `jsonSumOut` / `generateRequestId`. Per-Worker
  // module state (single-threaded event loop); never shared across Workers.
  // NOT used for byte-returning ops (hexDecode/urlDecode/base64Decode/aead/
  // wsFrame/packed parsers): their returned `Uint8Array` aliases the buffer
  // and escapes to the caller — those stay on `*Into` (caller-owned).
  let encodeScratch = new Uint8Array(0)
  const scratchFor = (size: number): Uint8Array => {
    if (encodeScratch.byteLength < size) encodeScratch = new Uint8Array(size)
    return encodeScratch
  }
  // Fixed-size packed-verdict scratch + cached DataViews (parseHttpDate 9 B,
  // rate-limit check 13 B) — same pooled pattern as `jsonSumView`. Kept
  // separate from the growable `encodeScratch` so the cached DataViews are
  // never invalidated by a buffer replacement.
  const dateScratch = new Uint8Array(9)
  const dateScratchView = new DataView(dateScratch.buffer)
  const rateScratch = new Uint8Array(13)
  const rateScratchView = new DataView(rateScratch.buffer)

  return {
    crc32: (input) => Number(oneArg(crc32, input)) >>> 0,
    fnv1a64: (input) => BigInt(oneArg(fnv, input)),
    xxh3: (input) => BigInt(oneArg(xxh, input)),
    jsonValid: (input) => Number(oneArg(jsonValid, input)) === 1,
    utf8Valid: (input) => Number(oneArg(utf8Valid, input)) === 1,
    hexEncode(input) {
      // Pooled scratch — decoded synchronously to an immutable string (safe;
      // removes the per-call `new Uint8Array(len*2)`). ALWAYS decode the
      // written subarray: the shared scratch may be larger than `w` (grown by
      // an earlier op), so decoding the whole buffer would read stale bytes.
      const out = scratchFor(input.length * 2)
      const w = hexEncodeInto(input, out)
      return decodeUtf8(out.subarray(0, w))
    },
    hexEncodeInto,
    urlEncode(input) {
      // RFC 3986 worst case is 3 bytes per input byte (`%XX`). Pooled scratch
      // (decoded synchronously — safe).
      const out = scratchFor(input.length * 3)
      const w = urlEncodeInto(input, out)
      return decodeUtf8(out.subarray(0, w))
    },
    urlEncodeInto,

    validateEmail: (input) => Number(validateEmail(input)) === 1,
    validateUuid: (input) => Number(validateUuid(input)) === 1,
    validateIpv4: (input) => Number(validateIpv4(input)) === 1,
    validateIpv6: (input) => Number(validateIpv6(input)) === 1,
    jsonSumIds: (input) => {
      // Packed [u8 ok][i64 sum LE] output (9 B): ok=1 → valid array (the sum
      // may be 0); ok=0 → invalid input. Bytes written: 9/1/0 (0 = real error).
      const w = Number(jsonSumRaw(input, lenOrView(input), jsonSumOut, lenOrView(jsonSumOut)))
      if (w === 0) {
        throw new Error('json sum ids: output buffer too small')
      }
      if (jsonSumOut[0] === 0) {
        // Mirrors the napi error phrasing (serde: "expected an array of objects
        // with numeric ids") so both transports throw the same message.
        throw new Error('json sum ids: expected an array of objects with numeric ids')
      }
      return jsonSumView.getBigInt64(1, true)
    },
    hmacSha256Verify: (key, data, signature) =>
      Number(
        hmacVerify(key, lenOrView(key), data, lenOrView(data), signature, lenOrView(signature)),
      ) === 1,
    csrfVerify: (token, secret) =>
      Number(csrfVerify(token, lenOrView(token), secret, lenOrView(secret))) === 1,
    passwordVerify: (password, phc) =>
      Number(passwordVerify(password, lenOrView(password), phc, lenOrView(phc))) === 1,
    passwordVerifyBcrypt: (password, phc) =>
      Number(passwordVerifyBcrypt(password, lenOrView(password), phc)) === 1,

    hexDecode(input) {
      const out = new Uint8Array(Math.floor(input.length / 2))
      const w = hexDecodeInto(input, out)
      return out.subarray(0, w)
    },
    hexDecodeInto,
    urlDecode(input) {
      const out = new Uint8Array(input.length)
      const w = urlDecodeInto(input, out)
      return out.subarray(0, w)
    },
    urlDecodeInto,
    base64Decode(input, urlSafe, padding) {
      const out = new Uint8Array(Math.ceil((input.length * 3) / 4))
      const w = base64DecodeInto(input, out, urlSafe, padding)
      return out.subarray(0, w)
    },
    base64DecodeInto,

    wsAcceptKey(key) {
      return cstr(wsAcceptKey(key), 'ws accept key: bad key')
    },
    wsAcceptKeyInto(key, output) {
      // Native pooled `_into`: writes the 28-byte accept key directly into the
      // caller buffer (no cstring round-trip). Needed-size convention.
      const w = Number(wsAcceptKeyInto(key, lenOrView(key), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('ws accept key: bad key')
      }
      if (w > output.length) {
        throw new Error('ws accept key: output buffer too small')
      }
      return w
    },
    etag(data, weak) {
      // cstring return (10 strong / 12 weak chars) — zero encode.
      return cstr(etagCStr(data, lenOrView(data), flag(weak)), 'etag: invalid input')
    },
    etagInto,
    conditionalIsNotModified(inner, ifNoneMatch, ifModifiedSince) {
      // Opaque-handle eval of the precompiled `ConditionalRequest` state.
      // flags bit0 = If-None-Match present, bit1 = If-Modified-Since present
      // (present-but-empty is distinct from absent — napi Option parity). A
      // null handle (0) → 0 (never dereferences freed state).
      const flags = (ifNoneMatch === null ? 0 : 1) | (ifModifiedSince === null ? 0 : 2)
      const inm = ifNoneMatch ?? EMPTY_VIEW
      const ims = ifModifiedSince ?? EMPTY_VIEW
      return (
        Number(
          conditionalIsNotModifiedRaw(inner, inm, lenOrView(inm), ims, lenOrView(ims), flags),
        ) === 1
      )
    },
    mediaTypeMatcherMatches(inner, actual) {
      // Precompiled expected-type match → u8.
      return Number(mediaTypeMatcherMatchesRaw(inner, actual, lenOrView(actual))) === 1
    },
    acceptNegotiatorNegotiate(inner, header) {
      // cstring best-supported encoding; `null` = identity (napi Option parity).
      return acceptNegotiatorNegotiateRaw(inner, header, lenOrView(header))
    },
    jwtSignerSign(inner, claimsJson, nowSeconds) {
      // Precompiled key + ttl → compact token. 0 = invalid claims JSON (real
      // error → growExact throws); w > output.length = exact needed size.
      return growExact(
        (out) =>
          Number(
            jwtSignerSignRaw(
              inner,
              claimsJson,
              lenOrView(claimsJson),
              BigInt(nowSeconds),
              out,
              lenOrView(out),
            ),
          ),
        Math.min(claimsJson.length + 128, 64 * 1024),
        1024 * 1024,
        'jwt signer: invalid claims JSON or output buffer too small',
      )
    },
    jwtSignerVerify(inner, token, nowSeconds) {
      // Precompiled key → claims JSON bytes; 0 = invalid / expired → null.
      const out = new Uint8Array(Math.min(token.length + 256, 64 * 1024))
      const w = Number(
        jwtSignerVerifyRaw(inner, token, lenOrView(token), BigInt(nowSeconds), out, lenOrView(out)),
      )
      if (w === 0) return null
      if (w > out.length) {
        const out2 = new Uint8Array(w)
        const w2 = Number(
          jwtSignerVerifyRaw(
            inner,
            token,
            lenOrView(token),
            BigInt(nowSeconds),
            out2,
            lenOrView(out2),
          ),
        )
        return w2 === 0 ? null : out2.subarray(0, w2)
      }
      return out.subarray(0, w)
    },
    templateRender(inner, contextJson) {
      // Compiled template + pre-serialized JSON context → UTF-8 bytes. 0 =
      // invalid context / render error (real error → growExact throws).
      return growExact(
        (out) =>
          Number(
            templateRenderRaw(inner, contextJson, lenOrView(contextJson), out, lenOrView(out)),
          ),
        Math.min(contextJson.length + 128, 64 * 1024),
        1024 * 1024,
        'template render: invalid context JSON or render failed',
      )
    },
    schemaValidatorValidate(inner, doc) {
      return Number(schemaValidatorValidateRaw(inner, doc, lenOrView(doc))) === 1
    },
    rateLimiterCheck(inner, key, nowMs) {
      // Packed [u8 allowed][u32 remaining LE][i64 reset_ms LE] (13 bytes).
      // Reused scratch + cached DataView (no per-call allocs). `key` is a
      // `cstring` ARG (the engine transcodes the JS string in-engine).
      const out = rateScratch
      const w = Number(
        rateLimiterCheckRaw(inner, key, BigInt(Math.trunc(nowMs)), out, lenOrView(out)),
      )
      if (w === 0) throw new Error('rate limiter check: null handle')
      return unpackRateCheck(out, rateScratchView)
    },
    rateLimiterCheckKey(inner, key, nowMs) {
      // Packed [u8 allowed][u32 remaining LE][i64 reset_ms LE] (13 bytes).
      // Reused scratch + cached DataView (no per-call allocs).
      const out = rateScratch
      const w = Number(
        rateLimiterCheckKeyRaw(inner, BigInt(key), BigInt(Math.trunc(nowMs)), out, lenOrView(out)),
      )
      if (w === 0) throw new Error('rate limiter check: null handle')
      return unpackRateCheck(out, rateScratchView)
    },
    randomToken(byteLen) {
      // cstring return of `byteLen*2` hex chars; byteLen 0 → empty string → empty
      // Uint8Array (napi returns empty too). null = random source failed / >16MiB.
      return cstr(
        randomToken(byteLen),
        'random token: output buffer too small or random source failed',
      )
    },
    randomTokenInto(byteLen, output) {
      // Pooled sibling: native writes `byteLen*2` hex chars directly into the
      // caller buffer (no cstring round-trip). Needed-size convention: a write
      // larger than `output.length` reports the exact required size → throw
      // (the caller owns the buffer); 0 = real error (cap / RNG).
      const w = Number(randomTokenInto(byteLen, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('random token: random source failed or byteLen exceeds 16 MiB')
      }
      if (w > output.length) {
        throw new Error('random token: output buffer too small')
      }
      return w
    },
    base64Encode(input, urlSafe, padding) {
      // Pooled scratch — decoded synchronously to an immutable string (safe).
      const out = scratchFor(Math.ceil(input.length / 3) * 4)
      const w = base64EncodeInto(input, out, urlSafe, padding)
      return decodeUtf8(out.subarray(0, w))
    },
    base64EncodeInto,
    hmacSha256(key, data) {
      // Pooled 64-byte scratch — decoded synchronously (safe).
      const out = scratchFor(64)
      const w = Number(hmacSha256(key, lenOrView(key), data, lenOrView(data), out, lenOrView(out)))
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return decodeUtf8(out.subarray(0, w))
    },
    hmacSha256Into(key, data, output) {
      if (output.length < 64) {
        throw new Error('hmac sha256: output buffer too small')
      }
      const w = Number(
        hmacSha256(key, lenOrView(key), data, lenOrView(data), output, lenOrView(output)),
      )
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return w
    },
    signCookie(value, secret) {
      // `value.<64-hex>` returned as a cstring (value.length + 1 + 64 chars).
      return cstr(
        signCookie(value, lenOrView(value), secret, lenOrView(secret)),
        'sign cookie: invalid input',
      )
    },
    signCookieInto(value, secret, output) {
      // Native pooled `_into`: writes `value.<64-hex>` directly into the caller
      // buffer (no cstring round-trip — this is why pooled sign_cookie was
      // previously a REGRESSION vs allocating). Needed-size convention.
      const w = Number(
        signCookieInto(
          value,
          lenOrView(value),
          secret,
          lenOrView(secret),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('sign cookie: invalid input')
      }
      if (w > output.length) {
        throw new Error('sign cookie: output buffer too small')
      }
      return w
    },
    verifyCookie(signed, secret) {
      // cstring return; `null` = invalid signature / malformed → null (napi parity).
      // CAVEAT (refactor): the engine clones a UTF-8 string, so a cookie VALUE
      // containing non-UTF-8 bytes or NUL cannot round-trip byte-faithfully on
      // the FFI path (napi still does). Signed values are ASCII in practice.
      const s = verifyCookie(signed, lenOrView(signed), secret, lenOrView(secret))
      return s === null ? null : s
    },
    verifyCookieInto(signed, secret, output) {
      // Native pooled `_into`: writes the verified value directly into the
      // caller buffer. 0 = invalid signature / malformed → null (napi parity,
      // like the allocating `verifyCookie`); a write larger than `output.length`
      // reports the exact required size → throw.
      const w = Number(
        verifyCookieInto(
          signed,
          lenOrView(signed),
          secret,
          lenOrView(secret),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        return null
      }
      if (w > output.length) {
        throw new Error('verify cookie: output buffer too small')
      }
      return w
    },
    csrfToken(secret) {
      // 129-char `hex.hex` cstring return.
      return cstr(
        csrfToken(secret, lenOrView(secret)),
        'csrf token: output buffer too small or random source failed',
      )
    },
    csrfTokenInto(secret, output) {
      // Native pooled `_into`: writes the 129-char `hex.hex` token directly
      // into the caller buffer (no cstring round-trip). Needed-size convention.
      const w = Number(csrfTokenInto(secret, lenOrView(secret), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('csrf token: random source failed')
      }
      if (w > output.length) {
        throw new Error('csrf token: output buffer too small')
      }
      return w
    },
    passwordHash(password, salt, mCost, tCost, pCost, outLen) {
      // Pre-size with the EXACT PHC string length (computable from the params),
      // so the hash runs once — a grow-retry would re-run the whole argon2
      // hash on a miss. growExact remains the safety net.
      return decodeUtf8(
        growExact(
          (out) =>
            Number(
              passwordHash(
                password,
                lenOrView(password),
                salt,
                lenOrView(salt),
                mCost,
                tCost,
                pCost,
                outLen,
                out,
                lenOrView(out),
              ),
            ),
          argon2PhcLength(mCost, tCost, pCost, salt.length, outLen),
          2 * 1024 * 1024,
          'password hash: output buffer too small',
        ),
      )
    },
    passwordHashBcrypt(password, cost) {
      // `$2b$CC$` + 22 salt chars + 31 hash chars = 60 chars.
      const out = new Uint8Array(64)
      const w = Number(passwordHashBcrypt(password, lenOrView(password), cost, out, lenOrView(out)))
      if (w === 0) {
        throw new Error('password hash bcrypt: output buffer too small')
      }
      return decodeUtf8(out.subarray(0, w))
    },
    pbkdf2Sha256(password, salt, rounds, dkLen) {
      // Rust clamps dkLen to [1, 1MiB] (PBKDF2_MIN_LEN/MAX_LEN) AFTER sizing its
      // own buffer — so pre-clamp here so dkLen 0 still yields a 1-byte result.
      const dk = Math.min(Math.max(dkLen, 1), 1024 * 1024)
      const out = new Uint8Array(dk)
      const w = Number(
        pbkdf2(
          password,
          lenOrView(password),
          salt,
          lenOrView(salt),
          rounds,
          dkLen,
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('pbkdf2: output buffer too small')
      }
      return out.subarray(0, w)
    },
    aeadEncrypt(key, nonce, plaintext, algorithm = 0) {
      // ciphertext + 16-byte auth tag.
      const out = new Uint8Array(plaintext.length + 16)
      const w = Number(
        aeadEncrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          plaintext,
          lenOrView(plaintext),
          algorithm,
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return out.subarray(0, w)
    },
    aeadEncryptInto(key, nonce, plaintext, output, algorithm = 0) {
      const need = plaintext.length + 16
      if (output.length < need) {
        throw new Error('aead encrypt: output buffer too small')
      }
      const w = Number(
        aeadEncrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          plaintext,
          lenOrView(plaintext),
          algorithm,
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return w
    },
    aeadDecrypt(key, nonce, ciphertext, algorithm = 0) {
      const out = new Uint8Array(ciphertext.length)
      const w = Number(
        aeadDecrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          ciphertext,
          lenOrView(ciphertext),
          algorithm,
          out,
          lenOrView(out),
        ),
      )
      return w === 0 ? null : out.subarray(0, w)
    },

    wsFrameEncode(opcode, payload, mask, fin) {
      // Header (max 10) + payload + mask key (4).
      const out = new Uint8Array(payload.length + 14)
      const w = Number(
        wsFrameEncode(
          opcode,
          payload,
          lenOrView(payload),
          flag(mask),
          flag(fin),
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return out.subarray(0, w)
    },
    wsFrameEncodeInto(opcode, payload, mask, fin, output) {
      // Header (max 10) + payload + mask key (4).
      const need = payload.length + 14
      if (output.length < need) {
        throw new Error('ws frame encode: output buffer too small')
      }
      const w = Number(
        wsFrameEncode(
          opcode,
          payload,
          lenOrView(payload),
          flag(mask),
          flag(fin),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return w
    },
    jsonPatch(doc, patch) {
      return decodeUtf8(
        growExact(
          (out) =>
            Number(jsonPatch(doc, lenOrView(doc), patch, lenOrView(patch), out, lenOrView(out))),
          Math.min(Math.max(doc.length, patch.length) + 16, 64 * 1024),
          MAX_JSON_PATCH_OUTPUT,
          'json patch: output buffer too small or patch inapplicable',
        ),
      )
    },
    gzipCompress(data, level = 6) {
      // The C ABI streams the compressed output directly into `out` (no internal
      // Vec — see rust/payload/compress.rs gzip_compress_into). Cap the initial
      // so large compressible inputs don't pay a full-size allocation (measured:
      // a 75 KiB input compressed to <1 KiB — COMPRESS_INITIAL_CAP is plenty and
      // single-pass). growExact handles incompressible data with at most one
      // exact retry (no re-run loop).
      return growExact(
        (out) =>
          Number(gzipCompress(data, lenOrView(data), Math.min(level, 9), out, lenOrView(out))),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'gzip compress: output buffer too small',
      )
    },
    gzipCompressInto(data, output, level = 6) {
      const w = Number(
        gzipCompress(data, lenOrView(data), Math.min(level, 9), output, lenOrView(output)),
      )
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('gzip compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('gzip compress: output buffer too small')
      }
      return w
    },
    gzipDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Pre-size from the gzip ISIZE trailer via the C probe (exact for
      // single-member streams) so the happy path is a single native pass; fall
      // back to a multiplier guess. growExact handles any residual miss with
      // one exact retry, and invalid input throws immediately (no 64 MiB
      // grow-to-max allocation storm).
      const isize = Number(gzipIsize(data, lenOrView(data)))
      const initial =
        isize !== 0
          ? Math.min(isize, max)
          : Math.min(data.length * DECOMPRESS_GUESS_MULTIPLIER_GZIP, DECOMPRESS_FALLBACK_CAP)
      return growExact(
        (out) => Number(gzipDecompress(data, lenOrView(data), max, out, lenOrView(out))),
        initial,
        max,
        'gzip decompress: invalid stream or exceeded max decompressed size',
      )
    },
    gzipDecompressInto(data, output, maxDecompressed) {
      // Pooled sibling — the C ABI streams the decompressed output directly
      // into the caller buffer via the `_into` core (no internal Vec), keeping
      // the 64 MiB decompression-bomb cap. Needed-size convention: w === 0 =
      // real error (invalid stream / cap exceeded); w > output.length = exact
      // required size → throw (nothing to grow — the caller owns the buffer).
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      const w = Number(gzipDecompress(data, lenOrView(data), max, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('gzip decompress: invalid stream or exceeded max decompressed size')
      }
      if (w > output.length) {
        throw new Error('gzip decompress: output buffer too small')
      }
      return w
    },
    brotliCompress(data, quality = 5) {
      // Same cap rationale as gzipCompress (streaming core); growExact for
      // incompressible data.
      return growExact(
        (out) =>
          Number(brotliCompress(data, lenOrView(data), Math.min(quality, 11), out, lenOrView(out))),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'brotli compress: output buffer too small',
      )
    },
    brotliCompressInto(data, output, quality = 5) {
      const w = Number(
        brotliCompress(data, lenOrView(data), Math.min(quality, 11), output, lenOrView(output)),
      )
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('brotli compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('brotli compress: output buffer too small')
      }
      return w
    },
    brotliDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Brotli has no cheap trailer size: DECOMPRESS_GUESS_MULTIPLIER_BROTLI×
      // initial covers typical JSON/text ratios (~10-30x) while the fallback
      // cap bounds over-allocation on large streams; growExact handles
      // higher-ratio streams with one exact retry.
      return growExact(
        (out) => Number(brotliDecompress(data, lenOrView(data), max, out, lenOrView(out))),
        Math.min(
          Math.max(data.length * DECOMPRESS_GUESS_MULTIPLIER_BROTLI, DECOMPRESS_MIN_INITIAL),
          DECOMPRESS_FALLBACK_CAP,
        ),
        max,
        'brotli decompress: invalid stream or exceeded max decompressed size',
      )
    },
    brotliDecompressInto(data, output, maxDecompressed) {
      // Pooled sibling — streams into the caller buffer, keeps the 64 MiB cap
      // (same convention as gzipDecompressInto above).
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      const w = Number(brotliDecompress(data, lenOrView(data), max, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('brotli decompress: invalid stream or exceeded max decompressed size')
      }
      if (w > output.length) {
        throw new Error('brotli decompress: output buffer too small')
      }
      return w
    },

    httpParseRequestPackedInto(input, output) {
      const w = Number(httpParsePacked(input, lenOrView(input), output, lenOrView(output)))
      if (w === 0 && input.length !== 0) {
        throw new Error('http parse: output buffer too small or malformed request')
      }
      return w
    },
    queryParsePackedInto(input, output) {
      const w = Number(queryParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention: w > output.length = exact required size →
      // too-small (throw — the caller owns the buffer, nothing to grow);
      // w === 0 = real error (malformed %XX).
      if (w === 0 || w > output.length) {
        throw new Error('query parse: output buffer too small')
      }
      return w
    },
    cookieParsePackedInto(input, output) {
      const w = Number(cookieParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention (same as queryParsePackedInto).
      if (w === 0 || w > output.length) {
        throw new Error('cookie parse: output buffer too small')
      }
      return w
    },

    // ── Excluded-surface additions ──────────────────────────────────
    jwtSignBytes(claimsJson, secret, ttl, now) {
      // Compact HS256 token returned as a cstring (engine-cloned) — the Rust
      // side builds the whole token and the JS pays zero decode. ttl<=0 = no
      // iat/exp (napi Option<i64> sentinel). i64 args must be BigInt.
      return cstr(
        jwtSignBytes(
          claimsJson,
          lenOrView(claimsJson),
          secret,
          lenOrView(secret),
          BigInt(ttl),
          BigInt(now),
        ),
        'jwt sign: invalid claims JSON',
      )
    },
    jwtSignBytesInto(claimsJson, secret, ttl, now, output) {
      // Native pooled `_into`: writes the compact token directly into the
      // caller buffer (no cstring round-trip). Needed-size convention: a write
      // larger than `output.length` reports the exact required size → throw;
      // 0 = invalid claims JSON.
      const w = Number(
        jwtSignBytesInto(
          claimsJson,
          lenOrView(claimsJson),
          secret,
          lenOrView(secret),
          BigInt(ttl),
          BigInt(now),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('jwt sign: invalid claims JSON')
      }
      if (w > output.length) {
        throw new Error('jwt sign: output buffer too small')
      }
      return w
    },
    wsFrameDecodePacked(data) {
      // Max packed output = 6-byte header + payload.
      const out = new Uint8Array(data.length + 6)
      const w = Number(wsFrameDecodePacked(data, lenOrView(data), out, lenOrView(out)))
      return w === 0 ? null : out.subarray(0, w)
    },
    wsFrameDecodePackedInto(data, output) {
      // Pooled sibling: the caller provides the output buffer, sized to at
      // least `data.length + 6` (6-byte header + payload — the Rust core
      // returns 0 for BOTH too-small and malformed, so the caller must size
      // to the max; the allocating path always does). 0 = malformed → null,
      // mirroring the allocating path's return contract.
      const w = Number(wsFrameDecodePacked(data, lenOrView(data), output, lenOrView(output)))
      return w === 0 ? null : w
    },
    multipartParsePacked(body, boundary) {
      return growExact(
        (out) =>
          Number(
            multipartParsePacked(
              body,
              lenOrView(body),
              boundary,
              lenOrView(boundary),
              out,
              lenOrView(out),
            ),
          ),
        Math.min(body.length + boundary.length + 64, 64 * 1024),
        128 * 1024 * 1024,
        'multipart parse: output buffer too small',
      )
    },
    multipartParsePackedInto(body, boundary, output) {
      // Pooled sibling: the caller provides the output buffer. Needed-size
      // convention (same as queryParsePackedInto): w > output.length = exact
      // required size → throw; w === 0 = real error (malformed).
      const w = Number(
        multipartParsePacked(
          body,
          lenOrView(body),
          boundary,
          lenOrView(boundary),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0 || w > output.length) {
        throw new Error('multipart parse: output buffer too small or malformed body')
      }
      return w
    },
    formParsePackedInto(input, output) {
      const w = Number(formParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention (form aliases the query core — same convention).
      if (w === 0 || w > output.length) {
        throw new Error('form parse: output buffer too small')
      }
      return w
    },

    // ── Wired WIP surface (JWT verify, task group) ──
    jsonParsePacked(input) {
      // Packed token stream (deduped string table + typed value tree) — the
      // scalar wrapper assembles the JS value from the tokens with NO second
      // JSON text parse. `0` = invalid JSON (real error → growExact throws);
      // `w > out.length` = exact required size (one exact retry).
      return growExact(
        (out) => Number(jsonParsePackedSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + (input.length >> 1), 16 * 1024 * 1024),
        Math.max(1024 * 1024, input.length * 16),
        'json parse packed: invalid JSON or output buffer too small',
      )
    },
    parseMediaType(input) {
      // Packed verdict: [u32 mediaTypeLen][mediaType][u32 charsetLen
      // (0xFFFFFFFF = none)][charset][u32 boundaryLen][boundary]
      // [u32 paramCount]{[u32 keyLen][key][u32 valLen][val]}. 0 = invalid media
      // type (real error → growExact throws); w > output.length = exact needed
      // size (one exact retry).
      return growExact(
        (out) => Number(parseMediaTypeSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + 64, 64 * 1024),
        1024 * 1024,
        'media type parse: invalid media type or output buffer too small',
      )
    },
    parseHttpDate(input) {
      // Packed [u8 ok][i64 secs LE] (9 B) / 1 B (ok=0). A too-small buffer is
      // never a 0 here — the Rust side reports the exact size (9/1) — so a 9-byte
      // buffer always succeeds. Reused scratch + cached DataView (no per-call
      // allocs).
      const out = dateScratch
      const w = Number(parseHttpDateSym(input, lenOrView(input), out, lenOrView(out)))
      if (w === 0) {
        throw new Error('http date parse: output buffer too small')
      }
      if (out[0] === 0) return null
      return dateScratchView.getBigInt64(1, true)
    },
    parseAcceptEncoding(input) {
      // Packed: [u32 count]{[u32 encLen][enc][f32 q][u32 order]} (empty header →
      // count 0, 4 bytes). 0 = too small (real error → growExact throws).
      return growExact(
        (out) => Number(parseAcceptEncodingSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + 64, 64 * 1024),
        1024 * 1024,
        'accept encoding parse: output buffer too small',
      )
    },
    urlEncodeQuery(input) {
      // Packed pairs `[u32 count]{[u32 keyLen][key][u32 valLen][val]}` (the JS
      // `packPairs` layout) → percent-encoded query TEXT as a cstring, keys
      // SORTED (matches the napi BTreeMap ordering). `null` = malformed packed
      // input / non-UTF-8 (napi parity: throws).
      return urlEncodeQuerySym(input, lenOrView(input))
    },
    urlResolve(base, reference) {
      // RFC 3986 resolution → cstring; `null` = non-UTF-8 input (napi parity).
      return urlResolveSym(base, lenOrView(base), reference, lenOrView(reference))
    },
    urlBuilderResolve(inner, reference) {
      // Opaque-handle resolve against a `UrlBuilder`'s PRECOMPILED base. 0 =
      // null handle / non-UTF-8 reference (real error → growExact throws);
      // w > output.length = exact needed size (one exact retry).
      return growExact(
        (out) =>
          Number(urlBuilderResolveRaw(inner, reference, lenOrView(reference), out, lenOrView(out))),
        Math.min(reference.length * 2 + 128, 64 * 1024),
        1024 * 1024,
        'url builder resolve: invalid reference or output buffer too small',
      )
    },
    mimeFromExtension(ext) {
      // Extension → MIME → cstring (cstring ARG: the engine transcodes the JS
      // extension in-engine); unknown → `application/octet-stream` (never null).
      return mimeFromExtensionSym(ext)
    },
    jwtVerify(token, secret, nowSeconds) {
      // Verify an HS256 JWT → claims as a JSON cstring; `null` = invalid
      // signature / expired / malformed (napi Option parity). `now` is an i64
      // C arg → must be passed as BigInt.
      return jwtVerifySym(token, lenOrView(token), secret, lenOrView(secret), BigInt(nowSeconds))
    },

    // ── Napi-only hot ops, now FFI (kills the napi crossing) ──────
    httpDateInto(secs, output) {
      // 29-byte HTTP-date into the caller buffer. 0 = too-small buffer or
      // out-of-range year (napi httpDateInto throws on both).
      const w = Number(httpDateIntoRaw(secs, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('http date: output buffer too small or year out of range')
      }
      return w
    },
    httpDate(secs) {
      // Allocating sibling — 32-byte buffer always fits the 29-byte date, so
      // the only 0 case is an out-of-range year (napi falls back to the
      // allocating format! there — mirror with Date.toUTCString). Pooled
      // scratch (decoded synchronously — safe).
      const out = scratchFor(32)
      const w = Number(httpDateIntoRaw(secs ?? 0, out, lenOrView(out)))
      if (w !== 0) return decodeUtf8(out.subarray(0, w))
      return new Date((secs ?? 0) * 1000).toUTCString()
    },
    sseEncodeEvent(event, data, id, retry) {
      // One SSE event → bytes. event/id are encoded to UTF-8 only when
      // non-null (flag bits 1/2/4 = present) so a present-but-empty string is
      // distinct from absent (napi Option parity). growExact with the needed-size
      // convention; `data.length + 64` covers the common single-line case.
      const ev = event === null ? EMPTY_VIEW : encodeUtf8(event)
      const idv = id === null ? EMPTY_VIEW : encodeUtf8(id)
      const flags = (event === null ? 0 : 1) | (id === null ? 0 : 2) | (retry === null ? 0 : 4)
      return growExact(
        (out) =>
          Number(
            sseEncodeIntoRaw(
              ev,
              lenOrView(ev),
              data,
              lenOrView(data),
              idv,
              lenOrView(idv),
              flags,
              retry ?? 0,
              out,
              lenOrView(out),
            ),
          ),
        data.length + 64,
        1 << 20,
        'sse encode: output buffer too small',
      )
    },
    sseEncodeEventInto(event, data, id, retry, output) {
      // Pooled sibling — caller-owned output buffer (sized ≥ `data.length + 64`
      // for the common single-line case). Needed-size convention: w > output.length
      // = exact required size → throw; w === 0 = real error (invalid UTF-8).
      const ev = event === null ? EMPTY_VIEW : encodeUtf8(event)
      const idv = id === null ? EMPTY_VIEW : encodeUtf8(id)
      const flags = (event === null ? 0 : 1) | (id === null ? 0 : 2) | (retry === null ? 0 : 4)
      const w = Number(
        sseEncodeIntoRaw(
          ev,
          lenOrView(ev),
          data,
          lenOrView(data),
          idv,
          lenOrView(idv),
          flags,
          retry ?? 0,
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('sse encode: invalid UTF-8 in event/id')
      }
      if (w > output.length) {
        throw new Error('sse encode: output buffer too small')
      }
      return w
    },

    ingressHandlePacked(inner, input, body, output) {
      const w = Number(
        ingressHandlePacked(
          inner,
          input,
          lenOrView(input),
          body ?? EMPTY_VIEW,
          // Under `buffer_length` the length slot must be a view (the engine
          // reads byteLength off it) — `EMPTY_VIEW` has byteLength 0, matching
          // a null body; under `(ptr,usize)` it's the explicit length 0.
          body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ingress handle: output buffer too small or pipeline error')
      }
      return w
    },
    ingressHandleComponents(inner, methodKind, url, ip, rid, headers, body, output) {
      // `url`/`ip` are passed as JS strings to `cstring` args — the engine
      // transcodes them to call-scoped NUL-terminated UTF-8 buffers in-engine
      // (no JS-side `Buffer.write` encode, no frame assembly for URL/IP).
      const w = Number(
        ingressHandleComponentsSym(
          inner,
          methodKind,
          url,
          ip,
          rid,
          lenOrView(rid),
          headers,
          lenOrView(headers),
          body ?? EMPTY_VIEW,
          body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ingress components: output buffer too small or pipeline error')
      }
      return w
    },
    ingressLayout(out) {
      const w = Number(ingressLayoutSym(out, lenOrView(out)))
      if (w !== out.length) {
        throw new Error('ingress layout: output buffer too small')
      }
      return w
    },

    routeCompile(descriptor) {
      const handle = Number(routeCompileSym(descriptor, lenOrView(descriptor)))
      if (handle === 0) {
        throw new Error('route compile: invalid route descriptor')
      }
      return handle
    },
    routeRun(handle, frame, output) {
      // Needed-size convention: `0` = real error (malformed frame / panic); a
      // write larger than `output.length` is the EXACT required size (caller
      // allocates once and retries) — only a `0` write throws here.
      const w = Number(routeRunSym(handle, frame, lenOrView(frame), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('route run: malformed frame or pipeline error')
      }
      return w
    },
    routeDestroy(handle) {
      routeDestroySym(handle)
    },
  }
}
