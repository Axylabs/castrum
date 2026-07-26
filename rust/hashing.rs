// rust/hashing.rs — PRODUCTION BREAKING OPTIMIZED
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};
use xxhash_rust::xxh3::{xxh3_64, xxh3_64_with_seed, Xxh3};

pub const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

#[inline]
pub fn fnv1a64_continue(mut hash: u64, input: &[u8]) -> u64 {
    for b in input {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[inline]
pub fn fnv1a64_bytes(input: &[u8]) -> u64 {
    fnv1a64_continue(FNV_OFFSET_BASIS, input)
}

#[inline]
pub fn fast_hash_bytes(input: &[u8]) -> u64 {
    xxh3_64(input)
}

#[inline]
pub fn fast_hash_seeded(input: &[u8], seed: u64) -> u64 {
    xxh3_64_with_seed(input, seed)
}

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

#[napi]
pub fn crc32(input: Uint8Array) -> u32 {
    crc32fast::hash(input.as_ref())
}

#[napi(js_name = "fnv1a64")]
pub fn fnv1a64(input: Uint8Array) -> u64 {
    fnv1a64_bytes(input.as_ref())
}

/// Packed batch CRC32.
///
/// Input format:
///   [u32 count]
///   repeated:
///     [u32 len]
///     [bytes]
///
/// Output format:
///   [u32 count]
///   repeated:
///     [u32 crc]
#[napi]
pub fn crc32_batch_packed(input: Uint8Array) -> Result<Buffer> {
    let items = unpack(input.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 4);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;

        let crcs: Vec<u32> = items.par_iter().map(|item| crc32fast::hash(item)).collect();

        for crc in crcs {
            out.extend_from_slice(&crc.to_le_bytes());
        }
    } else {
        for item in items {
            let crc = crc32fast::hash(item);
            out.extend_from_slice(&crc.to_le_bytes());
        }
    }

    Ok(Buffer::from(out))
}