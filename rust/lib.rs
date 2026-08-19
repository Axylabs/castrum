//! # castrum — Rust acceleration addon (napi-rs cdylib)
//!
//! One cdylib crate decomposed into domain folders (`util`, `http`, `crypto`,
//! `json`, `payload`, `ingress`). Modules keep a pure-Rust core (no napi types
//! in signatures) so they stay testable and composable; only the `#[napi]`
//! entry points use napi types. See the module map below and `docs/REPO_MAP.md`.

// The napi `Uint8Array` exposes its backing JS-buffer memory to Rust through
// `as_mut()`. The pattern is deliberate and audited: the caller-provided
// buffer is only borrowed for the duration of the call, aliasing with the
// input/body is checked via `slices_overlap`, and every writer is
// capacity-checked (`ingress/output.rs` panics on overflow, which napi
// converts to a JS 500). Do not widen the unsafe surface beyond these sites
// without re-auditing.

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// ── Module map ────────────────────────────────────────────────────
// rust/ is ONE cdylib crate, decomposed into domain folders. Modules keep a
// pure-Rust core (no napi types in signatures) so they stay testable and
// composable; only the entry points use napi types.
//
//   util/      shared infrastructure: bytes, packed iterators/writers,
//              batch/ (packed routing + napi) + batch_core (rayon helpers),
//              threadpool, validation. The `util::*` re-exports keep legacy
//              call sites.
//   http/      HTTP wire formats & parsing: headers, method, http/cookie/
//              query parsers, form, media_type, url_codec, url_join, etag,
//              http_date, accept, mime_lookup, multipart.
//   crypto/    auth & hashing: hmac_sha256, cookie_sign, csrf, jwt/ (token +
//              api), aead, argon2, base64, hashing (fnv/crc32/xxh3),
//              random_token.
//   json/      JSON & schema: json_ops, json_ser, patch/ (pointer/ops/engine/
//              api), json_schema (napi) + fast_schema (zero-DOM engine).
//   payload/   output & streaming: compress, sse, ws_frames, websocket,
//              template.
//   ingress/   the ingress pipeline: api.rs (Ingress class + IngressInner),
//              pipeline, options/time/packed submodules, cors, proxy,
//              ip_trust, rate_limit, terminal, output (single numeric layout
//              source), ingress_constants (napi projection of output).
//   ffi/       the C-ABI surface for bun:ffi, split by domain: util (shared
//              helpers), hashing, validators, crypto, jwt, http, payload,
//              json, rate_limit, ingress, route, probe (bench-only).
//
// Hot-path napi APIs (do not remove): ingress::handle_request_packed,
// ingress::handle_request_full_sync{,_into}, util::init_thread_pool,
// util::batch, ingress::ingress_constants.
pub mod crypto;
pub mod ffi;
pub mod http;
pub mod ingress;
pub mod json;
pub mod payload;
pub mod selection;
pub mod util;

// ── Unit tests (cargo test) ───────────────────────────────────────
#[cfg(test)]
mod test_support;

#[cfg(test)]
mod unit_tests;

#[cfg(test)]
mod proptest_suite;
