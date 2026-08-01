#![allow(clippy::not_unsafe_ptr_arg_deref)]

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// ── napi-rs addon modules ─────────────────────────────────────────
// Each module is exported to JS via #[napi]. Modules keep a pure-Rust
// core (no napi types in signatures) so they stay testable and
// composable; only the entry points use napi types.
pub mod output;
pub mod method;
pub mod headers;
pub mod json_ser;
pub mod cors;
pub mod proxy;
pub mod terminal;

pub mod util;

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

pub mod batch;

pub mod ingress_constants;

pub mod ingress;

// ── Unit tests (cargo test) ───────────────────────────────────────
#[cfg(test)]
mod unit_tests;
