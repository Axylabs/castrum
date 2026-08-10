// rust/ingress/time.rs — Monotonic + wall-clock helpers.
//
// The rate limiter needs a stable monotonic clock plus a one-time wall offset
// so `rate_now_ms` returns a timestamp consistent across the process. The
// `OnceLock` statics are initialized lazily on first use.

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<Instant> = OnceLock::new();
static WALL_OFFSET_MS: OnceLock<i128> = OnceLock::new();

#[inline(always)]
pub(crate) fn monotonic_ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

#[inline(always)]
fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[inline(always)]
fn wall_offset_ms() -> i128 {
    *WALL_OFFSET_MS.get_or_init(|| wall_now_ms() as i128 - monotonic_ms() as i128)
}

/// Current time in ms since the unix epoch, derived from the monotonic clock.
#[inline(always)]
pub(crate) fn rate_now_ms() -> u64 {
    let v = monotonic_ms() as i128 + wall_offset_ms();
    if v < 0 {
        0
    } else {
        v as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_now_ms_is_sane_unix_time() {
        let now = rate_now_ms();
        // A plausible unix-epoch millis value: after ~2001, before ~year 3000.
        assert!(now > 978_307_200_000, "rate_now_ms too small: {now}");
        assert!(now < 32_000_000_000_000, "rate_now_ms too large: {now}");
    }

    #[test]
    fn monotonic_ms_is_non_decreasing() {
        let a = monotonic_ms();
        let b = monotonic_ms();
        assert!(b >= a, "monotonic clock went backwards");
    }

    #[test]
    fn rate_now_ms_is_stable_across_calls() {
        // Two calls back-to-back must agree within a wide window (both derive
        // from the same monotonic clock + wall offset).
        let a = rate_now_ms();
        let b = rate_now_ms();
        assert!(b >= a);
        assert!(b - a < 5_000);
    }
}
