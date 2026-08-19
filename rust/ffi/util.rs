// rust/ffi/util.rs — shared helpers for the C-ABI export surface.
//
// The per-thread state + panic containment every `castrum_*` export relies on:
// compiled-HMAC-key LRU, AEAD algorithm map, `catch_unwind` guard, and the
// per-thread cstring buffer. Kept together so the domain wrapper files
// (`crypto.rs`, `jwt.rs`, …) stay focused on their symbols.

use aws_lc_rs::aead::{AES_256_GCM, CHACHA20_POLY1305};
use aws_lc_rs::hmac;
use lru::LruCache;
use std::cell::RefCell;
use std::num::NonZeroUsize;
use std::slice;

/// Build the HMAC-SHA256 key used by the scalar HMAC/cookie/CSRF cores (the
/// same per-call construction the napi scalar fns use). Test-only reference
/// helper: the hot C-ABI fns go through `hmac_key_cached` below.
#[cfg(test)]
#[inline]
pub(crate) fn hmac_key(secret: &[u8]) -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, secret)
}

/// Capacity of the per-thread compiled-key LRU.
pub(crate) const HMAC_KEY_CACHE_CAP: usize = 16;

// Test-only hit counter proving the cache actually reuses compiled keys.
#[cfg(test)]
thread_local! {
    pub(crate) static HMAC_CACHE_HITS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// The cache itself is also test-visible (tests clear it to measure hit counts).
thread_local! {
    pub(crate) static HMAC_KEY_CACHE: RefCell<LruCache<Vec<u8>, hmac::Key>> = RefCell::new(
        LruCache::new(NonZeroUsize::new(HMAC_KEY_CACHE_CAP).expect("cap is nonzero")),
    );
}

/// Return a compiled HMAC-SHA256 key for `secret`, reusing a cached copy when
/// the same secret was used recently (per-thread LRU, cap 16).
#[inline]
pub(crate) fn hmac_key_cached(secret: &[u8]) -> hmac::Key {
    HMAC_KEY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(key) = cache.get(secret) {
            #[cfg(test)]
            HMAC_CACHE_HITS.with(|h| h.set(h.get() + 1));
            return key.clone();
        }
        let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
        cache.put(secret.to_vec(), key.clone());
        key
    })
}

/// Map an algorithm selector byte to the AEAD `Algorithm` (0 = AES-256-GCM,
/// 1 = ChaCha20-Poly1305) — mirrors `crate::crypto::aead::resolve_algorithm`.
#[inline]
pub(crate) fn aead_alg(alg: u8) -> Option<&'static aws_lc_rs::aead::Algorithm> {
    match alg {
        0 => Some(&AES_256_GCM),
        1 => Some(&CHACHA20_POLY1305),
        _ => None,
    }
}

/// Run a fallible native core under `catch_unwind`, returning `fallback` on a
/// panic.
///
/// The napi path relies on napi-rs wrapping every call in `catch_unwind` (a
/// panic becomes a JS exception/500). The raw C ABI (`bun:ffi`) has no such
/// guard, so a panic unwinding through an `extern "C"` frame is UB and kills
/// the whole Bun process (this is what happened under burst load in
/// `11-concurrent-burst`). Every `castrum_*` export that runs a fallible /
/// allocating core routes through this helper for parity: a panic becomes the
/// caller's error sentinel (`0` / `None`), never a process crash.
/// `AssertUnwindSafe` is required because the closures capture `&mut [u8]`
/// output slices.
#[inline]
pub(crate) fn panic_guard<T>(f: impl FnOnce() -> T, fallback: T) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(fallback)
}

/// Write the packed `[u8 allowed][u32 remaining LE][i64 reset_ms LE]` verdict;
/// returns bytes written or the exact required size (13) when `out_cap` is too
/// small. Never returns 0 on a valid call.
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
pub(crate) unsafe fn write_rate_check(
    allowed: bool,
    remaining: u32,
    reset_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if out_cap < 13 {
        return 13;
    }
    let o = slice::from_raw_parts_mut(out, 13);
    o[0] = u8::from(allowed);
    o[1..5].copy_from_slice(&remaining.to_le_bytes());
    o[5..13].copy_from_slice(&reset_ms.to_le_bytes());
    13
}

// ── cstring-returning writers (per-thread reused buffer) ─────────
// Bun's `cstring` FFI return type has the ENGINE clone the result string out
// of the returned pointer at the moment of the call (bun:ffi docs), so the JS
// side pays ZERO decode + ZERO allocation for these single-string outputs.
// The buffer is thread-local and reused across calls (same pattern as
// HMAC_KEY_CACHE above) — valid only until the next call on the same thread,
// which is all the engine needs (it clones synchronously at return).
thread_local! {
    static CSTR_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Write `write` into the per-thread buffer sized to `needed` (reused across
/// calls), null-terminate, and return the pointer. `null` = write error
/// (malformed input / crypto failure — the caller maps to a throw or sentinel).
pub(crate) fn cstring_return(
    needed: usize,
    write: impl FnOnce(&mut [u8]) -> Option<usize>,
) -> *const std::os::raw::c_char {
    CSTR_BUF.with(|cell| {
        let mut buf = cell.borrow_mut();
        if buf.len() < needed + 1 {
            buf.resize(needed + 1, 0);
        }
        let cap = buf.len() - 1;
        match write(&mut buf[..cap]) {
            Some(w) => {
                buf[w] = 0;
                buf.as_ptr() as *const std::os::raw::c_char
            }
            None => std::ptr::null(),
        }
    })
}

/// Read the bytes of a `cstring`-returning FFI symbol's result. The engine
/// cloned the string at the call, so the per-thread buffer reuse is safe here.
/// Test-only: the sole production consumer was the removed task-group dispatch
/// (`run_one_task`); remaining callers are in the C-ABI unit tests below.
#[cfg(test)]
pub(crate) unsafe fn cstr_bytes(p: *const std::os::raw::c_char) -> Option<Vec<u8>> {
    if p.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(p).to_bytes().to_vec())
}
