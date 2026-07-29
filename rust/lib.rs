#![allow(clippy::not_unsafe_ptr_arg_deref)]

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

mod util;

mod ip_trust;
mod rate_limit;

mod json_schema;

mod cookie_parser;
mod hashing;
mod hmac_sha256;
mod http_parser;
mod json_ops;
mod json_patch_ops;
mod mime_lookup;
mod query_parser;
mod random_token;
mod url_codec;
mod validation;
mod websocket;

mod async_tasks;
mod batch;
mod ingress;