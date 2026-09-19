// rust/crypto/hashing.rs — FNV-1a / XXH3 checksums.

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

    /// Known-value xxh3-64 vectors that LOCK the spec output across both the
    /// short-input (< 240 B) and long-input (>= 240 B) regimes of the engine.
    /// Generated with `Bun.hash.xxHash3` (independent spec-compliant
    /// implementation). The 240/241 pair guards the engine's internal
    /// threshold: an implementation or length-handling regression that
    /// diverges only above it fails here even though small-input tests pass.
    /// (Perf note: the scalar core is FLAT ~30GB/s 64B→1MB — measured, no
    /// size pathology; see docs/bun-builtins-decision-matrix.md for why Bun
    /// still wins the consumer under Bun.)
    #[test]
    fn xxh3_vectors_lock_spec_across_simd_threshold() {
        // input: (i * 31 + 5) % 256 for i in 0..n (deterministic)
        const V: &[(usize, u64)] = &[
            (0, 0x2d06_8005_38d3_94c2),
            (1, 0x929e_358d_27ae_3ee2),
            (2, 0xf8a9_b018_ddb0_dc1a),
            (3, 0xea4f_94f7_8c69_f54e),
            (4, 0xc674_aba0_6059_22b7),
            (5, 0x988e_18b6_a130_77ac),
            (6, 0x19e7_8a37_d9eb_8365),
            (7, 0x4d32_b9b4_d45d_9319),
            (8, 0xad43_7729_e900_e521),
            (9, 0x2f54_64ee_70cc_cff9),
            (10, 0x97a1_114c_1cbf_45ae),
            (11, 0x2933_959d_e03b_8ce8),
            (12, 0x5cba_0687_e71c_0f12),
            (13, 0x5a27_1d93_20eb_cb8a),
            (14, 0xeb81_cf37_8320_b598),
            (15, 0xec7b_ee5b_893b_d5d5),
            (16, 0x0903_f58f_8225_3d8c),
            (17, 0x48a3_8615_d4ee_fb8b),
            (18, 0xb871_d958_cc11_dfa4),
            (19, 0xc6ed_7037_b89b_d206),
            (23, 0xd410_62e4_0171_ac46),
            (31, 0x4334_b263_9627_f197),
            (32, 0xebeb_3ba5_7ab1_edca),
            (33, 0x7ff1_7572_bd9e_70a9),
            (63, 0x504d_3e53_12aa_2db1),
            (64, 0xd8cc_034e_d06e_92f3),
            (65, 0x73c9_73e2_4eda_1cdc),
            (95, 0x45f6_3f33_cade_8c19),
            (96, 0x4c46_e758_08f2_74e9),
            (127, 0x1ed1_3eff_d01b_9402),
            (128, 0x05a1_567d_530f_961c),
            (191, 0xba5e_7dfd_d63d_7785),
            (192, 0x999d_b9f2_4d8c_ffcf),
            (238, 0xda80_d2d5_c7b9_397e),
            (239, 0xb0ca_9389_9a38_51d5),
            (240, 0xc502_31c4_c4c8_6a63),
            (241, 0xa7dc_042e_5a9f_6aa6),
            (255, 0x62c8_1de1_9704_658e),
            (256, 0x84f8_cedc_d725_6d1a),
            (512, 0xd4d7_d053_e788_d9ef),
            (1024, 0xdb4a_2f32_c2a5_bc38),
            (16384, 0xf04a_c437_8b21_4439),
            (262144, 0x6c36_c9dc_9aaf_20f0),
        ];
        let input =
            |n: usize| -> Vec<u8> { (0..n).map(|i| (i.wrapping_mul(31) + 5) as u8).collect() };
        for (n, want) in V {
            assert_eq!(
                fast_hash_bytes(&input(*n)),
                *want,
                "xxh3({n} bytes) — engine regime mismatch",
            );
        }
    }
}
