#![allow(clippy::not_unsafe_ptr_arg_deref)]

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// ── Pure Rust Core Library (no napi dependencies) ────────────────
// This is the new enterprise-grade core. All new code should go here.
// Use `rust_bench::core::*` for pure Rust access.
pub mod core;

// ── Legacy modules (unchanged, backward-compatible) ──────────────
// These still have napi-rs dependencies. They will be gradually
// migrated to wrap the core module.
pub mod output;
pub mod method;
pub mod headers;
pub mod json_ser;
pub mod cors;
pub mod proxy;
pub mod terminal;

pub mod runtime;
pub mod export;

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

pub mod async_tasks;
pub mod batch;

pub mod ingress_constants;

pub mod ingress;
pub mod ingress_async;
