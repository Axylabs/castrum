#![allow(clippy::not_unsafe_ptr_arg_deref)]

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// ── napi-rs addon modules ─────────────────────────────────────────
// Each module is exported to JS via #[napi]. Modules keep a pure-Rust
// core (no napi types in signatures) so they stay testable and
// composable; only the entry points use napi types.
pub mod bytes;
pub mod output;
pub mod method;
pub mod headers;
pub mod json_ser;
pub mod cors;
pub mod proxy;
pub mod terminal;

pub mod util;

// util.rs decomposition (task-focused modules; util.rs re-exports them)
pub mod threadpool;
pub mod packed;
pub mod batch_core;

pub mod ip_trust;
pub mod rate_limit;

pub mod json_schema;

pub mod cookie_parser;
pub mod hashing;
pub mod hmac_sha256;
pub mod http_parser;
pub mod json_ops;
pub mod json_patch_ops;
pub mod mime_lookup;
pub mod query_parser;
pub mod random_token;
pub mod url_codec;
pub mod validation;
pub mod websocket;

// Backend-framework feature modules (Phase A: auth & crypto)
pub mod jwt;
pub mod argon2;
pub mod aead;

// Backend-framework feature modules (Phase B: payload I/O)
pub mod compress;
pub mod multipart;

// Backend-framework feature modules (Phase C: output & streaming)
pub mod template;
pub mod ws_frames;
pub mod sse;

pub mod batch;

pub mod ingress_constants;

pub mod ingress;

// ── Unit tests (cargo test) ───────────────────────────────────────
#[cfg(test)]
mod test_support;

#[cfg(test)]
mod unit_tests;
