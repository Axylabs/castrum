// rust/ffi/task.rs — C-ABI exports for the off-thread task runtime.
//
// Eight symbols, all thin: the pool/ring/ops live in `rust/task/`. `submit`
// COPIES the packed args onto the worker (the JS caller's pooled buffer is
// released as soon as submit returns), and `drain` follows the repo-wide
// needed-size convention so JS grows once and retries once.

use std::slice;

use super::util::panic_guard;
use crate::task;

/// Start the pool with `threads` workers (0 → runtime default).
/// Returns `0` started, `1` already running, `2` internal error.
#[no_mangle]
pub extern "C" fn castrum_task_init(threads: u32) -> u32 {
    panic_guard(|| task::init(Some(threads)), 2)
}

/// Submit `op` with `args_len` packed arg bytes, completing under `task_id`.
/// Returns `1` accepted, `0` rejected (null args with a non-zero length).
///
/// # Safety
/// `args` must be valid for reads of `args_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_task_submit(
    op: u32,
    args: *const u8,
    args_len: usize,
    task_id: usize,
) -> u32 {
    if args.is_null() && args_len != 0 {
        return 0;
    }
    let owned: Vec<u8> = if args_len == 0 {
        Vec::new()
    } else {
        slice::from_raw_parts(args, args_len).to_vec()
    };
    u32::from(task::submit_op(op, owned, task_id as u64))
}

/// Drain finished tasks into `out` (packed `[u32 count][entry…]`).
/// Returns bytes written, `0` when nothing is pending, or the EXACT required
/// size when `out` is too small (nothing is consumed in that case).
///
/// # Safety
/// `out` must be valid for writes of `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_task_drain(out: *mut u8, out_cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    panic_guard(|| task::drain(slice::from_raw_parts_mut(out, out_cap)), 0)
}

/// Completions waiting to be drained.
#[no_mangle]
pub extern "C" fn castrum_task_pending() -> u32 {
    task::pending()
}

/// Submit an op that writes its result DIRECTLY into `out` (zero-copy output):
/// the completion body is the 8-byte LE written length, not the data, so JS
/// resolves a view of the buffer it already owns. A too-small `out` completes
/// with status 3 (TOO_SMALL) and the exact required size as the body; status 4
/// (UNSUPPORTED) means the op has no `_into` form and the caller should fall
/// back to `castrum_task_submit`.
///
/// Returns `1` accepted, `0` rejected.
///
/// # Safety
/// `args` must be valid for reads of `args_len` bytes. `out` must be valid for
/// writes of `out_cap` bytes and must stay alive (and untouched by JS) until the
/// completion for `task_id` is drained.
#[no_mangle]
pub unsafe extern "C" fn castrum_task_submit_out(
    op: u32,
    args: *const u8,
    args_len: usize,
    task_id: usize,
    out: *mut u8,
    out_cap: usize,
) -> u32 {
    if (args.is_null() && args_len != 0) || out.is_null() || out_cap == 0 {
        return 0;
    }
    let owned: Vec<u8> = if args_len == 0 {
        Vec::new()
    } else {
        slice::from_raw_parts(args, args_len).to_vec()
    };
    u32::from(task::submit_op_into(
        op,
        owned,
        task_id as u64,
        out as usize,
        out_cap,
    ))
}

/// Mark `task_id` cancelled. Returns `1` when newly marked, `0` otherwise.
#[no_mangle]
pub extern "C" fn castrum_task_cancel(task_id: usize) -> u32 {
    u32::from(task::mark_cancelled(task_id as u64))
}

/// Submit an op whose PAYLOAD is read IN PLACE from the caller's buffer
/// (zero-copy INPUT). Only the `hdr_len` header bytes are copied, so a large
/// argument never crosses the boundary — without this, offloading a big
/// compression costs a full-size copy on the JS thread and measured WORSE than
/// the synchronous built-in (docs/RND-CONCURRENCY.md §7b).
///
/// Returns `1` accepted, `0` rejected.
///
/// # Safety
/// `hdr` must be valid for reads of `hdr_len` bytes. `data` must be valid for
/// reads of `data_len` bytes and must stay alive (and unmodified by JS) until
/// the completion for `task_id` is drained.
#[no_mangle]
pub unsafe extern "C" fn castrum_task_submit_slice(
    op: u32,
    hdr: *const u8,
    hdr_len: usize,
    data: *const u8,
    data_len: usize,
    task_id: usize,
) -> u32 {
    if (hdr.is_null() && hdr_len != 0) || (data.is_null() && data_len != 0) {
        return 0;
    }
    // The header is small, so copying it keeps the caller free to reuse a
    // scratch buffer; the payload is never copied.
    let owned = if hdr_len == 0 {
        Vec::new()
    } else {
        slice::from_raw_parts(hdr, hdr_len).to_vec()
    };
    u32::from(task::submit_slice_op(
        op,
        owned,
        data as usize,
        data_len,
        task_id as u64,
    ))
}

/// Register the thread-safe doorbell trampoline address (`0` disables it).
/// Returns `1` on success.
///
/// # Safety
/// `cb` must be a live `void()` C trampoline that is safe to call from any
/// thread (a `bun:ffi` `JSCallback({ threadsafe: true }).ptr`).
#[no_mangle]
pub extern "C" fn castrum_task_set_doorbell(cb: *const std::os::raw::c_void) -> u32 {
    task::set_doorbell(cb as usize);
    1
}

/// Stop the pool and drop pending completions. Returns `0`.
#[no_mangle]
pub extern "C" fn castrum_task_shutdown() -> u32 {
    task::shutdown();
    task::completion::clear();
    0
}

/// Configured pool worker count (0 before the pool starts).
#[no_mangle]
pub extern "C" fn castrum_task_threads() -> u32 {
    task::threads()
}
