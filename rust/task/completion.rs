// rust/task/completion.rs — the completion ring + batched doorbell.
//
// THE performance-critical piece. A pooled native thread never returns to JS
// directly; it pushes a `Completion` here and (at most once per batch) calls a
// single thread-safe trampoline so the JS thread can drain everything in ONE
// `castrum_task_drain` call. That amortizes the ~666 ns/crossing threadsafe
// callback over a whole batch instead of paying it per task.
//
// PACKED DRAIN LAYOUT (`out`):
//   [u32 count LE]
//   repeat count: [u64 id LE][u32 status][u32 len][len bytes]
//
// Needed-size convention (repo-wide): when `out` is too small the EXACT
// required byte count is returned and nothing is consumed, so JS allocates
// once and retries once. `0` means "nothing pending".
//
// NOTE (2026-09-11): a pointer-based zero-copy variant was prototyped and
// REVERTED — Bun 1.4.2's `toArrayBuffer` deallocator hook segfaults (see
// docs/RND-CONCURRENCY.md §7a). Zero-copy will instead pre-allocate the
// destination in JS and have the pool thread write into it directly.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

/// One finished task. `status`: 0 = ok, 1 = error, 2 = cancelled. `body` is
/// the result bytes, or the UTF-8 error message when `status != 0`.
pub struct Completion {
    pub id: u64,
    pub status: u32,
    pub body: Vec<u8>,
}

/// Completions waiting to be drained. Lazily initialised WITH capacity so a
/// burst (hundreds of tasks finishing together) does not pay repeated VecDeque
/// growth reallocations on the worker threads.
static RING: OnceLock<Mutex<VecDeque<Completion>>> = OnceLock::new();

/// One burst's worth of entries before the first realloc.
const RING_CAPACITY: usize = 256;

fn ring() -> &'static Mutex<VecDeque<Completion>> {
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(RING_CAPACITY)))
}
/// `true` while a doorbell call is outstanding, so N completions in a burst
/// wake JS once, not N times.
static ARMED: AtomicBool = AtomicBool::new(false);
/// Address of the thread-safe trampoline (`JSCallback({threadsafe:true}).ptr`).
static DOORBELL: AtomicUsize = AtomicUsize::new(0);

/// Register the doorbell trampoline. `0` disables it (poll-only mode).
pub fn set_doorbell(cb: usize) {
    DOORBELL.store(cb, Ordering::Release);
}

/// Push a completion and ring the doorbell at most once per armed window.
///
/// The ring lock is released BEFORE the trampoline is called: the JS callback
/// re-enters `drain`, which locks the ring again — holding it here would
/// deadlock the process.
pub fn push(c: Completion) {
    let should_ring = {
        let mut q = ring().lock();
        q.push_back(c);
        !ARMED.swap(true, Ordering::AcqRel)
    };
    if should_ring {
        let p = DOORBELL.load(Ordering::Acquire);
        if p != 0 {
            // SAFETY: `p` is a live `JSCallback` thread-safe trampoline whose
            // JS owner is held for the process lifetime by the task runtime.
            let f: extern "C" fn() = unsafe { std::mem::transmute(p) };
            f();
        }
    }
}

/// Drain every pending completion into `out`. Returns bytes written, `0` when
/// nothing is pending, or the exact required size when `out` is too small.
pub fn drain(out: &mut [u8]) -> usize {
    // Disarm FIRST so a completion pushed while we drain re-arms and rings the
    // bell instead of being stranded (see the module note).
    ARMED.store(false, Ordering::Release);
    let mut q = ring().lock();
    if q.is_empty() {
        return 0;
    }
    let mut needed = 4usize;
    for c in q.iter() {
        needed += 16 + c.body.len();
    }
    if out.len() < needed {
        return needed;
    }
    out[0..4].copy_from_slice(&(q.len() as u32).to_le_bytes());
    let mut off = 4usize;
    for c in q.iter() {
        out[off..off + 8].copy_from_slice(&c.id.to_le_bytes());
        out[off + 8..off + 12].copy_from_slice(&c.status.to_le_bytes());
        out[off + 12..off + 16].copy_from_slice(&(c.body.len() as u32).to_le_bytes());
        out[off + 16..off + 16 + c.body.len()].copy_from_slice(&c.body);
        off += 16 + c.body.len();
    }
    q.clear();
    needed
}

/// Completions waiting to be drained.
pub fn pending() -> u32 {
    ring().lock().len() as u32
}

/// Drop every pending completion (shutdown / test isolation). Bodies already
/// handed to JS by `drain_ptrs` are owned by JS and are NOT freed here.
pub fn clear() {
    ring().lock().clear();
    ARMED.store(false, Ordering::Release);
}
