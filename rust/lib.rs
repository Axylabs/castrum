#![allow(clippy::not_unsafe_ptr_arg_deref)]

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// ── Module map ────────────────────────────────────────────────────
// rust/ is ONE cdylib crate, decomposed into domain folders. Modules keep a
// pure-Rust core (no napi types in signatures) so they stay testable and
// composable; only the entry points use napi types.
//
//   util/      shared infrastructure: bytes, packed iterators/writers,
//              batch (napi) + batch_core (rayon helpers), threadpool,
//              validation. The `util::*` re-exports keep legacy call sites.
//   http/      HTTP wire formats & parsing: headers, method, http/cookie/
//              query parsers, form, media_type, url_codec, url_join, etag,
//              accept, mime_lookup, multipart.
//   crypto/    auth & hashing: hmac_sha256, cookie_sign, csrf, jwt, aead,
//              argon2, base64, hashing (fnv/crc32/xxh3), random_token.
//   json/      JSON & schema: json_ops, json_ser, json_patch_ops,
//              json_schema (napi) + fast_schema (zero-DOM engine).
//   payload/   output & streaming: compress, sse, ws_frames, websocket,
//              template.
//   ingress/   the ingress pipeline: mod.rs (Ingress + entry points),
//              options/time/packed submodules, cors, proxy, ip_trust,
//              rate_limit, terminal, output (single numeric layout source),
//              ingress_constants (napi projection of output).
//
// Hot-path napi APIs (do not remove): ingress::handle_request_packed,
// ingress::handle_request_full_sync{,_into}, util::init_thread_pool,
// util::batch, ingress::ingress_constants.
pub mod util;
pub mod http;
pub mod crypto;
pub mod json;
pub mod payload;
pub mod ingress;

// ── Unit tests (cargo test) ───────────────────────────────────────
#[cfg(test)]
mod test_support;

#[cfg(test)]
mod unit_tests;
