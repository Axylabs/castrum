// rust/threadpool.rs — Rayon global thread-pool initialization + parallelism.
//
// The rayon pool is process-wide and initialized exactly once (OnceLock). This
// module owns the pool lifecycle and the "should we parallelize?" heuristic;
// the generic batch helpers in `batch_core.rs` and the feature modules route
// their parallel work through `should_parallelize`.

use napi::{Error, Result};
use napi_derive::napi;
use std::sync::OnceLock;

static RAYON_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

#[cfg(target_os = "linux")]
static CORE_IDS: OnceLock<Option<Vec<core_affinity::CoreId>>> = OnceLock::new();

#[napi]
pub fn init_thread_pool(rayon_threads: Option<u32>) -> Result<()> {
    let stored = RAYON_INIT.get_or_init(|| {
        let default_threads = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(2);

        // Leave a little headroom for Bun/internal runtime threads.
        let preferred = default_threads.saturating_sub(1).max(1);

        // Do not hard-cap to 8 by default.
        // If you need a cap, set CASTRUM_MAX_RAYON_THREADS
        // (legacy alias: RUST_BENCH_MAX_RAYON_THREADS).
        let max_threads = std::env::var("CASTRUM_MAX_RAYON_THREADS")
            .ok()
            .or_else(|| std::env::var("RUST_BENCH_MAX_RAYON_THREADS").ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_threads.max(1));

        let threads = rayon_threads
            .unwrap_or(preferred)
            .clamp(1, max_threads.max(1));

        rayon::ThreadPoolBuilder::new()
            .num_threads(threads as usize)
            .stack_size(512 * 1024)
            .thread_name(|i| format!("castrum-rayon-{}", i))
            .start_handler(move |id| pin_rayon_thread(id))
            .build_global()
            .map_err(|e| e.to_string())
    });

    match stored {
        Ok(()) => Ok(()),
        Err(msg) => Err(Error::from_reason(msg.clone())),
    }
}

#[cfg(target_os = "linux")]
fn pin_rayon_thread(id: usize) {
    if std::env::var_os("CASTRUM_PIN_CORES").is_none()
        && std::env::var_os("RUST_BENCH_PIN_CORES").is_none()
    {
        return;
    }

    let ids = CORE_IDS.get_or_init(core_affinity::get_core_ids);
    if let Some(ids) = ids {
        if ids.len() > 1 {
            let idx = 1 + (id % (ids.len() - 1));
            let _ = core_affinity::set_for_current(ids[idx]);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn pin_rayon_thread(_id: usize) {}

#[napi]
pub fn rayon_num_threads() -> u32 {
    rayon::current_num_threads() as u32
}

/// Heuristic: parallelize a batch of `items` (totalling `bytes`) when the
/// workload is large enough to beat the rayon scheduling overhead.
#[inline(always)]
pub fn should_parallelize(items: usize, bytes: usize) -> bool {
    let threads = rayon::current_num_threads().max(1);
    items >= threads.saturating_mul(2048) || bytes >= threads.saturating_mul(1024 * 1024)
}
