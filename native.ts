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
  rust_json_valid_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_json_sum_ids_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_http_parse_request_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_query_parse_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_cookie_parse_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_random_token_v2: {
    returns: FFIType.i64,
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
  },
  rust_ws_accept_key_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_json_patch_v2: {
    returns: FFIType.i64,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },
  rust_hmac_sha256_v2: {
    returns: FFIType.i64,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },
  rust_hmac_sha256_verify_v2: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },
  rust_route_match_v2: {
    returns: FFIType.i64,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },
  rust_validate_email_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_validate_uuid_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_validate_ipv4_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_validate_ipv6_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_crc32_v2: {
    returns: FFIType.u32,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_fnv1a64_v2: {
    returns: FFIType.u64,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_mime_from_extension_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_url_encode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_url_decode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
});

const symbols = lib.symbols as Record<string, any>;

function callOut(fn: (...a: any[]) => bigint, outSize: number, ...args: any[]): Uint8Array {
  let size = Math.max(1, outSize);
  const maxSize = 256 * 1024 * 1024;

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

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
  jsonValid: (b: Uint8Array) =>
    symbols.rust_json_valid_v2(ptr(b), b.byteLength) as number,

  jsonSumIds: (b: Uint8Array) =>
    symbols.rust_json_sum_ids_v2(ptr(b), b.byteLength) as bigint,

  httpParseRequest: (b: Uint8Array) =>
    callOut(symbols.rust_http_parse_request_v2, 64 * 1024, ptr(b), b.byteLength),

  queryParse: (b: Uint8Array) =>
    callOut(symbols.rust_query_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  cookieParse: (b: Uint8Array) =>
    callOut(symbols.rust_cookie_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  randomToken: (byteLen: number) =>
    callOut(symbols.rust_random_token_v2, byteLen * 2 + 64, byteLen),

  wsAcceptKey: (key: Uint8Array) =>
    callOut(symbols.rust_ws_accept_key_v2, 128, ptr(key), key.byteLength),

  jsonPatch: (doc: Uint8Array, patch: Uint8Array) =>
    callOut(
      symbols.rust_json_patch_v2,
      doc.byteLength + patch.byteLength + 4096,
      ptr(doc),
      doc.byteLength,
      ptr(patch),
      patch.byteLength,
    ),

  hmacSha256: (key: Uint8Array, data: Uint8Array) =>
    callOut(
      symbols.rust_hmac_sha256_v2,
      128,
      ptr(key),
      key.byteLength,
      ptr(data),
      data.byteLength,
    ),

  hmacSha256Verify: (key: Uint8Array, data: Uint8Array, sig: Uint8Array) =>
    symbols.rust_hmac_sha256_verify_v2(
      ptr(key),
      key.byteLength,
      ptr(data),
      data.byteLength,
      ptr(sig),
      sig.byteLength,
    ) as number,

  routeMatch: (pattern: Uint8Array, path: Uint8Array) =>
    callOut(
      symbols.rust_route_match_v2,
      4096,
      ptr(pattern),
      pattern.byteLength,
      ptr(path),
      path.byteLength,
    ),

  validateEmail: (b: Uint8Array) =>
    symbols.rust_validate_email_v2(ptr(b), b.byteLength) as number,

  validateUuid: (b: Uint8Array) =>
    symbols.rust_validate_uuid_v2(ptr(b), b.byteLength) as number,

  validateIpv4: (b: Uint8Array) =>
    symbols.rust_validate_ipv4_v2(ptr(b), b.byteLength) as number,

  validateIpv6: (b: Uint8Array) =>
    symbols.rust_validate_ipv6_v2(ptr(b), b.byteLength) as number,

  crc32: (b: Uint8Array) =>
    symbols.rust_crc32_v2(ptr(b), b.byteLength) as number,

  fnv1a64: (b: Uint8Array) =>
    symbols.rust_fnv1a64_v2(ptr(b), b.byteLength) as bigint,

  mimeFromExtension: (ext: Uint8Array) =>
    callOut(symbols.rust_mime_from_extension_v2, 256, ptr(ext), ext.byteLength),

  urlEncode: (b: Uint8Array) =>
    callOut(symbols.rust_url_encode_v2, b.byteLength * 3 + 64, ptr(b), b.byteLength),

  urlDecode: (b: Uint8Array) =>
    callOut(symbols.rust_url_decode_v2, b.byteLength + 64, ptr(b), b.byteLength),
};
