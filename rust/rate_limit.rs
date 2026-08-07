use crate::hashing::fast_hash_bytes;
use lru::LruCache;
use parking_lot::Mutex;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

static LIMITER_ID: AtomicU64 = AtomicU64::new(0);

struct Counter {
    window_start: u64,
    prev: u32,
    curr: u32,
}

#[repr(align(64))]
struct Shard {
    map: Mutex<LruCache<u64, Counter>>,
}

pub struct RateOutcome {
    pub allowed: bool,
    pub remaining: u32,
    pub reset_ms: u64,
}

/// Whether an ingress instance has rate limiting configured.
///
/// This enum replaces the old `bool` + `Option` pair so the code cannot
/// accidentally have `rate_enabled = true` with no limiter (or vice versa).
#[derive(Clone)]
pub(crate) enum RateLimiterState {
    /// Rate limiting is not configured.
    Disabled,
    /// Rate limiting is configured and ready to use.
    Enabled(Arc<KeyedRateLimiter>),
}

impl RateLimiterState {
    /// Returns the underlying limiter, or `None` when disabled.
    #[inline(always)]
    pub fn as_limiter(&self) -> Option<&KeyedRateLimiter> {
        match self {
            RateLimiterState::Disabled => None,
            RateLimiterState::Enabled(limiter) => Some(limiter.as_ref()),
        }
    }
}

pub struct KeyedRateLimiter {
    shards: Box<[Shard]>,
    shard_mask: usize,
    limit: u32,
    window_ms: u64,
    seed: u64,
}

impl KeyedRateLimiter {
    pub fn new(limit: u32, window_ms: u32, max_entries: Option<usize>) -> Self {
        const SHARD_COUNT: usize = 256;

        let id = LIMITER_ID.fetch_add(1, Ordering::Relaxed);
        let seed = fast_hash_bytes(&id.to_le_bytes());

        let max_entries = max_entries.unwrap_or(DEFAULT_MAX_ENTRIES).min(MAX_ENTRIES_CAP);
        let max_per_shard = (max_entries / SHARD_COUNT).max(64);

        let cap = NonZeroUsize::new(max_per_shard)
            .unwrap_or_else(|| NonZeroUsize::new(64).expect("64 is nonzero"));

        let shards = (0..SHARD_COUNT)
            .map(|_| Shard {
                map: Mutex::new(LruCache::new(cap)),
            })
            .collect();

        Self {
            shards,
            shard_mask: SHARD_COUNT - 1,
            limit,
            window_ms: window_ms.max(1) as u64,
            seed,
        }
    }

    #[inline(always)]
    pub fn seed(&self) -> u64 {
        self.seed
    }

    #[inline(always)]
    pub fn limit(&self) -> u32 {
        self.limit
    }

    pub fn check_key(&self, key: u64, now_ms: u64) -> RateOutcome {
        if self.limit == 0 {
            return RateOutcome {
                allowed: false,
                remaining: 0,
                reset_ms: now_ms.saturating_add(self.window_ms),
            };
        }

        if self.limit == u32::MAX {
            return RateOutcome {
                allowed: true,
                remaining: u32::MAX,
                reset_ms: now_ms.saturating_add(self.window_ms),
            };
        }

        let shard = &self.shards[(key as usize) & self.shard_mask];
        let mut map = shard.map.lock();

        let window = self.window_ms.max(1);

        let c = match map.get_mut(&key) {
            Some(c) => c,
            None => {
                map.put(
                    key,
                    Counter {
                        window_start: now_ms,
                        prev: 0,
                        curr: 0,
                    },
                );

                map.get_mut(&key).expect("rate limiter counter must exist after insert")
            }
        };

        advance_window(c, now_ms, window);

        let elapsed = now_ms.saturating_sub(c.window_start);
        let overlap = window.saturating_sub(elapsed.min(window));

        let weighted =
            ((c.prev as u128) * (overlap as u128) / (window as u128)) + (c.curr as u128);

        let reset = c.window_start.saturating_add(window);

        if weighted < self.limit as u128 {
            c.curr = c.curr.saturating_add(1);

            let remaining = (self.limit as u128)
                .saturating_sub(weighted.saturating_add(1)) as u32;

            RateOutcome {
                allowed: true,
                remaining,
                reset_ms: reset,
            }
        } else {
            RateOutcome {
                allowed: false,
                remaining: 0,
                reset_ms: reset,
            }
        }
    }
}

fn advance_window(c: &mut Counter, now_ms: u64, window: u64) {
    let elapsed = now_ms.saturating_sub(c.window_start);

    if elapsed < window {
        return;
    }

    let double_window = window.saturating_mul(2);

    if elapsed >= double_window {
        c.window_start = now_ms;
        c.prev = 0;
        c.curr = 0;
    } else {
        c.window_start = c.window_start.saturating_add(window);
        c.prev = c.curr;
        c.curr = 0;
    }
}

// ── Shared limiter registry ───────────────────────────────────────
// Rate limiting must be shared across all ingress instances/routes in the
// process, otherwise a client can bypass a per-IP limit by spreading requests
// across endpoints (each route would get its own independent bucket). All
// instances configured with the same (limit, window_ms, max_entries) share one
// process-wide limiter.
//
// The registry is BOUNDED: each distinct config materializes a full 256-shard
// limiter (~1M LRU nodes at the default max_entries, tens of MB), so an
// unbounded map would let many slightly-different configs balloon memory. We
// cap the number of retained configs (LRU eviction) and clamp max_entries.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct LimiterKey {
    limit: u32,
    window_ms: u32,
    max_entries: usize,
}

/// Maximum number of distinct rate-limit configs retained process-wide.
const MAX_SHARED_LIMITERS: usize = 16;
/// Upper clamp for `max_entries` (prevents a ~4 GB allocation from a bad input).
const MAX_ENTRIES_CAP: usize = 4_000_000;
/// Default per-config entry budget (256 shards × 4096 nodes).
const DEFAULT_MAX_ENTRIES: usize = 1_048_576;

static SHARED_LIMITERS: OnceLock<Mutex<LruCache<LimiterKey, Arc<KeyedRateLimiter>>>> =
    OnceLock::new();

/// Return the process-wide shared limiter for the given configuration.
/// Instances with identical configuration share the same underlying limiter.
pub fn shared_limiter(
    limit: u32,
    window_ms: u32,
    max_entries: Option<usize>,
) -> Arc<KeyedRateLimiter> {
    let resolved = max_entries.unwrap_or(DEFAULT_MAX_ENTRIES).min(MAX_ENTRIES_CAP);
    let key = LimiterKey {
        limit,
        window_ms,
        max_entries: resolved,
    };

    let map = SHARED_LIMITERS.get_or_init(|| {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(MAX_SHARED_LIMITERS).expect("MAX_SHARED_LIMITERS is nonzero"),
        ))
    });
    let mut guard = map.lock();

    if let Some(existing) = guard.get(&key) {
        return existing.clone();
    }

    let limiter = Arc::new(KeyedRateLimiter::new(limit, window_ms, Some(resolved)));
    guard.put(key, limiter.clone());
    limiter
}