// rust/task — off-thread task runtime ("castrum Tasks").
//
// A Bun-first answer to synchronous FFI: any CPU-bound native op that would
// otherwise freeze the JS thread is submitted as a task, runs on a dedicated
// pool thread (NOT the rayon batch pool), and resolves a JS promise through a
// BATCHED completion doorbell. See docs/RND-CONCURRENCY.md for the design and
// the measured Bun concurrency costs.
//
//   runtime.rs     pool lifecycle (once-per-process) + admission
//   completion.rs  result ring + batched thread-safe doorbell (the fast path)
//   ops.rs         op dispatch table + cancellation + panic containment
//   tests.rs       pool/ring/cancel/panic/doorbell unit tests
//
// Safety contract (identical to the rest of the C-ABI surface): every task body
// runs under `catch_unwind`; no `Mutex` is held across the doorbell call; the
// pool owns every input buffer after `submit` returns.

pub mod completion;
pub mod ops;
pub mod runtime;

#[cfg(test)]
mod tests;

pub use completion::{drain, pending, set_doorbell};
pub use ops::{mark_cancelled, STATUS_CANCELLED, STATUS_ERROR, STATUS_OK};
pub use runtime::{init, shutdown, threads};

/// Submit one task op with packed `args`, completing under `id`.
///
/// The pool auto-starts (default worker count) on first use, so callers do not
/// have to sequence `init` before `submit`. `args` is moved onto the worker.
pub fn submit_op(op: u32, args: Vec<u8>, id: u64) -> bool {
    runtime::submit(move || ops::execute_guarded(op, &args, id))
}

/// Submit one zero-copy task op: the pool thread writes its result DIRECTLY
/// into the caller's `out` buffer, and the completion body is the 8-byte LE
/// written length instead of the data. This removes the last full-size copy and
/// its allocation from the JS thread (see docs/RND-CONCURRENCY.md §7a).
///
/// # Safety
/// `out` must point to a buffer of at least `out_cap` bytes that stays alive
/// and is not touched by JS until the completion for `id` is drained.
pub fn submit_op_into(op: u32, args: Vec<u8>, id: u64, out: usize, out_cap: usize) -> bool {
    runtime::submit(move || unsafe {
        ops::execute_into_guarded(op, &args, id, out as *mut u8, out_cap)
    })
}

/// Submit one task whose PAYLOAD is read IN PLACE from the caller's buffer
/// (zero-copy INPUT): only the `hdr` header bytes are copied, so a large
/// argument never crosses the boundary. Without this, offloading a large
/// op pays a full-size copy on the JS thread — measured to make
/// `gzipCompress` of 24 MiB SLOWER than the synchronous built-in it replaces
/// (18.6 ms / 11.7 ms stall vs 5.6 ms), which is the opposite of the point.
///
/// # Safety
/// `data`/`data_len` must describe a readable region that stays alive and
/// unmodified until the completion for `id` is drained.
pub fn submit_slice_op(op: u32, hdr: Vec<u8>, data: usize, data_len: usize, id: u64) -> bool {
    runtime::submit(move || unsafe {
        ops::execute_slice_guarded(op, &hdr, data as *const u8, data_len, id)
    })
}
