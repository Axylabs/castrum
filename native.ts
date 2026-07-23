import { dlopen, FFIType, suffix } from "bun:ffi";
import * as ffi from "bun:ffi";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ffiPtr = (ffi as any).ptr as
  | undefined
  | ((view: any, byteOffset?: number) => number);

function ptr(view: ArrayBufferView): any {
  if (typeof ffiPtr === "function") return ffiPtr(view);
  const legacyPtr = (view as any).ptr;
  if (typeof legacyPtr === "number") return legacyPtr;
  return view;
}

const candidates = [
  process.env.RUST_BENCH_LIB,
  fileURLToPath(new URL(`./target/release/librust_bench.${suffix}`, import.meta.url)),
  fileURLToPath(new URL(`./target/release/rust_bench.${suffix}`, import.meta.url)),
].filter((x): x is string => typeof x === "string" && x.length > 0);

const libPath = candidates.find((path) => existsSync(path));

if (!libPath) {
  console.error("Could not find Rust shared library.");
  console.error("Run: cargo build --release");
  console.error(`Looked for: ${candidates.join(", ")}`);
  process.exit(1);
}

console.log(`Loading Rust library: ${libPath}`);

const lib = dlopen(libPath, {

    // Practical v2
  rust_json_valid_v2:             { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_json_sum_ids_v2:           { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_http_parse_request_v2:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_query_parse_v2:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_parse_v2:           { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_random_token_v2:           { returns: FFIType.i64, args: [FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_ws_accept_key_v2:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_patch_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_hmac_sha256_verify_v2:     { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_route_match_v2:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_validate_email_v2:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_uuid_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv4_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv6_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_crc32_v2:                  { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u64] },
  rust_fnv1a64_v2:                { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_mime_from_extension_v2:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_encode_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_decode_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  // Section 20: Original
  rust_json_sum_ids:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_json_valid:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_products_add:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_products_get_id:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_batch_execute:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_xxh3_u64:           { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_sha256_u64:         { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_url_sum_host_lens:  { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_prime_count:        { returns: FFIType.u32, args: [FFIType.u32] },
  rust_task_process:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 1: JSON utilities
  rust_json_extract:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_flatten:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_merge:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_patch:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 2: HTTP parsing
  rust_http_parse_request: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_query_parse:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_parse:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_serialize:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.i64, FFIType.u8, FFIType.u8, FFIType.u8, FFIType.ptr, FFIType.u64] },
  rust_multipart_parse:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_encode:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_decode:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 3: Routing
  rust_route_match:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_route_build:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 4: Validation
  rust_validate_email:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_uuid:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv4:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv6:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_luhn:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_jwt_structure: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },

  // Section 5: Crypto
  rust_hmac_sha256:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_hmac_sha256_verify: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64_encode:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64_decode:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64url_encode:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_uuid_v4:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_random_token:       { returns: FFIType.i64, args: [FFIType.u32, FFIType.ptr, FFIType.u64] },

  // Section 6: Compression
  rust_gzip_compress:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_gzip_decompress:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_compression_ratio:  { returns: FFIType.f64, args: [FFIType.ptr, FFIType.u64] },

  // Section 7: String
  rust_html_escape:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_slugify:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_template_render:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_regex_match:        { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_regex_replace:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_trim:               { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_case_convert:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.ptr, FFIType.u64] },

  // Section 8: Data processing
  rust_json_sort_by:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.ptr, FFIType.u64] },
  rust_json_paginate:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_json_filter:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_aggregate:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_group_by:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_dedup:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 9: Caching
  rust_rate_limit_check:   { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.f64, FFIType.f64, FFIType.u64, FFIType.f64] },
  rust_etag_generate:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_etag_check:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 10: HTTP response
  rust_http_response_build: { returns: FFIType.i64, args: [FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_error_response:      { returns: FFIType.i64, args: [FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 11: CORS & security
  rust_cors_headers:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_security_headers:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },

  // Section 12: WebSocket
  rust_ws_frame_parse:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_ws_frame_build:     { returns: FFIType.i64, args: [FFIType.u8, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_ws_accept_key:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 13: MIME
  rust_mime_from_extension: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_content_negotiate:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 14: Logging
  rust_log_format:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_histogram_bucket:   { returns: FFIType.u32, args: [FFIType.u64] },

  // Section 15: Path
  rust_path_normalize:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_path_is_safe:       { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_path_join:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 16: Search
  rust_binary_search:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.f64] },
  rust_text_search_count:  { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_inverted_index_build: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 17: Math
  rust_crc32:              { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u64] },
  rust_fnv1a_64:           { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_itoa:               { returns: FFIType.i64, args: [FFIType.i64, FFIType.ptr, FFIType.u64] },
  rust_atoi:               { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_format_bytes:       { returns: FFIType.i64, args: [FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 18: Pipeline
  rust_json_pipeline:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 19: Connection
  rust_parse_host:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_build:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_content_type_parse: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
});

const symbols = lib.symbols as Record<string, any>;

function callOut(fn: (...a: any[]) => bigint, outSize: number, ...args: any[]): Uint8Array {
  let size = Math.max(1, outSize);
  const maxSize = 256 * 1024 * 1024;

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

    // Rust write_response() returns -2 when the output buffer is too small.
    if (w === -2n) {
      if (size >= maxSize) {
        throw new Error(`FFI call failed: output buffer too large (>${size} bytes)`);
      }

      size = Math.min(size * 2, maxSize);
      continue;
    }

    if (w < 0n) {
      throw new Error(`FFI call failed: ${written}`);
    }

    return out.slice(0, Number(w));
  }
}

export const rust = {
    // Practical v2
  jsonValidV2: (b: Uint8Array) =>
    symbols.rust_json_valid_v2(ptr(b), b.byteLength) as number,

  jsonSumIdsV2: (b: Uint8Array) =>
    symbols.rust_json_sum_ids_v2(ptr(b), b.byteLength) as bigint,

  httpParseRequestV2: (b: Uint8Array) =>
    callOut(symbols.rust_http_parse_request_v2, 64 * 1024, ptr(b), b.byteLength),

  queryParseV2: (b: Uint8Array) =>
    callOut(symbols.rust_query_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  cookieParseV2: (b: Uint8Array) =>
    callOut(symbols.rust_cookie_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  randomTokenV2: (n: number) =>
    callOut(symbols.rust_random_token_v2, n * 2 + 64, n),

  wsAcceptKeyV2: (k: Uint8Array) =>
    callOut(symbols.rust_ws_accept_key_v2, 128, ptr(k), k.byteLength),

  jsonPatchV2: (doc: Uint8Array, patch: Uint8Array) =>
    callOut(
      symbols.rust_json_patch_v2,
      doc.byteLength + patch.byteLength + 4096,
      ptr(doc),
      doc.byteLength,
      ptr(patch),
      patch.byteLength,
    ),

  hmacSha256VerifyV2: (k: Uint8Array, d: Uint8Array, s: Uint8Array) =>
    symbols.rust_hmac_sha256_verify_v2(
      ptr(k),
      k.byteLength,
      ptr(d),
      d.byteLength,
      ptr(s),
      s.byteLength,
    ) as number,

  routeMatchV2: (pattern: Uint8Array, path: Uint8Array) =>
    callOut(
      symbols.rust_route_match_v2,
      4096,
      ptr(pattern),
      pattern.byteLength,
      ptr(path),
      path.byteLength,
    ),

  validateEmailV2: (b: Uint8Array) =>
    symbols.rust_validate_email_v2(ptr(b), b.byteLength) as number,

  validateUuidV2: (b: Uint8Array) =>
    symbols.rust_validate_uuid_v2(ptr(b), b.byteLength) as number,

  validateIpv4V2: (b: Uint8Array) =>
    symbols.rust_validate_ipv4_v2(ptr(b), b.byteLength) as number,

  validateIpv6V2: (b: Uint8Array) =>
    symbols.rust_validate_ipv6_v2(ptr(b), b.byteLength) as number,

  crc32V2: (b: Uint8Array) =>
    symbols.rust_crc32_v2(ptr(b), b.byteLength) as number,

  fnv1a64V2: (b: Uint8Array) =>
    symbols.rust_fnv1a64_v2(ptr(b), b.byteLength) as bigint,

  mimeFromExtensionV2: (ext: Uint8Array) =>
    callOut(symbols.rust_mime_from_extension_v2, 256, ptr(ext), ext.byteLength),

  urlEncodeV2: (b: Uint8Array) =>
    callOut(symbols.rust_url_encode_v2, b.byteLength * 3 + 64, ptr(b), b.byteLength),

  urlDecodeV2: (b: Uint8Array) =>
    callOut(symbols.rust_url_decode_v2, b.byteLength + 64, ptr(b), b.byteLength),
  // Original
  jsonSumIds:     (b: Uint8Array) => symbols.rust_json_sum_ids(ptr(b), b.byteLength) as bigint,
  jsonValid:      (b: Uint8Array) => symbols.rust_json_valid(ptr(b), b.byteLength) as number,
  productsAdd:    (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_products_add(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  productsGetId:  (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_products_get_id(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  batchExecute:   (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_batch_execute(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  xxh3:           (b: Uint8Array) => symbols.rust_xxh3_u64(ptr(b), b.byteLength) as bigint,
  sha256:         (b: Uint8Array) => symbols.rust_sha256_u64(ptr(b), b.byteLength) as bigint,
  urlSumHostLens: (b: Uint8Array) => symbols.rust_url_sum_host_lens(ptr(b), b.byteLength) as bigint,
  primeCount:     (n: number) => symbols.rust_prime_count(n) as number,
  taskProcess:    (b: Uint8Array, o: Uint8Array) => symbols.rust_task_process(ptr(b), b.byteLength, ptr(o), o.byteLength) as bigint,

  // JSON utilities
  jsonExtract:  (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_extract, 64 * 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonFlatten:  (b: Uint8Array) => callOut(symbols.rust_json_flatten, b.byteLength * 3 + 4096, ptr(b), b.byteLength),
  jsonMerge:    (a: Uint8Array, b: Uint8Array) => callOut(symbols.rust_json_merge, a.byteLength + b.byteLength + 4096, ptr(a), a.byteLength, ptr(b), b.byteLength),
  jsonPatch:    (d: Uint8Array, p: Uint8Array) => callOut(symbols.rust_json_patch, d.byteLength + p.byteLength + 4096, ptr(d), d.byteLength, ptr(p), p.byteLength),

  // HTTP parsing
  httpParseRequest: (b: Uint8Array) => callOut(symbols.rust_http_parse_request, 64 * 1024, ptr(b), b.byteLength),
  queryParse:       (b: Uint8Array) => callOut(symbols.rust_query_parse, 64 * 1024, ptr(b), b.byteLength),
  cookieParse:      (b: Uint8Array) => callOut(symbols.rust_cookie_parse, 64 * 1024, ptr(b), b.byteLength),
  cookieSerialize:  (n: Uint8Array, v: Uint8Array, ma: number, sec: number, ho: number, ss: number) => callOut(symbols.rust_cookie_serialize, 4096, ptr(n), n.byteLength, ptr(v), v.byteLength, ma, sec, ho, ss),
  multipartParse:   (b: Uint8Array, boundary: Uint8Array) => callOut(symbols.rust_multipart_parse, 256 * 1024, ptr(b), b.byteLength, ptr(boundary), boundary.byteLength),
  urlEncode:        (b: Uint8Array) => callOut(symbols.rust_url_encode, b.byteLength * 3 + 64, ptr(b), b.byteLength),
  urlDecode:        (b: Uint8Array) => callOut(symbols.rust_url_decode, b.byteLength + 64, ptr(b), b.byteLength),

  // Routing
  routeMatch: (p: Uint8Array, path: Uint8Array) => callOut(symbols.rust_route_match, 4096, ptr(p), p.byteLength, ptr(path), path.byteLength),
  routeBuild: (p: Uint8Array, params: Uint8Array) => callOut(symbols.rust_route_build, 4096, ptr(p), p.byteLength, ptr(params), params.byteLength),

  // Validation
  validateEmail:        (b: Uint8Array) => symbols.rust_validate_email(ptr(b), b.byteLength) as number,
  validateUuid:         (b: Uint8Array) => symbols.rust_validate_uuid(ptr(b), b.byteLength) as number,
  validateIpv4:         (b: Uint8Array) => symbols.rust_validate_ipv4(ptr(b), b.byteLength) as number,
  validateIpv6:         (b: Uint8Array) => symbols.rust_validate_ipv6(ptr(b), b.byteLength) as number,
  validateLuhn:         (b: Uint8Array) => symbols.rust_validate_luhn(ptr(b), b.byteLength) as number,
  validateJwtStructure: (b: Uint8Array) => symbols.rust_validate_jwt_structure(ptr(b), b.byteLength) as number,

  // Crypto
  hmacSha256:       (k: Uint8Array, d: Uint8Array) => callOut(symbols.rust_hmac_sha256, 4096, ptr(k), k.byteLength, ptr(d), d.byteLength),
  hmacSha256Verify: (k: Uint8Array, d: Uint8Array, s: Uint8Array) => symbols.rust_hmac_sha256_verify(ptr(k), k.byteLength, ptr(d), d.byteLength, ptr(s), s.byteLength) as number,
  base64Encode:     (b: Uint8Array) => callOut(symbols.rust_base64_encode, b.byteLength * 2 + 64, ptr(b), b.byteLength),
  base64Decode:     (b: Uint8Array) => callOut(symbols.rust_base64_decode, b.byteLength + 64, ptr(b), b.byteLength),
  base64UrlEncode:  (b: Uint8Array) => callOut(symbols.rust_base64url_encode, b.byteLength * 2 + 64, ptr(b), b.byteLength),
  uuidV4:           () => callOut(symbols.rust_uuid_v4, 64),
  randomToken:      (n: number) => callOut(symbols.rust_random_token, n * 2 + 64, n),

  // Compression
  gzipCompress:     (b: Uint8Array) => callOut(symbols.rust_gzip_compress, b.byteLength * 2 + 1024, ptr(b), b.byteLength),
gzipDecompress: (b: Uint8Array) => {
  // Default heuristic if we cannot read the gzip trailer.
  let outSize = b.byteLength * 10 + 1024;

  // Gzip files end with:
  //   CRC32 (4 bytes) + ISIZE (4 bytes, little-endian uncompressed size mod 2^32)
  if (b.byteLength >= 4) {
    const view = new DataView(
      b.buffer as ArrayBuffer,
      b.byteOffset + b.byteLength - 4,
      4,
    );
    const uncompressedHint = view.getUint32(0, true);
    outSize = Math.max(outSize, uncompressedHint + 1024);
  }

  return callOut(
    symbols.rust_gzip_decompress,
    outSize,
    ptr(b),
    b.byteLength,
  );
},  compressionRatio: (b: Uint8Array) => symbols.rust_compression_ratio(ptr(b), b.byteLength) as number,

  // String
  htmlEscape:     (b: Uint8Array) => callOut(symbols.rust_html_escape, b.byteLength * 6 + 64, ptr(b), b.byteLength),
  slugify:        (b: Uint8Array) => callOut(symbols.rust_slugify, b.byteLength + 64, ptr(b), b.byteLength),
  templateRender: (t: Uint8Array, d: Uint8Array) => callOut(symbols.rust_template_render, 256 * 1024, ptr(t), t.byteLength, ptr(d), d.byteLength),
  regexMatch:     (p: Uint8Array, t: Uint8Array) => symbols.rust_regex_match(ptr(p), p.byteLength, ptr(t), t.byteLength) as number,
  regexReplace:   (p: Uint8Array, r: Uint8Array, t: Uint8Array) => callOut(symbols.rust_regex_replace, 256 * 1024, ptr(p), p.byteLength, ptr(r), r.byteLength, ptr(t), t.byteLength),
  trim:           (b: Uint8Array) => callOut(symbols.rust_trim, b.byteLength + 64, ptr(b), b.byteLength),
  caseConvert:    (b: Uint8Array, m: number) => callOut(symbols.rust_case_convert, b.byteLength * 4 + 64, ptr(b), b.byteLength, m),

  // Data processing
  jsonSortBy:    (b: Uint8Array, k: Uint8Array, d: number) => callOut(symbols.rust_json_sort_by, b.byteLength * 2 + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength, d),
  jsonPaginate:  (b: Uint8Array, pg: number, pp: number) => callOut(symbols.rust_json_paginate, b.byteLength + 4096, ptr(b), b.byteLength, pg, pp),
  jsonFilter:    (b: Uint8Array, k: Uint8Array, v: Uint8Array) => callOut(symbols.rust_json_filter, b.byteLength + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength, ptr(v), v.byteLength),
  jsonAggregate: (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_aggregate, 4096, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonGroupBy:   (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_group_by, b.byteLength * 2 + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonDedup:     (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_dedup, b.byteLength + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),

  // Caching
  rateLimitCheck: (sp: any, sl: number, cap: number, rr: number, now: number, cost: number) => symbols.rust_rate_limit_check(sp, sl, cap, rr, now, cost) as number,
  etagGenerate:   (b: Uint8Array) => callOut(symbols.rust_etag_generate, 64, ptr(b), b.byteLength),
  etagCheck:      (e: Uint8Array, h: Uint8Array) => symbols.rust_etag_check(ptr(e), e.byteLength, ptr(h), h.byteLength) as number,

  // HTTP response
  httpResponseBuild: (st: number, body: Uint8Array, ct: Uint8Array, eh: Uint8Array) => {
    const out = new Uint8Array(body.byteLength + 4096);
    const w = symbols.rust_http_response_build(st, ptr(body), body.byteLength, ptr(ct), ct.byteLength, ptr(eh), eh.byteLength, ptr(out), out.byteLength) as bigint;
    if (w < 0) throw new Error(`FFI failed: ${w}`);
    return out.slice(0, Number(w));
  },
  errorResponse: (st: number, msg: Uint8Array, code: Uint8Array) => callOut(symbols.rust_error_response, 4096, st, ptr(msg), msg.byteLength, ptr(code), code.byteLength),

  // CORS & security
  corsHeaders:     (o: Uint8Array, a: Uint8Array, m: Uint8Array, ma: number) => callOut(symbols.rust_cors_headers, 4096, ptr(o), o.byteLength, ptr(a), a.byteLength, ptr(m), m.byteLength, ma),
  securityHeaders: () => callOut(symbols.rust_security_headers, 4096),

  // WebSocket
  wsFrameParse: (b: Uint8Array) => callOut(symbols.rust_ws_frame_parse, 4096, ptr(b), b.byteLength),
  wsFrameBuild: (op: number, p: Uint8Array) => callOut(symbols.rust_ws_frame_build, p.byteLength + 16, op, ptr(p), p.byteLength),
  wsAcceptKey:  (k: Uint8Array) => callOut(symbols.rust_ws_accept_key, 128, ptr(k), k.byteLength),

  // MIME
  mimeFromExtension: (e: Uint8Array) => callOut(symbols.rust_mime_from_extension, 256, ptr(e), e.byteLength),
  contentNegotiate:  (a: Uint8Array, av: Uint8Array) => callOut(symbols.rust_content_negotiate, 256, ptr(a), a.byteLength, ptr(av), av.byteLength),

  // Logging
  logFormat:       (l: Uint8Array, m: Uint8Array, c: Uint8Array, r: Uint8Array) => callOut(symbols.rust_log_format, 64 * 1024, ptr(l), l.byteLength, ptr(m), m.byteLength, ptr(c), c.byteLength, ptr(r), r.byteLength),
  histogramBucket: (d: number) => symbols.rust_histogram_bucket(d) as number,

  // Path
  pathNormalize: (b: Uint8Array) => callOut(symbols.rust_path_normalize, 4096, ptr(b), b.byteLength),
  pathIsSafe:    (b: Uint8Array) => symbols.rust_path_is_safe(ptr(b), b.byteLength) as number,
  pathJoin:      (base: Uint8Array, seg: Uint8Array) => callOut(symbols.rust_path_join, 4096, ptr(base), base.byteLength, ptr(seg), seg.byteLength),

  // Search
  binarySearch:       (b: Uint8Array, t: number) => symbols.rust_binary_search(ptr(b), b.byteLength, t) as bigint,
  textSearchCount:    (t: Uint8Array, term: Uint8Array) => symbols.rust_text_search_count(ptr(t), t.byteLength, ptr(term), term.byteLength) as bigint,
  invertedIndexBuild: (b: Uint8Array) => callOut(symbols.rust_inverted_index_build, 2 * 1024 * 1024, ptr(b), b.byteLength),

  // Math
  crc32:       (b: Uint8Array) => symbols.rust_crc32(ptr(b), b.byteLength) as number,
  fnv1a64:     (b: Uint8Array) => symbols.rust_fnv1a_64(ptr(b), b.byteLength) as bigint,
  itoa:        (v: number) => callOut(symbols.rust_itoa, 64, v),
  atoi:        (b: Uint8Array) => symbols.rust_atoi(ptr(b), b.byteLength) as bigint,
  formatBytes: (n: number) => callOut(symbols.rust_format_bytes, 64, n),

  // Pipeline
  jsonPipeline: (d: Uint8Array, ops: Uint8Array) => callOut(symbols.rust_json_pipeline, d.byteLength * 2 + 4096, ptr(d), d.byteLength, ptr(ops), ops.byteLength),

  // Connection
  parseHost:        (b: Uint8Array) => callOut(symbols.rust_parse_host, 4096, ptr(b), b.byteLength),
  urlBuild:         (s: Uint8Array, h: Uint8Array, p: number, path: Uint8Array, q: Uint8Array) => callOut(symbols.rust_url_build, 8192, ptr(s), s.byteLength, ptr(h), h.byteLength, p, ptr(path), path.byteLength, ptr(q), q.byteLength),
  contentTypeParse: (b: Uint8Array) => callOut(symbols.rust_content_type_parse, 4096, ptr(b), b.byteLength),
};