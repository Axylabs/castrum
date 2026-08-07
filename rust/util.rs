// rust/util.rs — Re-export shim for the util split.
//
// The former grab-bag module is decomposed into task-focused modules:
//   - threadpool.rs   rayon global pool init + parallelism heuristics
//   - packed.rs       zero-alloc packed iterators + byte writers
//   - batch_core.rs   generic rayon-parallel batch helpers
//
// This shim re-exports everything so existing `crate::util::*` call sites and
// the napi JS exports (`initThreadPool` / `rayonNumThreads`) keep working
// unchanged. Prefer importing from the specific new modules in new code.

// Re-exported byte primitives so existing callers keep working; the canonical
// implementations live in `bytes.rs`.
pub use crate::bytes::{hex_val, trim_ascii_whitespace};

pub use crate::batch_core::{count_batch, sum_batch_i64, validation_bitset_chunked};
pub use crate::packed::{
    ensure_capacity, read_u32_le, run_packed_into, slices_overlap, total_bytes, unpack,
    write_bytes, write_bytes_lowercase, write_u32_le, PackedIter, VecWriter,
};
pub use crate::threadpool::{init_thread_pool, rayon_num_threads, should_parallelize};
