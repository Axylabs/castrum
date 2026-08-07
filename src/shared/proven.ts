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

export type PerformanceStatus =
  | "proven"
  | "parity"
  | "not-competitive"
  | "unmeasured";

export interface ProvenEntry {
  /** Public `rust.<name>` method key. */
  name: string;
  /** Benchmark comparison label (see src/bench/comparisons.ts). */
  label: string;
  /** Baseline task name in the CPU report. */
  nativeTask: string;
  /** Rust task name in the CPU report. */
  rustTask: string;
  status: PerformanceStatus;
  /** Typical rust-vs-baseline ratio from release/perf builds (rust faster = >1). */
  typicalRatio?: number;
  /** Why this classification. */
  note?: string;
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
  { name: "fnv1a64", label: "FNV-1a 64", nativeTask: "native:fnv1a64", rustTask: "rust:fnv1a64", status: "proven", typicalRatio: 11 },
  { name: "jsonValid", label: "JSON valid", nativeTask: "native:json_valid", rustTask: "rust:json_valid", status: "proven", typicalRatio: 3 },
  { name: "jsonSumIds", label: "JSON sum", nativeTask: "native:json_sum", rustTask: "rust:json_sum", status: "proven", typicalRatio: 3 },
  { name: "httpParseRequestPacked", label: "HTTP parse", nativeTask: "native:http_parse", rustTask: "rust:http_parse", status: "proven", typicalRatio: 4 },
  { name: "queryParsePacked", label: "Query parse", nativeTask: "native:query_parse", rustTask: "rust:query_parse", status: "proven", typicalRatio: 4 },
  { name: "cookieParsePacked", label: "Cookie parse", nativeTask: "native:cookie_parse", rustTask: "rust:cookie_parse", status: "proven", typicalRatio: 2.5 },
  { name: "wsAcceptKey", label: "WebSocket accept", nativeTask: "native:ws_accept_key", rustTask: "rust:ws_accept_key", status: "proven", typicalRatio: 1.6 },
  { name: "jsonPatch", label: "JSON Patch", nativeTask: "native:json_patch", rustTask: "rust:json_patch", status: "proven", typicalRatio: 1.5 },
  { name: "hmacSha256", label: "HMAC sign", nativeTask: "native:hmac_sha256", rustTask: "rust:hmac_sha256", status: "proven", typicalRatio: 1.5 },
  { name: "hmacSha256Verify", label: "HMAC verify", nativeTask: "native:hmac_verify", rustTask: "rust:hmac_verify", status: "proven", typicalRatio: 2.4 },
  { name: "validateEmail", label: "Email validation", nativeTask: "native:validate_email", rustTask: "rust:validate_email", status: "proven", typicalRatio: 3 },
  { name: "validateIpv6", label: "IPv6 validation", nativeTask: "native:validate_ipv6", rustTask: "rust:validate_ipv6", status: "proven", typicalRatio: 1.3 },
  { name: "urlEncode", label: "URL encode", nativeTask: "native:url_encode", rustTask: "rust:url_encode", status: "not-competitive", note: "Loses ~2.8x on the shipped baseline release build (only wins in the LOCAL SIMD perf build)." },
  { name: "urlDecode", label: "URL decode", nativeTask: "native:url_decode", rustTask: "rust:url_decode", status: "not-competitive", note: "Loses ~2.8x on the shipped baseline release build (only wins in the LOCAL SIMD perf build)." },
  { name: "jwtVerify", label: "JWT verify", nativeTask: "native:jwt_verify", rustTask: "rust:jwt_verify", status: "proven", typicalRatio: 1.4 },
  { name: "passwordHash", label: "Password hash", nativeTask: "native:password_hash", rustTask: "rust:password_hash", status: "proven", typicalRatio: 19, note: "argon2id vs node:crypto scrypt." },
  { name: "aeadEncrypt", label: "AEAD encrypt", nativeTask: "native:aead_encrypt", rustTask: "rust:aead_encrypt", status: "proven", typicalRatio: 1.6 },
  { name: "aeadDecrypt", label: "AEAD decrypt", nativeTask: "native:aead_decrypt", rustTask: "rust:aead_decrypt", status: "proven", typicalRatio: 2 },
  { name: "gzipDecompress", label: "Gzip decompress", nativeTask: "native:gzip_decompress", rustTask: "rust:gzip_decompress", status: "proven", typicalRatio: 1.4 },
  { name: "brotliDecompress", label: "Brotli decompress", nativeTask: "native:brotli_decompress", rustTask: "rust:brotli_decompress", status: "proven", typicalRatio: 1.9 },
  { name: "multipartParse", label: "Multipart parse", nativeTask: "native:multipart_parse", rustTask: "rust:multipart_parse", status: "proven", typicalRatio: 2.3 },
  { name: "wsFrameEncode", label: "WS frame encode", nativeTask: "native:ws_frame_encode", rustTask: "rust:ws_frame_encode", status: "proven", typicalRatio: 1.8 },
  { name: "wsFrameDecode", label: "WS frame decode", nativeTask: "native:ws_frame_decode", rustTask: "rust:ws_frame_decode", status: "proven", typicalRatio: 2 },

  // ── Parity (no clear win) ──
  { name: "crc32", label: "CRC32", nativeTask: "native:crc32", rustTask: "rust:crc32", status: "parity", typicalRatio: 1, note: "Near parity with the JS crc-32 baseline." },
  { name: "randomToken", label: "Random token", nativeTask: "native:random_token", rustTask: "rust:random_token", status: "parity", typicalRatio: 1.1 },
  { name: "validateUuid", label: "UUID validation", nativeTask: "native:validate_uuid", rustTask: "rust:validate_uuid", status: "parity", typicalRatio: 1 },
  { name: "validateIpv4", label: "IPv4 validation", nativeTask: "native:validate_ipv4", rustTask: "rust:validate_ipv4", status: "parity", typicalRatio: 1.05 },
  { name: "mimeFromExtension", label: "MIME lookup", nativeTask: "native:mime", rustTask: "rust:mime", status: "parity", typicalRatio: 1.2 },
  { name: "gzipCompress", label: "Gzip compress", nativeTask: "native:gzip_compress", rustTask: "rust:gzip_compress", status: "parity", typicalRatio: 1 },
  { name: "sseEncodeEvent", label: "SSE encode", nativeTask: "native:sse_encode", rustTask: "rust:sse_encode", status: "parity", typicalRatio: 1.1 },

  // ── Not competitive (JS baseline wins) ──
  {
    name: "jsonParse",
    label: "JSON parse",
    nativeTask: "native:json_parse",
    rustTask: "rust:json_parse",
    status: "not-competitive",
    note: "Bun's JSON.parse beats the native DOM + napi marshaling path (~5x).",
  },
  {
    name: "createSchemaValidator",
    label: "JSON schema validate",
    nativeTask: "native:json_schema_validate",
    rustTask: "rust:json_schema_validate",
    status: "proven",
    note: "Zero-DOM fast path validates raw bytes for the common keyword subset (scalar ~1.2-2.4x, batch ~1.0-1.56x vs ajv); unsupported keywords fall back to the jsonschema crate.",
  },
  {
    name: "jwtSign",
    label: "JWT sign",
    nativeTask: "native:jwt_sign",
    rustTask: "rust:jwt_sign",
    status: "not-competitive",
    note: "Base64 + marshaling overhead; slightly slower than the baseline.",
  },
  {
    name: "brotliCompress",
    label: "Brotli compress",
    nativeTask: "native:brotli_compress",
    rustTask: "rust:brotli_compress",
    status: "not-competitive",
    note: "The native brotli baseline wins for small inputs.",
  },
  {
    name: "templateRender",
    label: "Template render",
    nativeTask: "native:template_render",
    rustTask: "rust:template_render",
    status: "not-competitive",
    note: "The hand-rolled JS mini-template wins for small templates.",
  },

  // ── Framework actions (2026-08-07; release-build numbers) ──
  { name: "formParsePacked", label: "Form parse", nativeTask: "native:form_parse", rustTask: "rust:form_parse", status: "proven", typicalRatio: 5.8, note: "Benchmarked via the FormParser instance (same parser core)." },
  { name: "parseMediaType", label: "Media type parse", nativeTask: "native:media_type_parse", rustTask: "rust:media_type_parse", status: "parity", typicalRatio: 1.04 },
  { name: "etag", label: "ETag", nativeTask: "native:etag", rustTask: "rust:etag", status: "parity", typicalRatio: 1.06 },
  { name: "httpDate", label: "HTTP date", nativeTask: "native:http_date", rustTask: "rust:http_date", status: "not-competitive", note: "Date.toUTCString() is native; loses ~1.5x." },
  { name: "createConditionalRequest", label: "Conditional request", nativeTask: "native:conditional", rustTask: "rust:conditional", status: "proven", typicalRatio: 1.4 },
  { name: "createAcceptNegotiator", label: "Accept-Encoding negotiate", nativeTask: "native:accept_negotiate", rustTask: "rust:accept_negotiate", status: "proven", typicalRatio: 4 },
  { name: "base64Encode", label: "Base64 encode", nativeTask: "native:base64_encode", rustTask: "rust:base64_encode", status: "not-competitive", note: "Bun Buffer base64 is SIMD; loses ~1.5x." },
  { name: "base64Decode", label: "Base64 decode", nativeTask: "native:base64_decode", rustTask: "rust:base64_decode", status: "parity", typicalRatio: 1.17 },
  { name: "hexEncode", label: "Hex encode", nativeTask: "native:hex_encode", rustTask: "rust:hex_encode", status: "not-competitive", note: "Buffer.toString('hex') is native; loses ~2x." },
  { name: "hexDecode", label: "Hex decode", nativeTask: "native:hex_decode", rustTask: "rust:hex_decode", status: "parity", typicalRatio: 0.78, note: "Slightly slower than Buffer hex decode (~1.3x)." },
  { name: "signCookie", label: "Cookie sign", nativeTask: "native:cookie_sign", rustTask: "rust:cookie_sign", status: "proven", typicalRatio: 9 },
  { name: "verifyCookie", label: "Cookie verify", nativeTask: "native:cookie_verify", rustTask: "rust:cookie_verify", status: "proven", typicalRatio: 2.1 },
  { name: "csrfToken", label: "CSRF create", nativeTask: "native:csrf_create", rustTask: "rust:csrf_create", status: "proven", typicalRatio: 13.8 },
  { name: "csrfVerify", label: "CSRF verify", nativeTask: "native:csrf_verify", rustTask: "rust:csrf_verify", status: "proven", typicalRatio: 2.7 },
  { name: "urlResolve", label: "URL resolve", nativeTask: "native:url_resolve", rustTask: "rust:url_resolve", status: "parity", typicalRatio: 1.11 },
  { name: "urlEncodeQuery", label: "URL query build", nativeTask: "native:url_encode_query", rustTask: "rust:url_encode_query", status: "not-competitive", note: "encodeURIComponent baseline wins (~1.2-1.35x)." },

  // ── Unmeasured (no direct comparison task) ──
  { name: "passwordVerify", label: "Password verify", nativeTask: "", rustTask: "", status: "unmeasured", note: "Depends on the hash cost; no standalone comparison." },
  { name: "urlDecodeBytes", label: "URL decode (bytes)", nativeTask: "", rustTask: "", status: "unmeasured" },
  { name: "configure", label: "configure", nativeTask: "", rustTask: "", status: "unmeasured", note: "Config only." },
  { name: "initThreadPool", label: "initThreadPool", nativeTask: "", rustTask: "", status: "unmeasured", note: "Runtime setup only." },
  { name: "rayonNumThreads", label: "rayonNumThreads", nativeTask: "", rustTask: "", status: "unmeasured", note: "Introspection only." },
] as const satisfies readonly ProvenEntry[];

/** An entry of the registry with a specific status (type-level). */
type ProvenEntryOf<S extends PerformanceStatus> = Extract<
  (typeof PROVEN_SURFACE)[number],
  { status: S }
>;

/**
 * The `rust.<name>` keys whose status is "proven" — the only keys exposed on
 * the `proven` surface. Derived from the registry so the type can never drift
 * from the data.
 */
export type ProvenKey = ProvenEntryOf<"proven">["name"];

const byName = new Map<string, ProvenEntry>(
  PROVEN_SURFACE.map((e) => [e.name, e]),
);

/** Look up the status of a public function by its `rust.<name>` key. */
export function provenStatus(name: string): PerformanceStatus | undefined {
  return byName.get(name)?.status;
}

/** Whether a function is part of the performance-proven surface. */
export function isProven(name: string): boolean {
  return provenStatus(name) === "proven";
}

/** The entries that are performance-proven (Rust clearly wins). */
export function provenSurface(): ProvenEntry[] {
  return PROVEN_SURFACE.filter((e) => e.status === "proven");
}

/** Aggregate summary of the registry (status → count). */
export function provenSummary(): Record<PerformanceStatus, number> {
  const out: Record<PerformanceStatus, number> = {
    proven: 0,
    parity: 0,
    "not-competitive": 0,
    unmeasured: 0,
  };
  for (const e of PROVEN_SURFACE) out[e.status] += 1;
  return out;
}
