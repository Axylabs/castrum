// rust/util/threadpool.rs — Rayon global thread-pool initialization + parallelism.
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

/// Read the first set env var among `preferred` and its legacy aliases.
///
/// Centralizes the `CASTRUM_*` + legacy `RUST_BENCH_*` alias chains (mirrors
/// `src/shared/env.ts` on the TS side) so the chains can never drift apart.
fn read_env(preferred: &str, legacy: &[&str]) -> Option<String> {
    std::env::var(preferred)
        .ok()
        .or_else(|| legacy.iter().find_map(|key| std::env::var(key).ok()))
}

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
        let max_threads = read_env(
            "CASTRUM_MAX_RAYON_THREADS",
            &["RUST_BENCH_MAX_RAYON_THREADS"],
        )
        .and_then(|v| v.parse().ok())
        .unwrap_or(default_threads.max(1));

        let threads = rayon_threads
            .unwrap_or(preferred)
            .clamp(1, max_threads.max(1));

        let built = rayon::ThreadPoolBuilder::new()
            .num_threads(threads as usize)
            .stack_size(512 * 1024)
            .thread_name(|i| format!("castrum-rayon-{}", i))
            .start_handler(pin_rayon_thread)
            .build_global();
        match built {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("already been initialized") {
                    // Rayon's GLOBAL pool may already exist (e.g. a direct
                    // par_iter call auto-created it with defaults before our
                    // explicit init, such as an instance batch method). That
                    // is NOT an error — the pool is up and usable; our
                    // thread-count request is simply moot. Treat as success so
                    // the OnceLock is never poisoned by this benign race.
                    Ok(())
                } else {
                    Err(msg)
                }
            }
        }
    });

    match stored {
        Ok(()) => Ok(()),
        Err(msg) => Err(Error::from_reason(msg.clone())),
    }
}

#[cfg(target_os = "linux")]
fn pin_rayon_thread(id: usize) {
    if read_env("CASTRUM_PIN_CORES", &["RUST_BENCH_PIN_CORES"]).is_none() {
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

#[cfg(test)]
mod tests {
    #[test]
    fn init_thread_pool_is_idempotent() {
        // The rayon global pool is process-wide and first-call-wins. A second
        // init_thread_pool (after a prior init OR after a direct par_iter
        // auto-initialized rayon) must return Ok — never a poisoned error.
        let first = super::init_thread_pool(Some(2));
        let second = super::init_thread_pool(Some(2));
        assert!(first.is_ok(), "first init must succeed (got {first:?})");
        assert!(
            second.is_ok(),
            "second init must be a no-op, not an error (got {second:?})"
        );
    }
}
