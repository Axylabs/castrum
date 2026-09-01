//! Shared infrastructure (no napi types in core signatures).
//
// Task-focused modules (no napi types in core signatures):
//   - bytes.rs        byte primitives (word-compare, hex, %XX decode, trim, cookie_pairs)
//   - packed.rs       zero-alloc packed iterators + byte writers
//   - batch/          packed aggregate batch helpers (core.rs routing + api.rs napi)
//   - batch_core.rs   generic rayon-parallel batch helpers
//   - threadpool.rs   rayon global pool init + parallelism heuristics
//   - validation.rs   email / UUID / IPv4 / IPv6 + batch fixed-width hex validators
//   - text.rs         text utilities (JS-RegExp metacharacter escaping)
//
// The `pub use` re-exports below keep existing `crate::util::*` call sites and
// the napi JS exports (`initThreadPool` / `rayonNumThreads`) working
// unchanged. Prefer importing from the specific submodules in new code.

pub mod batch;
pub mod batch_core;
pub mod bytes;
pub mod packed;
pub mod text;
pub mod threadpool;
pub mod validation;

// Re-exported byte primitives so existing callers keep working; the canonical
// implementations live in `bytes.rs`.
pub use self::bytes::trim_ascii_whitespace;

pub(crate) use self::batch::{run_bitset_batch, run_packed_batch, run_packed_batch_idx};
pub use self::batch_core::{count_batch, sum_batch_i64, validation_bitset_chunked};
pub use self::packed::{
    ensure_capacity, run_packed_into, slices_overlap, total_bytes, unpack, write_bitset_batch_into,
    write_bytes, write_bytes_lowercase, write_sum_batch_into, write_u32_batch_into, write_u32_le,
};
pub use self::threadpool::{init_thread_pool, rayon_num_threads, should_parallelize};
