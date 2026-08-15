// src/shared/proven.ts — Performance-proven export registry (SINGLE SOURCE OF TRUTH).
//
// Every public `rust.<name>` function is classified by how it performs against
// its JavaScript baseline in the CPU benchmark (`bun run check`, which writes
// `bench/results/cpu/latest.json`):
//
//   - "proven"           Rust consistently wins in release/perf builds.
//   - "parity"           Rust is within ~±15% of the JS baseline (no clear win).
//   - "not-competitive"  Rust loses to the JS baseline (e.g. DOM + napi
//                        marshaling costs, or a highly optimized host built-in
//                        like Bun's JSON.parse).
//   - "unmeasured"       No direct comparison task exists (infra/config only).
//
// This module is PURE DATA — it must NOT import the addon or the `rust` client,
// so the audit script (`scripts/check-proven.ts`) can load it without dlopening
// the native addon.

/** How a `rust.*` function performs against its JS baseline in the CPU bench. */
export type PerformanceStatus = 'proven' | 'parity' | 'not-competitive' | 'unmeasured'

/** One entry in the performance-proven registry (a public `rust.*` function). */
export interface ProvenEntry {
  /** Public `rust.<name>` method key. */
  name: string
  /** Benchmark comparison label (see src/bench/comparisons.ts). */
  label: string
  /** Baseline task name in the CPU report. */
  nativeTask: string
  /** Rust task name in the CPU report. */
  rustTask: string
  status: PerformanceStatus
  /** Typical rust-vs-baseline ratio from release/perf builds (rust faster = >1). */
  typicalRatio?: number
  /** Why this classification. */
  note?: string
}

/**
 * Curated registry. Classifications are based on release/perf-build results
 * (docs + prior runs); the audit script re-checks them against the latest
 * report. Borderline wins are kept as "parity" so the `proven` surface stays
 * honest.
 *
 * `as const satisfies` keeps the literal `name`/`status` types so the
 * `ProvenKey` type (below) can be derived at the type level.
 */
export const PROVEN_SURFACE = [
  // ── Clear wins (Rust > baseline) ──
  {
    name: 'fnv1a64',
    label: 'FNV-1a 64',
    nativeTask: 'native:fnv1a64',
    rustTask: 'rust:fnv1a64',
    status: 'proven',
    typicalRatio: 11,
  },
  {
    name: 'jsonValid',
    label: 'JSON valid',
    nativeTask: 'native:json_valid',
    rustTask: 'rust:json_valid',
    status: 'proven',
    typicalRatio: 3,
  },
  {
    name: 'jsonSumIds',
    label: 'JSON sum',
    nativeTask: 'native:json_sum',
    rustTask: 'rust:json_sum',
    status: 'proven',
    typicalRatio: 3,
  },
  {
    name: 'httpParseRequestPacked',
    label: 'HTTP parse',
    nativeTask: 'native:http_parse',
    rustTask: 'rust:http_parse',
    status: 'proven',
    typicalRatio: 4,
  },
  {
    name: 'queryParsePacked',
    label: 'Query parse',
    nativeTask: 'native:query_parse',
    rustTask: 'rust:query_parse',
    status: 'proven',
    typicalRatio: 4,
  },
  {
    name: 'cookieParsePacked',
    label: 'Cookie parse',
    nativeTask: 'native:cookie_parse',
    rustTask: 'rust:cookie_parse',
    status: 'proven',
    typicalRatio: 2.5,
  },
  {
    name: 'wsAcceptKey',
    label: 'WebSocket accept',
    nativeTask: 'native:ws_accept_key',
    rustTask: 'rust:ws_accept_key',
    status: 'proven',
    typicalRatio: 1.6,
  },
  {
    name: 'jsonPatch',
    label: 'JSON Patch',
    nativeTask: 'native:json_patch',
    rustTask: 'rust:json_patch',
    status: 'proven',
    typicalRatio: 1.2,
    note: 'Modest but real win; swings ~0.9-1.5x run-to-run (DOM marshal dominated).',
  },
  {
    name: 'hmacSha256',
    label: 'HMAC sign',
    nativeTask: 'native:hmac_sha256',
    rustTask: 'rust:hmac_sha256',
    status: 'proven',
    typicalRatio: 1.5,
    note: 'Classification vs the node:crypto baseline. Under Bun the public rust.hmacSha256 delegates to Bun.CryptoHasher (BUN_WINS — hex re-encoded to the same contract); this row measures the raw addon (see src/bench/raw-native.ts).',
  },
  {
    name: 'hmacSha256Verify',
    label: 'HMAC verify',
    nativeTask: 'native:hmac_verify',
    rustTask: 'rust:hmac_verify',
    status: 'proven',
    typicalRatio: 2.4,
  },
  {
    name: 'validateEmail',
    label: 'Email validation',
    nativeTask: 'native:validate_email',
    rustTask: 'rust:validate_email',
    status: 'proven',
    typicalRatio: 3,
  },
  {
    name: 'validateIpv6',
    label: 'IPv6 validation',
    nativeTask: 'native:validate_ipv6',
    rustTask: 'rust:validate_ipv6',
    status: 'proven',
    typicalRatio: 1.3,
  },
  {
    name: 'urlEncode',
    label: 'URL encode',
    nativeTask: 'native:url_encode',
    rustTask: 'rust:url_encode',
    status: 'not-competitive',
    note: 'Public rust.urlEncode delegates to encodeURIComponent under Bun (BUN_WINS — ~3-4x faster than the FFI crossing; skips the C-ABI call). The rust: column measures the RAW addon (src/bench/raw-native.ts): the small-input FFI crossing loses (~0.58x), but LARGE inputs win (rust:url_encode_large ~1.45x) — the honest report no longer self-compares the built-in. Rust addon remains the Node path. Byte parity pinned by test/unit/features/url.test.ts + test/unit/features/wiring.test.ts.',
  },
  {
    name: 'urlDecode',
    label: 'URL decode',
    nativeTask: 'native:url_decode',
    rustTask: 'rust:url_decode',
    status: 'not-competitive',
    note: 'Public rust.urlDecode delegates to decodeURIComponent under Bun (BUN_WINS — ~4-8x faster than the FFI crossing; strict UTF-8 semantics match: both throw on malformed/invalid). The rust: column measures the RAW addon (src/bench/raw-native.ts): the small-input FFI crossing loses (~0.55x), but LARGE inputs win (rust:url_decode_large ~3.45x) — the honest report no longer self-compares the built-in. Rust addon remains the Node path and the raw-bytes urlDecodeBytes stays native. Parity pinned by test/unit/features/url.test.ts + test/unit/features/wiring.test.ts.',
  },
  {
    name: 'jwtVerify',
    label: 'JWT verify',
    nativeTask: 'native:jwt_verify',
    rustTask: 'rust:jwt_verify',
    status: 'proven',
    typicalRatio: 1.4,
  },
  {
    name: 'passwordHash',
    label: 'Password hash',
    nativeTask: 'native:password_hash',
    rustTask: 'rust:password_hash',
    status: 'proven',
    typicalRatio: 19,
    note: 'argon2id vs node:crypto scrypt.',
  },
  {
    name: 'aeadEncrypt',
    label: 'AEAD encrypt',
    nativeTask: 'native:aead_encrypt',
    rustTask: 'rust:aead_encrypt',
    status: 'proven',
    typicalRatio: 1.6,
  },
  {
    name: 'aeadDecrypt',
    label: 'AEAD decrypt',
    nativeTask: 'native:aead_decrypt',
    rustTask: 'rust:aead_decrypt',
    status: 'proven',
    typicalRatio: 2,
  },
  {
    name: 'gzipDecompress',
    label: 'Gzip decompress',
    nativeTask: 'native:gzip_decompress',
    rustTask: 'rust:gzip_decompress',
    status: 'proven',
    typicalRatio: 1.4,
    note: "zlib-rs vs node zlib; swings 1.0-1.4x run-to-run. Deliberately NOT delegated to Bun.gunzipSync under Bun (NOT in BUN_WINS): Bun's decompressor has no output-size bound, and the native path keeps the 64 MiB decompression-bomb cap.",
  },
  {
    name: 'brotliDecompress',
    label: 'Brotli decompress',
    nativeTask: 'native:brotli_decompress',
    rustTask: 'rust:brotli_decompress',
    status: 'proven',
    typicalRatio: 1.9,
  },
  {
    name: 'multipartParse',
    label: 'Multipart parse',
    nativeTask: 'native:multipart_parse',
    rustTask: 'rust:multipart_parse',
    status: 'proven',
    typicalRatio: 2.3,
  },
  {
    name: 'wsFrameEncode',
    label: 'WS frame encode',
    nativeTask: 'native:ws_frame_encode',
    rustTask: 'rust:ws_frame_encode',
    status: 'proven',
    typicalRatio: 1.8,
  },
  {
    name: 'wsFrameDecode',
    label: 'WS frame decode',
    nativeTask: 'native:ws_frame_decode',
    rustTask: 'rust:ws_frame_decode',
    status: 'proven',
    typicalRatio: 2,
  },
  {
    name: 'createSchemaValidator',
    label: 'JSON schema validate',
    nativeTask: 'native:json_schema_validate',
    rustTask: 'rust:json_schema_validate',
    status: 'proven',
    note: 'Zero-DOM fast path validates raw bytes for the common keyword subset (scalar ~1.2-2.4x, batch ~1.0-1.56x vs ajv); unsupported keywords fall back to the jsonschema crate.',
  },

  // ── Parity (no clear win) ──
  {
    name: 'crc32',
    label: 'CRC32',
    nativeTask: 'native:crc32',
    rustTask: 'rust:crc32',
    status: 'not-competitive',
    note: 'Raw addon vs the same-engine JS crc-32 loop (~0.23-0.44x across runs). Under Bun the public rust.crc32 delegates to Bun.hash.crc32 (BUN_WINS, ~2.8-8.4x) — this row measures the raw addon (src/bench/raw-native.ts).',
  },
  {
    name: 'xxh3',
    label: 'XXH3-64',
    nativeTask: 'diag:bun_hash_xxh3',
    rustTask: 'diag:xxh3',
    status: 'not-competitive',
    note: 'Bun.hash.xxHash3 wins ~4x (in-process C++ beats the FFI crossing). The public rust.xxh3 now DELEGATES to Bun.hash.xxHash3 under Bun (BUN_WINS); the addon remains the Node/non-Bun fast path. See docs/bun-builtins-decision-matrix.md.',
  },
  {
    name: 'randomToken',
    label: 'Random token',
    nativeTask: 'native:random_token',
    rustTask: 'rust:random_token',
    status: 'parity',
    typicalRatio: 1.1,
    note: 'Raw addon vs crypto.getRandomValues baseline. Under Bun the public rust.randomToken delegates to crypto.getRandomValues + native hex (BUN_WINS, same 2n-hex format + 16 MiB guard) — this row measures the raw addon (src/bench/raw-native.ts).',
  },
  {
    name: 'validateUuid',
    label: 'UUID validation',
    nativeTask: 'native:validate_uuid',
    rustTask: 'rust:validate_uuid',
    status: 'parity',
    typicalRatio: 1,
  },
  {
    name: 'validateIpv4',
    label: 'IPv4 validation',
    nativeTask: 'native:validate_ipv4',
    rustTask: 'rust:validate_ipv4',
    status: 'parity',
    typicalRatio: 1.05,
  },
  {
    name: 'mimeFromExtension',
    label: 'MIME lookup',
    nativeTask: 'native:mime',
    rustTask: 'rust:mime',
    status: 'parity',
    typicalRatio: 1.4,
    note: 'Consistently ~1.38-1.44x rust after the 2026-08-12 marshal reduction (cachedMime no longer per-call slices; text.mimeFromExtension memoizes the decoded string). phf table lookup.',
  },
  {
    name: 'gzipCompress',
    label: 'Gzip compress',
    nativeTask: 'native:gzip_compress',
    rustTask: 'rust:gzip_compress',
    status: 'parity',
    typicalRatio: 1,
    note: 'Raw addon vs node zlib baseline. Under Bun the public rust.gzipCompress delegates to Bun.gzipSync (BUN_WINS, ~2x; decompression-parity with the addon — only the header OS byte differs) — this row measures the raw addon (src/bench/raw-native.ts).',
  },
  {
    name: 'sseEncodeEvent',
    label: 'SSE encode',
    nativeTask: 'native:sse_encode',
    rustTask: 'rust:sse_encode',
    status: 'parity',
    typicalRatio: 1.1,
  },

  // ── New primitives (2026-08-11; measured vs Bun built-ins / node:crypto) ──
  {
    name: 'passwordHashBcrypt',
    label: 'Password hash (bcrypt)',
    nativeTask: 'diag:bun_password_bcrypt_hash',
    rustTask: 'diag:bcrypt_hash',
    status: 'parity',
    note: 'Bun.password.bcrypt ~1.24x faster at cost 10 (noisy KDF); rust is self-contained and non-Bun. See docs/bun-builtins-decision-matrix.md.',
  },
  {
    name: 'passwordVerifyBcrypt',
    label: 'Password verify (bcrypt)',
    nativeTask: 'diag:bun_password_bcrypt_verify',
    rustTask: 'diag:bcrypt_verify',
    status: 'parity',
    note: 'Rust ~1.49x vs Bun.password.verify at cost 10; KDF timings noisy — parity for gate stability.',
  },
  {
    name: 'pbkdf2Sha256',
    label: 'PBKDF2-HMAC-SHA256',
    nativeTask: 'diag:pbkdf2_sha256',
    rustTask: 'diag:pbkdf2_sha256_rust',
    status: 'parity',
    note: '~1.08x vs node:crypto pbkdf2Sync at 100k rounds (parity); Bun has no synchronous PBKDF2.',
  },

  // ── Not competitive (JS baseline wins) ──
  {
    name: 'jsonParse',
    label: 'JSON parse',
    nativeTask: 'native:json_parse',
    rustTask: 'rust:json_parse',
    status: 'not-competitive',
    note: "The FFI packed structural path closed the old 3.92x gap to ~1.9x, but Bun's JSON.parse still wins for DOM construction — exact parity needs Bun delegation.",
  },
  {
    name: 'jwtSign',
    label: 'JWT sign',
    nativeTask: 'native:jwt_sign',
    rustTask: 'rust:jwt_sign',
    status: 'not-competitive',
    note: 'Base64 + claims DOM marshal overhead. Use jwtSignBytes (claims as JSON bytes) which skips the napi Value marshal and flips to a ~1.07x win.',
  },
  {
    name: 'jwtSignBytes',
    label: 'JWT sign (bytes)',
    nativeTask: 'native:jwt_sign',
    rustTask: 'rust:jwt_sign_bytes',
    status: 'parity',
    note: 'Byte-JSON claims overload avoids the napi serde_json::Value DOM marshal; flips jwtSign from a ~1.3x loss to ~1.07x (parity).',
  },
  {
    name: 'brotliCompress',
    label: 'Brotli compress',
    nativeTask: 'native:brotli_compress',
    rustTask: 'rust:brotli_compress',
    status: 'not-competitive',
    note: 'The native brotli baseline wins for small inputs.',
  },
  {
    name: 'templateRender',
    label: 'Template render',
    nativeTask: 'native:template_render',
    rustTask: 'rust:template_render',
    status: 'not-competitive',
    note: 'The allocating render marshals the context via napi DOM (~1.5x loss). Use TemplateRenderer.renderBytes (JSON-bytes context) which avoids it and wins ~1.37x.',
  },

  // ── Framework actions (2026-08-07; release-build numbers) ──
  {
    name: 'formParsePacked',
    label: 'Form parse',
    nativeTask: 'native:form_parse',
    rustTask: 'rust:form_parse',
    status: 'proven',
    typicalRatio: 5.8,
    note: 'Benchmarked via the FormParser instance (same parser core).',
  },
  {
    name: 'parseMediaType',
    label: 'Media type parse',
    nativeTask: 'native:media_type_parse',
    rustTask: 'rust:media_type_parse',
    status: 'not-competitive',
    note: 'Consistent ~0.71-0.81x (sub-µs FFI crossing vs the JS baseline); use MediaTypeMatcher (precompiled expected) for the zero-alloc match path.',
  },
  {
    name: 'etag',
    label: 'ETag',
    nativeTask: 'native:etag',
    rustTask: 'rust:etag',
    status: 'parity',
    typicalRatio: 1.06,
  },
  {
    name: 'httpDate',
    label: 'HTTP date',
    nativeTask: 'native:http_date',
    rustTask: 'rust:http_date',
    status: 'not-competitive',
    note: 'Delegates to Date.toUTCString() under Bun (BUN_WINS — ~3.7x faster than the FFI crossing; byte-identical RFC 1123 for HTTP timestamps, incl. leap years/epoch). Rust addon remains the Node path; pooled httpDateInto stays native.',
  },
  {
    name: 'createConditionalRequest',
    label: 'Conditional request',
    nativeTask: 'native:conditional',
    rustTask: 'rust:conditional',
    status: 'proven',
    typicalRatio: 1.4,
  },
  {
    name: 'createAcceptNegotiator',
    label: 'Accept-Encoding negotiate',
    nativeTask: 'native:accept_negotiate',
    rustTask: 'rust:accept_negotiate',
    status: 'proven',
    typicalRatio: 4,
  },
  {
    name: 'base64Encode',
    label: 'Base64 encode',
    nativeTask: 'native:base64_encode',
    rustTask: 'rust:base64_encode',
    status: 'not-competitive',
    note: 'Delegates to Buffer base64 under Bun for the standard padded, non-url-safe case (BUN_WINS — ~2x faster than the FFI crossing); url-safe/unpadded falls through to native. Rust addon remains the Node path. Parity pinned by test/unit/features/encoding.test.ts.',
  },
  {
    name: 'base64Decode',
    label: 'Base64 decode',
    nativeTask: 'native:base64_decode',
    rustTask: 'rust:base64_decode',
    status: 'parity',
    typicalRatio: 1.17,
  },
  {
    name: 'hexEncode',
    label: 'Hex encode',
    nativeTask: 'native:hex_encode',
    rustTask: 'rust:hex_encode',
    status: 'not-competitive',
    note: "Buffer.toString('hex') is native SIMD; pooled hexEncodeInto cuts the loss from ~2.2x to ~1.35x.",
  },
  {
    name: 'hexDecode',
    label: 'Hex decode',
    nativeTask: 'native:hex_decode',
    rustTask: 'rust:hex_decode',
    status: 'parity',
    typicalRatio: 0.78,
    note: 'Slightly slower than Buffer hex decode (~1.3x).',
  },
  {
    name: 'signCookie',
    label: 'Cookie sign',
    nativeTask: 'native:cookie_sign',
    rustTask: 'rust:cookie_sign',
    status: 'proven',
    typicalRatio: 9,
  },
  {
    name: 'verifyCookie',
    label: 'Cookie verify',
    nativeTask: 'native:cookie_verify',
    rustTask: 'rust:cookie_verify',
    status: 'proven',
    typicalRatio: 2.1,
  },
  {
    name: 'csrfToken',
    label: 'CSRF create',
    nativeTask: 'native:csrf_create',
    rustTask: 'rust:csrf_create',
    status: 'proven',
    typicalRatio: 13.8,
  },
  {
    name: 'csrfVerify',
    label: 'CSRF verify',
    nativeTask: 'native:csrf_verify',
    rustTask: 'rust:csrf_verify',
    status: 'proven',
    typicalRatio: 2.7,
  },
  {
    name: 'urlResolve',
    label: 'URL resolve',
    nativeTask: 'native:url_resolve',
    rustTask: 'rust:url_resolve',
    status: 'parity',
    typicalRatio: 1.11,
    note: 'Noisy ~1.5µs op; swings 0.74-1.03x run-to-run. UrlBuilder reuses the parsed base.',
  },
  {
    name: 'urlEncodeQuery',
    label: 'URL query build',
    nativeTask: 'native:url_encode_query',
    rustTask: 'rust:url_encode_query',
    status: 'not-competitive',
    note: 'encodeURIComponent baseline wins (~1.2-1.35x).',
  },

  // ── Unmeasured (no direct comparison task) ──
  {
    name: 'passwordVerify',
    label: 'Password verify',
    nativeTask: '',
    rustTask: '',
    status: 'unmeasured',
    note: 'Depends on the hash cost; no standalone comparison.',
  },
  {
    name: 'urlDecodeBytes',
    label: 'URL decode (bytes)',
    nativeTask: 'native:url_decode_bytes',
    rustTask: 'rust:url_decode_bytes',
    status: 'parity',
    note: 'Raw-bytes percent-decode (no UTF-8 validation, no +→space) vs a hand-rolled JS baseline with identical semantics. Previously unmeasured; added 2026-08-14.',
  },
  {
    name: 'configure',
    label: 'configure',
    nativeTask: '',
    rustTask: '',
    status: 'unmeasured',
    note: 'Config only.',
  },
  {
    name: 'initThreadPool',
    label: 'initThreadPool',
    nativeTask: '',
    rustTask: '',
    status: 'unmeasured',
    note: 'Runtime setup only.',
  },
  {
    name: 'rayonNumThreads',
    label: 'rayonNumThreads',
    nativeTask: '',
    rustTask: '',
    status: 'unmeasured',
    note: 'Introspection only.',
  },
] as const satisfies readonly ProvenEntry[]

/** An entry of the registry with a specific status (type-level). */
type ProvenEntryOf<S extends PerformanceStatus> = Extract<
  (typeof PROVEN_SURFACE)[number],
  { status: S }
>

/**
 * The `rust.<name>` keys whose status is "proven" — the only keys exposed on
 * the `proven` surface. Derived from the registry so the type can never drift
 * from the data.
 */
export type ProvenKey = ProvenEntryOf<'proven'>['name']

const byName = new Map<string, ProvenEntry>(PROVEN_SURFACE.map((e) => [e.name, e]))

/** Look up the status of a public function by its `rust.<name>` key. */
export function provenStatus(name: string): PerformanceStatus | undefined {
  return byName.get(name)?.status
}

/** Whether a function is part of the performance-proven surface. */
export function isProven(name: string): boolean {
  return provenStatus(name) === 'proven'
}

/** The entries that are performance-proven (Rust clearly wins). */
export function provenSurface(): ProvenEntry[] {
  return PROVEN_SURFACE.filter((e) => e.status === 'proven')
}

/** Aggregate summary of the registry (status → count). */
export function provenSummary(): Record<PerformanceStatus, number> {
  const out: Record<PerformanceStatus, number> = {
    proven: 0,
    parity: 0,
    'not-competitive': 0,
    unmeasured: 0,
  }
  for (const e of PROVEN_SURFACE) out[e.status] += 1
  return out
}
