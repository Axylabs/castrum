use napi::bindgen_prelude::*;
use napi_derive::napi;

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

/// CRC32 over a raw byte slice (pure core, shared by the napi boundary and
/// the pure-core unit tests).
#[inline]
pub fn crc32_bytes(input: &[u8]) -> u32 {
    crc32fast::hash(input)
}

#[napi]
pub fn crc32(input: Uint8Array) -> u32 {
    crc32_bytes(input.as_ref())
}

#[napi(js_name = "fnv1a64")]
pub fn fnv1a64(input: Uint8Array) -> u64 {
    fnv1a64_bytes(input.as_ref())
}

/// XXH3-64 over raw bytes. High-throughput non-cryptographic hash; the same
/// core the ingress IP-trust hasher uses. Exposed publicly so callers can
/// race it against `Bun.hash.xxHash3` — see docs/bun-builtins-decision-matrix.md.
#[napi]
pub fn xxh3(input: Uint8Array) -> u64 {
    fast_hash_bytes(input.as_ref())
}

/// CRC32 batch — delegates to the shared packed-u32 writer (same wire format
/// as the `_into` variant; validation + parallelism live in
/// `util::packed::write_u32_batch_into`, single source of truth).
#[napi]
pub fn crc32_batch_packed(input: Uint8Array) -> Result<Buffer> {
    let data = input.as_ref();
    let count = crate::util::packed::PackedIter::new(data)?.len();
    let mut out = vec![0u8; 4 + count.saturating_mul(4)];
    let written = crate::util::write_u32_batch_into(data, &mut out, crc32_bytes)?;
    out.truncate(written);
    Ok(Buffer::from(out))
}

/// Reusable-output CRC32 batch: writes `[u32 count][u32…]` into `output` and
/// returns bytes written. Wire format is byte-identical to
/// [`crc32_batch_packed`]; the JS loader uses this with a pooled buffer.
#[napi]
pub fn crc32_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_u32_batch_into(data, out, crc32_bytes)
    })
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

    #[test]
    fn xxh3_napi_agrees_with_core() {
        let input = b"castrum xxh3 known-vector check 0123456789";
        assert_eq!(
            xxh3(Uint8Array::new(input.to_vec())),
            fast_hash_bytes(input)
        );
        // Deterministic across calls on the same bytes.
        assert_eq!(
            xxh3(Uint8Array::new(input.to_vec())),
            xxh3(Uint8Array::new(input.to_vec()))
        );
    }
}
