import { FFIType } from "bun:ffi";

export const rustSymbols = {
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
  rust_router_create: {
    returns: FFIType.u64,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_router_match_id: {
    returns: FFIType.i64,
    args: [FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_router_match: {
    returns: FFIType.i64,
    args: [
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },

  rust_router_destroy: {
    returns: FFIType.i32,
    args: [FFIType.u64],
  },
  rust_url_encode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_url_decode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  }
} as const;

export type RustSymbolName = keyof typeof rustSymbols;