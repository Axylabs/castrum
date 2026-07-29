// rust/export.rs — Public composable API for downstream Rust consumers
// Re-exports all key functions with runtime-agnostic signatures.
// Use `rust_bench::export::*` to get all public APIs.

// ── Hashing ─────────────────────────────────────────────────────────
pub use crate::hashing::{
    fnv1a64_bytes,
    fnv1a64_continue,
    fast_hash_bytes,
    fast_hash_seeded,
    fast_hash_cache_key,
    LazyHash,
    FNV_OFFSET_BASIS,
    FNV_PRIME,
};

// ── JSON serialization ─────────────────────────────────────────────
pub use crate::json_ser::{
    json_escaped_len,
    write_json_escaped,
    cookie_json_into_slice,
    packed_pairs_to_json_into_slice,
    write_full_body_json,
};

// ── Query parsing ──────────────────────────────────────────────────
pub use crate::query_parser::{
    query_parse_packed_into_slice,
    query_parse_packed_vec,
};

// ── Cookie parsing ─────────────────────────────────────────────────
pub use crate::cookie_parser::{
    cookie_parse_packed_into_slice,
    cookie_parse_packed_vec,
};

// ── Headers ─────────────────────────────────────────────────────────
pub use crate::headers::HeaderRefs;

// ── HTTP Method ────────────────────────────────────────────────────
pub use crate::method::MethodKind;

// ── Validation ─────────────────────────────────────────────────────
pub use crate::validation::{
    validate_email_bytes,
    validate_uuid_bytes,
    validate_ipv4_bytes,
    validate_ipv6_bytes,
};

// ── Utilities ──────────────────────────────────────────────────────
pub use crate::util::{
    PackedIter,
    VecWriter,
    read_u32_le,
    trim_ascii_whitespace,
    hex_val,
    ensure_capacity,
    write_u32_le,
    write_bytes,
    should_parallelize,
    slices_overlap,
    cow_decode_url,
    validation_bitset_chunked,
    count_batch,
    sum_batch_i64,
};

// ── Runtime abstraction ────────────────────────────────────────────
pub use crate::runtime::{
    Runtime,
    NativeRuntime,
    JsonEscapeMode,
    KvPair,
};