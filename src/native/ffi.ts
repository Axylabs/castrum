// src/native/ffi.ts — Bun-only C-ABI fast path via `bun:ffi` (transport core).
//
// Bun JIT-compiles `bun:ffi` calls down to direct native calls (~10-20ns
// crossing), versus ~100-350ns for a Node-API call. The same cdylib that Node
// loads through napi-rs ALSO exports `extern "C"` symbols (`rust/ffi/`), so
// under Bun we can `dlopen` it and call the hot scalar functions directly.
//
// Structure: this file is the transport CORE (transport selection + probe +
// dlopen + symbol binding + bind-time self-test gating). The per-call wrapper
// surface lives in `build.ts` (delegating to `build/{codecs,compress,parse,
// instances}.ts`), and the pure pieces beside it: `ffi/types.ts` (BunFFI /
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
import { resolveEnvVar } from '../shared/env'
import { isBun } from '../shared/runtime'
import { build } from './ffi/build'
import { selfTest } from './ffi/selftest'
import type { BunFFI, FfiMode } from './ffi/types'
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
  const raw = resolveEnvVar('CASTRUM_FFI_MODE')
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
    // rust/ffi/. Every `(ptr,len)` pair is passed as `(view, view.length)`.
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
      // The `_bytes` siblings take a `(ptr,len)` pair — zero transcode when
      // the caller already holds bytes (a cstring arg would force a decode +
      // engine re-encode; docs/FFI_BUN_GUIDE.md §3 shape 4).
      castrum_validate_email: { args: ['cstring'], returns: 'u8' },
      castrum_validate_uuid: { args: ['cstring'], returns: 'u8' },
      castrum_validate_ipv4: { args: ['cstring'], returns: 'u8' },
      castrum_validate_ipv6: { args: ['cstring'], returns: 'u8' },
      castrum_validate_email_bytes: { args: inputAbi, returns: 'u8' },
      castrum_validate_uuid_bytes: { args: inputAbi, returns: 'u8' },
      castrum_validate_ipv4_bytes: { args: inputAbi, returns: 'u8' },
      castrum_validate_ipv6_bytes: { args: inputAbi, returns: 'u8' },
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
      // Server-preference sibling (RFC 7231 server semantics): `header` is a
      // `cstring` ARG — the engine transcodes the JS header string in-engine.
      castrum_accept_negotiator_negotiate_server: {
        args: ['usize', 'cstring'],
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
        // event/id stay `(ptr,len)` byte args. A cstring-ARG conversion was
        // tried (2026-08-23) and reverted: the win was unproven once the
        // codec encode path got faster, and ABI-desync segfaults during the
        // experiment were misread as an engine bug — see docs/FFI_BUN_GUIDE.md
        // §14 before touching this signature.
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
      // ── Ed25519 / EdDSA JWT (RBAC auth) — bound + self-tested; the public
      //    surface is deferred to the auth-module consumer ────────────────
      castrum_ed25519_generate_keypair: {
        args: abi(['ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_ed25519_sign: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_ed25519_verify: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'ptr', 'usize']),
        returns: 'u32',
      },
      castrum_jwt_eddsa_sign: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'i64', 'i64']),
        returns: 'cstring',
      },
      castrum_jwt_eddsa_verify: {
        args: abi(['ptr', 'usize', 'ptr', 'usize', 'i64']),
        returns: 'cstring',
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
      // ── Batch fixed-width hex validation (ObjectId-shaped ids, etc.) ──
      // NEWLINE-separated lines in; one verdict byte (1/0) per line out.
      castrum_hex_validate_batch: {
        args: abi(['ptr', 'usize', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      // ── JS-RegExp metacharacter escaping (needed-size convention) ──
      castrum_regex_escape: { args: abi(['ptr', 'usize', 'ptr', 'usize']), returns: U64_FAST },
      // ── Metrics registry (`castrum_metrics_*`) ──────────────────────
      // Caller-owned handle (route-stack ownership model): create returns a
      // Box<Registry> as usize; declare fns take name/label-keys as cstring
      // ARGS (label keys `\x1f`-separated) and return the u32 series id
      // (0xFFFFFFFF = error); record/set cross the packed label VALUES as a
      // `(ptr,len)` pair + the amount as f64.
      castrum_metrics_create: { args: [], returns: U64_FAST },
      castrum_metrics_counter: { args: ['usize', 'cstring', 'cstring'], returns: 'u32' },
      castrum_metrics_gauge: { args: ['usize', 'cstring', 'cstring'], returns: 'u32' },
      castrum_metrics_histogram: {
        args: ['usize', 'cstring', 'cstring', 'cstring'],
        returns: 'u32',
      },
      castrum_metrics_record: {
        args: abi(['usize', 'u32', 'ptr', 'usize', 'f64']),
        returns: 'u8',
      },
      castrum_metrics_gauge_set: {
        args: abi(['usize', 'u32', 'ptr', 'usize', 'f64']),
        returns: 'u8',
      },
      // Zero-encode siblings: the joined label values cross as ONE `cstring`
      // ARG — the engine transcodes the JS string in-engine (no TextEncoder).
      castrum_metrics_record_str: {
        args: ['usize', 'u32', 'cstring', 'f64'],
        returns: 'u8',
      },
      castrum_metrics_gauge_set_str: {
        args: ['usize', 'u32', 'cstring', 'f64'],
        returns: 'u8',
      },
      // Zero-copy text escape: cstring ARG in, cstring return out — the JS
      // side does zero encode AND zero decode (engine clones at return).
      castrum_regex_escape_str: { args: ['cstring'], returns: 'cstring' },
      // String-input batch hex validation: `ids.join('\n')` crosses as a
      // cstring ARG.
      castrum_hex_validate_batch_str: {
        args: abi(['cstring', 'u32', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_metrics_render: { args: abi(['usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_metrics_snapshot: { args: abi(['usize', 'ptr', 'usize']), returns: U64_FAST },
      castrum_metrics_record_batch: {
        args: abi(['usize', 'ptr', 'usize']),
        returns: 'u8',
      },
      // Fused wire-level validation: RAW query/cookie → JSON → draft-07 gate.
      // `inner` is the SchemaValidator inner handle; strings cross as cstring
      // ARGs (engine-transcoded).
      castrum_query_validate: { args: ['usize', 'cstring'], returns: 'u8' },
      castrum_cookie_validate: { args: ['usize', 'cstring'], returns: 'u8' },
      // Fused session envelope: seal builds+signs; open verifies + extracts.
      castrum_session_seal: {
        args: ['cstring', 'cstring', 'i64', 'cstring'],
        returns: 'cstring',
      },
      castrum_session_open: {
        args: abi(['cstring', 'cstring', 'ptr', 'usize']),
        returns: U64_FAST,
      },
      castrum_metrics_destroy: { args: ['usize'], returns: 'void' },
    })

    // (`as unknown as`: the zero-arg `castrum_metrics_create` infers
    // `(...args: never[])`, which can't overlap `(...a: unknown[])` directly.)
    const bindings = build(
      symbols as unknown as Record<string, (...a: unknown[]) => unknown>,
      useBufferLength,
    )
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
