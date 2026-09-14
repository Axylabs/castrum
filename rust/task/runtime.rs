// rust/task/runtime.rs — process-wide off-thread task pool.
//
// A small, dependency-free, work-sharing pool: one condvar-gated queue and N
// worker threads. It is deliberately SEPARATE from the rayon global pool
// (`util/threadpool.rs`), which stays the batch `par_iter` executor — mixing
// long blocking offloads into rayon would starve batch parallelism.
//
// Lifecycle is first-init-wins (`OnceLock` + a `start()` CAS), so the FFI
// entry, a direct `submit`, and tests all converge on ONE pool per process.

use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// Jobs a worker takes per queue-lock acquisition. Amortizes the lock when many
/// tasks arrive at once (e.g. `Promise.all` over 2 000 items) instead of
/// re-locking per task.
const BATCH_POP: usize = 16;
/// Bounded spin before parking. A job that lands while a worker is between
/// "queue empty" and "park" is picked up WITHOUT a futex syscall — the common
/// case for a burst, and pure kernel-time saved.
const SPIN_ROUNDS: u32 = 64;
/// Idle park timeout. A bounded wait (instead of an indefinite one) means a
/// missed wakeup costs at most this much latency and can never wedge a worker.
const PARK_TIMEOUT: Duration = Duration::from_micros(200);

/// A unit of offloaded work. Owns its input bytes (`'static`, `Send`).
pub type Job = Box<dyn FnOnce() + Send + 'static>;

/// The process-wide task pool.
pub struct TaskPool {
    queue: Mutex<VecDeque<Job>>,
    cv: Condvar,
    running: AtomicBool,
    threads: AtomicU32,
}

static POOL: OnceLock<TaskPool> = OnceLock::new();

impl TaskPool {
    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            running: AtomicBool::new(false),
            threads: AtomicU32::new(0),
        }
    }

    /// Spawn `n` workers. Idempotent: the `running` CAS means only the first
    /// caller actually spawns, so a concurrent `init` + implicit `submit` race
    /// cannot double the pool.
    fn start(&'static self, n: usize) {
        if self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let n = n.max(1);
        self.threads.store(n as u32, Ordering::Release);
        for i in 0..n {
            let _ = std::thread::Builder::new()
                .name(format!("castrum-task-{i}"))
                .stack_size(512 * 1024)
                .spawn(move || {
                    pin_worker(i);
                    self.worker();
                });
        }
    }

    fn worker(&self) {
        // Reused across iterations so the batch path adds no per-task allocation.
        let mut batch: Vec<Job> = Vec::with_capacity(BATCH_POP);
        let mut spin = 0u32;
        loop {
            batch.clear();
            {
                let mut q = self.queue.lock();
                if let Some(first) = q.pop_front() {
                    batch.push(first);
                    // Only keep pulling while there is genuinely plenty of work
                    // left, so one greedy worker cannot starve its idle peers
                    // (e.g. 8 tasks on an 11-thread pool must fan out 1:1).
                    if q.len() >= self.threads.load(Ordering::Relaxed) as usize {
                        for _ in 1..BATCH_POP {
                            match q.pop_front() {
                                Some(job) => batch.push(job),
                                None => break,
                            }
                        }
                    }
                }
            }
            if !batch.is_empty() {
                spin = 0;
                for job in batch.drain(..) {
                    job();
                }
                continue;
            }
            if !self.running.load(Ordering::Acquire) {
                // Exit only once the queue is genuinely empty (a submit that
                // raced the shutdown flag still runs).
                if self.queue.lock().is_empty() {
                    break;
                }
                continue;
            }
            // Empty and running: spin briefly, then park with a short timeout.
            if spin < SPIN_ROUNDS {
                spin += 1;
                std::hint::spin_loop();
                continue;
            }
            spin = 0;
            let mut q = self.queue.lock();
            if q.is_empty() && self.running.load(Ordering::Acquire) {
                self.cv.wait_for(&mut q, PARK_TIMEOUT);
            }
        }
    }

    fn enqueue(&'static self, job: Job) {
        self.queue.lock().push_back(job);
        self.cv.notify_one();
    }

    fn shutdown(&self) {
        self.running.store(false, Ordering::Release);
        self.cv.notify_all();
    }
}

#[cfg(target_os = "linux")]
static TASK_CORE_IDS: OnceLock<Option<Vec<core_affinity::CoreId>>> = OnceLock::new();

/// Pin a worker to a dedicated core when `CASTRUM_TASK_PIN_CORES` (or the
/// shared `CASTRUM_PIN_CORES`) is set. Same rationale as the rayon pool's
/// pinning: stable cache locality and less scheduler migration, at the cost of
/// flexibility. Core 0 is skipped so the Bun event-loop thread keeps it.
#[cfg(target_os = "linux")]
fn pin_worker(id: usize) {
    if std::env::var("CASTRUM_TASK_PIN_CORES").is_err()
        && std::env::var("CASTRUM_PIN_CORES").is_err()
    {
        return;
    }
    let ids = TASK_CORE_IDS.get_or_init(core_affinity::get_core_ids);
    if let Some(ids) = ids {
        if ids.len() > 1 {
            let idx = 1 + (id % (ids.len() - 1));
            let _ = core_affinity::set_for_current(ids[idx]);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn pin_worker(_id: usize) {}

/// Default worker count: all cores but one (headroom for the Bun event loop),
/// overridable with `CASTRUM_TASK_THREADS`.
pub fn default_threads() -> usize {
    std::env::var("CASTRUM_TASK_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get().saturating_sub(1))
                .unwrap_or(1)
                .max(1)
        })
}

/// Start the pool with `threads` workers (`None`/`0` → {@link default_threads}).
///
/// Returns `0` when this call started the pool and `1` when it was already
/// running (both are success; the codebase keeps non-zero = error).
pub fn init(threads: Option<u32>) -> u32 {
    let p = POOL.get_or_init(TaskPool::new);
    if p.running.load(Ordering::Acquire) {
        return 1;
    }
    let n = threads
        .filter(|&t| t > 0)
        .map(|t| t as usize)
        .unwrap_or_else(default_threads);
    p.start(n);
    0
}

/// Enqueue `job`, auto-starting the pool on first use. Always accepted in v1
/// (the queue is unbounded; admission/backpressure is a later milestone).
pub fn submit<F>(job: F) -> bool
where
    F: FnOnce() + Send + 'static,
{
    let p = POOL.get_or_init(TaskPool::new);
    if !p.running.load(Ordering::Acquire) {
        let n = default_threads();
        p.start(n);
    }
    p.enqueue(Box::new(job));
    true
}

/// Configured worker count (0 before the pool starts).
pub fn threads() -> u32 {
    POOL.get_or_init(TaskPool::new)
        .threads
        .load(Ordering::Acquire)
}

/// Stop accepting and let idle workers exit. In-flight jobs still complete.
pub fn shutdown() {
    if let Some(p) = POOL.get() {
        p.shutdown();
    }
}
