// rust/core/mod.rs — Pure Rust core module declarations
//
// This module contains all runtime-agnostic business logic with zero
// dependencies on napi-rs. It can be compiled standalone or consumed
// by any Rust runtime (napi, CLI, wasm, etc.).

// ── Core types and utilities ────────────────────────────────────────
pub mod types;
pub mod prelude;
pub mod util;

// ── HTTP primitives ─────────────────────────────────────────────────
pub mod method;
pub mod headers;
pub mod proxy;
pub mod output;
pub mod terminal;

// ── Parsers ─────────────────────────────────────────────────────────
pub mod cookie_parser;
pub mod query_parser;
pub mod http_parser;

// ── Validation ──────────────────────────────────────────────────────
pub mod validation;

// ── JSON processing ─────────────────────────────────────────────────
pub mod json_ser;
pub mod json_ops;
pub mod json_patch_ops;
pub mod json_schema;

// ── Cryptography ────────────────────────────────────────────────────
pub mod hashing;
pub mod hmac_sha256;
pub mod random_token;
pub mod url_codec;

// ── Networking ──────────────────────────────────────────────────────
pub mod ip_trust;
pub mod mime_lookup;
pub mod websocket;

// ── Rate limiting ───────────────────────────────────────────────────
pub mod rate_limit;
pub mod cors;

// ── Ingress pipeline ────────────────────────────────────────────────
pub mod pipeline;

// ── Runtime abstraction ─────────────────────────────────────────────
pub mod runtime;
