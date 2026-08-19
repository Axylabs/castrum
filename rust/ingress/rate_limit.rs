// rust/ingress/rate_limit.rs — sharded per-IP rate limiter + shared registry.

use crate::crypto::hashing::fast_hash_bytes;
use lru::LruCache;
use napi_derive::napi;
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

        let max_entries = max_entries
            .unwrap_or(DEFAULT_MAX_ENTRIES)
            .min(MAX_ENTRIES_CAP);
        let max_per_shard = (max_entries / SHARD_COUNT).max(64);

        // `max_per_shard` is clamped to >= 64 above, so this cannot fail.
        let cap = NonZeroUsize::new(max_per_shard).expect("max_per_shard is clamped to >= 64");

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

        let c = map.get_or_insert_mut(key, || Counter {
            window_start: now_ms,
            prev: 0,
            curr: 0,
        });

        advance_window(c, now_ms, window);

        let elapsed = now_ms.saturating_sub(c.window_start);
        let overlap = window.saturating_sub(elapsed.min(window));

        let weighted = ((c.prev as u128) * (overlap as u128) / (window as u128)) + (c.curr as u128);

        let reset = c.window_start.saturating_add(window);

        if weighted < self.limit as u128 {
            c.curr = c.curr.saturating_add(1);

            let remaining = (self.limit as u128).saturating_sub(weighted.saturating_add(1)) as u32;

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
// limiter (~100k LRU nodes at the default max_entries, ~MBs), so an
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
/// Default per-config entry budget (256 shards × ~390 nodes). Lowered from
/// ~1M so a default-configured limiter stays ~1 MB instead of tens of MB.
/// Rate limiting is opt-in; callers that need a larger budget can pass
/// `maxEntries` explicitly.
pub(crate) const DEFAULT_MAX_ENTRIES: usize = 100_000;

static SHARED_LIMITERS: OnceLock<Mutex<LruCache<LimiterKey, Arc<KeyedRateLimiter>>>> =
    OnceLock::new();

/// Return the process-wide shared limiter for the given configuration.
/// Instances with identical configuration share the same underlying limiter.
pub fn shared_limiter(
    limit: u32,
    window_ms: u32,
    max_entries: Option<usize>,
) -> std::result::Result<Arc<KeyedRateLimiter>, String> {
    let resolved = max_entries
        .unwrap_or(DEFAULT_MAX_ENTRIES)
        .min(MAX_ENTRIES_CAP);
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
        return Ok(existing.clone());
    }

    // Bounded registry: instead of SILENTLY evicting a live limiter (which
    // would split one logical rate budget across two limiters and reset
    // per-IP counters — a rate-limit bypass vector), refuse the (cap+1)th
    // distinct config. Callers should reuse an existing
    // (limit, window_ms, max_entries) configuration.
    if guard.len() >= MAX_SHARED_LIMITERS {
        return Err(format!(
            "castrum: too many distinct rate-limit configurations ({MAX_SHARED_LIMITERS}); \
             a shared limiter would be evicted and its per-IP budget reset. \
             Reuse an existing (limit, window_ms, max_entries) config."
        ));
    }

    let limiter = Arc::new(KeyedRateLimiter::new(limit, window_ms, Some(resolved)));
    guard.put(key, limiter.clone());
    Ok(limiter)
}

// ── Standalone native rate limiter ────────────────────────────────
// A napi wrapper over the same sharded fixed-window limiter the ingress
// pipeline uses, exposed as a plain class so ANY app can get native per-key
// rate limiting without mounting the full ingress pipeline. Each `RateLimiter`
// instance owns an independent budget (unlike the ingress shared registry,
// which dedupes by config — standalone instances are intentionally isolated).

/// Result of a rate-limit check for one key at a point in time.
#[napi(object)]
pub struct RateCheck {
    /// Whether the request is allowed.
    pub allowed: bool,
    /// Remaining requests in the current window (saturating).
    pub remaining: u32,
    /// Unix milliseconds when the window resets.
    pub reset_ms: i64,
}

/// Sharded fixed-window per-key rate limiter (fixed-window, weighted overlap).
#[napi]
pub struct RateLimiter {
    inner: Arc<KeyedRateLimiter>,
}

#[napi]
impl RateLimiter {
    #[napi(constructor)]
    pub fn new(limit: u32, window_ms: u32, max_entries: Option<u32>) -> Self {
        Self {
            inner: Arc::new(KeyedRateLimiter::new(
                limit,
                window_ms,
                max_entries.map(|v| v as usize),
            )),
        }
    }

    /// Opaque handle to the limiter state, for the `bun:ffi` C-ABI fast path
    /// (`castrum_rate_limiter_check*` in rust/ffi.rs). Only valid while THIS
    /// instance is alive; the JS wrapper holds the instance.
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        self as *const RateLimiter as u64
    }

    /// Check a rate limit for a string key (hashed internally) at `now_ms`.
    #[napi]
    pub fn check(&self, key: String, now_ms: f64) -> RateCheck {
        let outcome = self
            .inner
            .check_key(fast_hash_bytes(key.as_bytes()), now_ms as u64);
        RateCheck {
            allowed: outcome.allowed,
            remaining: outcome.remaining,
            reset_ms: outcome.reset_ms as i64,
        }
    }

    /// Check a rate limit for a pre-hashed i64 key at `now_ms`.
    #[napi]
    pub fn check_key(&self, key: i64, now_ms: f64) -> RateCheck {
        let outcome = self.inner.check_key(key as u64, now_ms as u64);
        RateCheck {
            allowed: outcome.allowed,
            remaining: outcome.remaining,
            reset_ms: outcome.reset_ms as i64,
        }
    }
}

/// C-ABI support: check a rate limit for a (possibly pre-hashed) key.
/// Returns `(allowed, remaining, reset_ms)`.
///
/// # Safety
/// `p` must be a valid `*const RateLimiter` from `inner_ptr`, alive for the
/// call (the JS wrapper holds the napi instance).
pub(crate) unsafe fn rate_limiter_check_core(
    p: *const RateLimiter,
    key: u64,
    now_ms: u64,
) -> (bool, u32, i64) {
    let this = &*p;
    let o = this.inner.check_key(key, now_ms);
    (o.allowed, o.remaining, o.reset_ms as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_limiter_blocks_after_limit() {
        let limiter = KeyedRateLimiter::new(2, 60_000, Some(1024));
        let now = 1_700_000_000_000u64;
        assert!(limiter.check_key(1, now).allowed);
        assert!(limiter.check_key(1, now).allowed);
        let third = limiter.check_key(1, now);
        assert!(!third.allowed);
        assert_eq!(third.remaining, 0);
        // A different key is unaffected.
        assert!(limiter.check_key(2, now).allowed);
    }

    #[test]
    fn standalone_limiter_resets_after_window() {
        let limiter = KeyedRateLimiter::new(1, 60_000, Some(1024));
        let now = 1_700_000_000_000u64;
        assert!(limiter.check_key(7, now).allowed);
        assert!(!limiter.check_key(7, now).allowed);
        // After two full windows the budget resets.
        let later = now + 2 * 60_000;
        assert!(limiter.check_key(7, later).allowed);
    }

    #[test]
    fn standalone_limiter_independent_buckets() {
        let a = KeyedRateLimiter::new(1, 60_000, Some(1024));
        let b = KeyedRateLimiter::new(1, 60_000, Some(1024));
        assert!(a.check_key(9, 1_700_000_000_000).allowed);
        // `b` is a fresh independent budget — not shared with `a`.
        assert!(b.check_key(9, 1_700_000_000_000).allowed);
    }

    // ── Cross-module parity (moved from unit_tests.rs) ─────────────

    #[test]
    fn rate_limit_allows_up_to_limit_within_window() {
        let rl = KeyedRateLimiter::new(5, 1000, None);
        let key = 42;

        for i in 0..5 {
            let o = rl.check_key(key, 100 + i as u64);
            assert!(o.allowed, "request {} should be allowed", i);
            let expected = (5 - i - 1) as u32;
            assert_eq!(o.remaining, expected, "remaining mismatch at request {}", i);
        }

        let denied = rl.check_key(key, 105);
        assert!(!denied.allowed, "6th request within window should be denied");
        assert_eq!(denied.remaining, 0);
    }

    #[test]
    fn rate_limit_denied_after_limit() {
        let rl = KeyedRateLimiter::new(2, 60_000, None);
        assert!(rl.check_key(1, 0).allowed);
        assert!(rl.check_key(1, 1).allowed);
        assert!(!rl.check_key(1, 2).allowed);
    }

    #[test]
    fn rate_limit_window_advances_and_recovers() {
        let rl = KeyedRateLimiter::new(2, 1000, None);
        let key = 7;

        assert!(rl.check_key(key, 0).allowed);
        assert!(rl.check_key(key, 1).allowed);
        assert!(!rl.check_key(key, 2).allowed);

        // New window: previous weight decays; at least one slot must open.
        let o = rl.check_key(key, 1001);
        assert!(o.allowed, "request after window rollover should be allowed");
        assert!(o.reset_ms > 1001, "reset should be in the future");
    }

    #[test]
    fn rate_limit_reset_ms_is_in_future() {
        let rl = KeyedRateLimiter::new(3, 5000, None);
        let o = rl.check_key(9, 1000);
        assert!(o.allowed);
        assert!(o.reset_ms > 1000);
    }

    #[test]
    fn rate_limit_zero_limit_denies_everything() {
        let rl = KeyedRateLimiter::new(0, 1000, None);
        let o = rl.check_key(1, 0);
        assert!(!o.allowed);
        assert_eq!(o.remaining, 0);
    }

    #[test]
    fn rate_limit_max_limit_allows_everything() {
        let rl = KeyedRateLimiter::new(u32::MAX, 1000, None);
        let o = rl.check_key(1, 0);
        assert!(o.allowed);
        assert_eq!(o.remaining, u32::MAX);
    }

    #[test]
    fn rate_limit_keys_are_independent() {
        let rl = KeyedRateLimiter::new(1, 1000, None);
        assert!(rl.check_key(1, 0).allowed);
        assert!(!rl.check_key(1, 1).allowed);
        assert!(rl.check_key(2, 1).allowed, "different key should have its own bucket");
    }

    #[test]
    fn rate_limit_seed_is_stable_per_instance() {
        let a = KeyedRateLimiter::new(10, 1000, None);
        let b = KeyedRateLimiter::new(10, 1000, None);
        // Seeds differ per instance (unique per limiter id) but are stable within one.
        assert_ne!(a.seed(), b.seed());
        assert_eq!(a.seed(), a.seed());
    }

    #[test]
    fn rate_limit_shared_limiter_is_shared_by_config() {
        use std::sync::Arc;

        let a = super::shared_limiter(100, 60_000, None).unwrap();
        let b = super::shared_limiter(100, 60_000, None).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "identical config must share one process-wide limiter");

        let c = super::shared_limiter(100, 60_000, Some(10_000)).unwrap();
        assert!(!Arc::ptr_eq(&a, &c), "different max_entries must not share a limiter");

        let d = super::shared_limiter(200, 60_000, None).unwrap();
        assert!(!Arc::ptr_eq(&a, &d), "different limit must not share a limiter");
    }

    #[test]
    fn rate_limit_shared_limiter_refuses_17th_distinct_config() {
        // The registry is BOUNDED (MAX_SHARED_LIMITERS = 16) and must never
        // SILENTLY evict a live limiter (eviction resets per-IP budgets — a
        // rate-limit bypass vector). Fill it with 16 distinct configs (starting
        // with the 4 the other shared_limiter tests already register, so this is
        // deterministic regardless of test order), then assert a 17th throws.
        let mut configs: Vec<(u32, u32, usize)> = vec![
            (100, 60_000, crate::ingress::rate_limit::DEFAULT_MAX_ENTRIES), // matches shared_limiter(100, 60_000, None)
            (100, 60_000, 10_000), // matches shared_limiter(100, 60_000, Some(10_000))
            (200, 60_000, crate::ingress::rate_limit::DEFAULT_MAX_ENTRIES), // matches shared_limiter(200, 60_000, None)
            (2, 60_000, crate::ingress::rate_limit::DEFAULT_MAX_ENTRIES), // matches shared_limiter(2, 60_000, None)
        ];
        for i in 0..12u32 {
            configs.push((300 + i, 60_000, 1000 + i as usize));
        }
        for &(limit, window, max_entries) in &configs {
            let _ = super::shared_limiter(limit, window, Some(max_entries))
                .expect("distinct config registers");
        }
        // Registry at capacity: a genuinely new config must error, not evict.
        let res = super::shared_limiter(500_000, 60_000, Some(123_456));
        let err = match res {
            Ok(_) => panic!("17th distinct config must be refused, not silently evicted"),
            Err(e) => e,
        };
        assert!(
            err.contains("too many distinct rate-limit configurations"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rate_limit_shared_limiter_shares_budget() {
        // Two instances with the same config share one bucket — a request consumed
        // via one instance must count against the other (prevents route-splitting
        // bypass).
        let a = super::shared_limiter(2, 60_000, None).unwrap();
        let b = super::shared_limiter(2, 60_000, None).unwrap();
        let key = 1234u64;

        assert!(a.check_key(key, 0).allowed);
        assert!(b.check_key(key, 1).allowed, "shared budget consumed by a");
        assert!(!a.check_key(key, 2).allowed, "budget must be exhausted across both instances");
    }
}
