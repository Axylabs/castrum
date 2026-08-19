// rust/ffi/rate_limit.rs — rate-limiter C-ABI exports.
//
// Both entries check a limit via the opaque `RateLimiter` handle; one hashes a
// `cstring` key in-engine, the other takes a pre-hashed i64 key. The packed
// verdict is written by the shared `write_rate_check` helper in `util.rs`.

use super::util::{panic_guard, write_rate_check};

/// RateLimiter: check a rate limit for a STRING key (hashed internally) at
/// `now_ms` via its opaque inner handle. Writes packed `[u8 allowed][u32
/// remaining LE][i64 reset_ms LE]` (13 bytes); needed-size convention; 0 =
/// null handle (real error).
///
/// `key` is a `bun:ffi` `cstring` ARG — the engine transcodes the JS rate-limit
/// key in-engine (JS does zero encode; the callee borrows via `CStr::from_ptr`).
/// Intended keys are IPs / route identifiers (text, no NUL); a key containing a
/// NUL would be truncated before hashing.
///
/// # Safety
/// `inner` must be a valid `RateLimiter` pointer from `inner_ptr()`, alive for
/// the call; `key` must be a valid NUL-terminated C string; `out` for writes up
/// to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_rate_limiter_check(
    inner: usize,
    key: *const std::os::raw::c_char,
    now_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || key.is_null() || out.is_null() {
        return 0;
    }
    let k = std::ffi::CStr::from_ptr(key).to_bytes();
    let hashed = crate::crypto::hashing::fast_hash_bytes(k);
    let (allowed, remaining, reset_ms) = panic_guard(
        || unsafe {
            crate::ingress::rate_limit::rate_limiter_check_core(
                inner as *const crate::ingress::rate_limit::RateLimiter,
                hashed,
                now_ms as u64,
            )
        },
        (false, 0, 0),
    );
    write_rate_check(allowed, remaining, reset_ms, out, out_cap)
}

/// RateLimiter: check a rate limit for a PRE-HASHED i64 key at `now_ms` via its
/// opaque inner handle (packed `[u8 allowed][u32 remaining LE][i64 reset_ms LE]`).
///
/// # Safety
/// `inner` must be a valid `RateLimiter` pointer from `inner_ptr()`, alive for
/// the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_rate_limiter_check_key(
    inner: usize,
    key: i64,
    now_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || out.is_null() {
        return 0;
    }
    let (allowed, remaining, reset_ms) = panic_guard(
        || unsafe {
            crate::ingress::rate_limit::rate_limiter_check_core(
                inner as *const crate::ingress::rate_limit::RateLimiter,
                key as u64,
                now_ms as u64,
            )
        },
        (false, 0, 0),
    );
    write_rate_check(allowed, remaining, reset_ms, out, out_cap)
}
