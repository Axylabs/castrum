use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::should_parallelize;
use xxhash_rust::xxh3::xxh3_64;

pub const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

// ── FNV-1a (byte-by-byte, correct per spec) ──────────────────────

/// FNV-1a in the "continue" style. FNV-1a is inherently byte-serial,
/// so we process each byte individually (this is the correct algorithm).
#[inline]
pub fn fnv1a64_continue(mut hash: u64, input: &[u8]) -> u64 {
    for &b in input {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// FNV-1a on a full byte slice, with fast path for small inputs.
#[inline]
pub fn fnv1a64_bytes(input: &[u8]) -> u64 {
    fnv1a64_continue(FNV_OFFSET_BASIS, input)
}

// ── XXHash wrappers ────────────────────────────────────────────────

#[inline]
pub fn fast_hash_bytes(input: &[u8]) -> u64 {
    xxh3_64(input)
}

// ── Napi exports ───────────────────────────────────────────────────

#[napi]
pub fn crc32(input: Uint8Array) -> u32 {
    crc32fast::hash(input.as_ref())
}

#[napi(js_name = "fnv1a64")]
pub fn fnv1a64(input: Uint8Array) -> u64 {
    fnv1a64_bytes(input.as_ref())
}

/// CRC32 batch — zero-alloc inline iteration (no Vec allocation from unpack).
#[napi]
pub fn crc32_batch_packed(input: Uint8Array) -> Result<Buffer> {
    let data = input.as_ref();
    if data.len() < 4 {
        return Err(Error::from_reason("packed buffer: missing count"));
    }

    let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;

    // Validate count early
    let max_possible = (data.len() - 4) / 4;
    if count > max_possible {
        return Err(Error::from_reason("packed buffer: impossible item count"));
    }

    let mut out = Vec::with_capacity(4 + count * 4);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + count * 4, 0);

    let out_slice = &mut out[4..];

    if should_parallelize(count, data.len().saturating_sub(4)) {
        use rayon::prelude::*;

        // Pre-compute offsets so we can iterate in parallel without allocations
        let offsets: Vec<(usize, usize)> = {
            let mut offsets = Vec::with_capacity(count);
            let mut offset = 4usize;
            for _ in 0..count {
                if offset + 4 > data.len() {
                    return Err(Error::from_reason("packed buffer: truncated length"));
                }
                let len = u32::from_le_bytes([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3],
                ]) as usize;
                offset += 4;
                let end = offset + len;
                if end > data.len() {
                    return Err(Error::from_reason("packed buffer: truncated item"));
                }
                offsets.push((offset, len));
                offset = end;
            }
            offsets
        };

        const CHUNK_ITEMS: usize = 256;

        out_slice
            .par_chunks_mut(CHUNK_ITEMS * 4)
            .enumerate()
            .for_each(|(ci, chunk)| {
                let num_items = chunk.len() / 4;
                let start = ci * CHUNK_ITEMS;
                for (i, item) in offsets[start..start + num_items].iter().enumerate() {
                    let crc = crc32fast::hash(&data[item.0..item.0 + item.1]);
                    chunk[i * 4..(i + 1) * 4].copy_from_slice(&crc.to_le_bytes());
                }
            });
    } else {
        let mut offset = 4usize;
        for i in 0..count {
            if offset + 4 > data.len() {
                return Err(Error::from_reason("packed buffer: truncated length"));
            }
            let len = u32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]) as usize;
            offset += 4;
            let end = offset + len;
            if end > data.len() {
                return Err(Error::from_reason("packed buffer: truncated item"));
            }
            let crc = crc32fast::hash(&data[offset..end]);
            out_slice[i * 4..(i + 1) * 4].copy_from_slice(&crc.to_le_bytes());
            offset = end;
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_known_vectors() {
        // Standard FNV-1a 64-bit test vectors.
        assert_eq!(fnv1a64_bytes(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64_bytes(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64_bytes(b"foobar"), 0x8594_4171_f739_67e8);
        // Continue-style matches one-shot.
        let h = fnv1a64_continue(fnv1a64_bytes(b"foo"), b"bar");
        assert_eq!(h, fnv1a64_bytes(b"foobar"));
    }

    #[test]
    fn crc32_known_vector() {
        assert_eq!(crc32fast::hash(b""), 0);
        // Standard CRC-32 check value.
        assert_eq!(crc32fast::hash(b"123456789"), 0xcbf4_3926);
        // The napi wrapper agrees.
        assert_eq!(crc32(Uint8Array::new(b"123456789".to_vec())), 0xcbf4_3926);
    }

    #[test]
    fn fnv1a_napi_agrees_with_core() {
        assert_eq!(
            fnv1a64(Uint8Array::new(b"foobar".to_vec())),
            fnv1a64_bytes(b"foobar")
        );
    }

    #[test]
    fn xxh3_stable_and_distinct() {
        let empty = fast_hash_bytes(b"");
        assert_eq!(empty, fast_hash_bytes(b""));
        assert_ne!(empty, fast_hash_bytes(b"a"));
        assert_eq!(fast_hash_bytes(b"castrum"), fast_hash_bytes(b"castrum"));
    }
}
