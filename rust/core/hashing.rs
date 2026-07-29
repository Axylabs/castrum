// rust/core/hashing.rs — Hashing utilities
// Pure Rust, no napi dependencies.

use xxhash_rust::xxh3::{xxh3_64, xxh3_64_with_seed, Xxh3};

pub const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

// ── FNV-1a ────────────────────────────────────────────────────────

/// FNV-1a in the "continue" style.
#[inline]
pub fn fnv1a64_continue(mut hash: u64, input: &[u8]) -> u64 {
    for &b in input {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// FNV-1a on a full byte slice.
#[inline]
pub fn fnv1a64_bytes(input: &[u8]) -> u64 {
    fnv1a64_continue(FNV_OFFSET_BASIS, input)
}

// ── XXHash wrappers ──────────────────────────────────────────────

/// Hash bytes using xxh3-64.
#[inline]
pub fn fast_hash_bytes(input: &[u8]) -> u64 {
    xxh3_64(input)
}

/// Hash bytes using xxh3-64 with a seed.
#[inline]
pub fn fast_hash_seeded(input: &[u8], seed: u64) -> u64 {
    xxh3_64_with_seed(input, seed)
}

/// Compute a composite cache key from method+path+query.
#[inline]
pub fn fast_hash_cache_key(method: &[u8], path: &[u8], query: &[u8]) -> u64 {
    let mut h = Xxh3::with_seed(0x9E37_79B9_7F4A_7C15);
    h.update(method);
    h.update(&[0]);
    h.update(path);
    h.update(&[0]);
    h.update(query);
    h.digest()
}

// ── Lazy hash ─────────────────────────────────────────────────────

/// A lazy hash value that can be computed once and cached.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct LazyHash(u64);

impl LazyHash {
    #[inline(always)]
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    #[inline(always)]
    pub fn get(&self) -> u64 {
        self.0
    }
}
