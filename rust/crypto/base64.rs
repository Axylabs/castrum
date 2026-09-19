// rust/crypto/base64.rs — base64 (standard/url-safe) + hex encode/decode.
//
// Uses the `base64` crate engines (Cargo dep already present). On the shipped
// targets (x86_64 / aarch64) the hot cores dispatch to the crate's
// runtime-detected SIMD engine (`engine::simd::Simd` — AVX2 / NEON kernels):
// payloads ≥ 64 B (decode) / ≥ 128 B (encode) go through the wide kernels,
// anything smaller falls back to the scalar engine internally, so both length
// regimes stay efficient and output stays byte-identical to the scalar path.
// Other targets keep the scalar `GeneralPurpose` engine (not a shipped
// castrum target — local dev / test builds only). The `Base64Codec`
// higher-order instance precompiles the alphabet/decoding configuration once
// in its constructor and reuses it across calls.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use base64::Engine as _;

/// Engine selection for a base64 call.
///
/// SIMD branch (x86_64 / aarch64 — every shipped castrum target): the
/// `engine::simd::Simd` engine detects AVX2 / NEON once at construction and
/// falls back to the scalar `GeneralPurpose` when the CPU (or a payload below
/// the 64 B decode / 128 B encode thresholds) doesn't benefit, so small
/// payloads keep the same fixed costs while large ones get wide kernels. The
/// `PAD` / `NO_PAD` `GeneralPurposeConfig` consts are the exact configs the
/// preconfigured scalar engines use, so the wire contract is unchanged.
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
mod engine_sel {
    use base64::engine::general_purpose::{NO_PAD, PAD};
    use base64::engine::simd::Simd;

    pub(super) type Engine = Simd;

    pub(super) fn engine(url_safe: bool, padding: bool) -> Simd {
        match (url_safe, padding) {
            (false, true) => Simd::standard(PAD),
            (false, false) => Simd::standard(NO_PAD),
            (true, true) => Simd::url_safe(PAD),
            (true, false) => Simd::url_safe(NO_PAD),
        }
    }
}

/// Scalar fallback (non-x86_64 / non-aarch64 targets only).
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
mod engine_sel {
    use base64::engine::general_purpose::*;

    pub(super) type Engine = GeneralPurpose;

    pub(super) fn engine(url_safe: bool, padding: bool) -> GeneralPurpose {
        match (url_safe, padding) {
            (false, true) => STANDARD,
            (false, false) => STANDARD_NO_PAD,
            (true, true) => URL_SAFE,
            (true, false) => URL_SAFE_NO_PAD,
        }
    }
}

use engine_sel::engine;

#[napi]
pub fn base64_encode(input: Uint8Array, url_safe: Option<bool>, padding: Option<bool>) -> Buffer {
    let out = engine(url_safe.unwrap_or(false), padding.unwrap_or(true)).encode(input.as_ref());
    Buffer::from(out.into_bytes())
}

#[napi]
pub fn base64_decode(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<Buffer> {
    engine(url_safe.unwrap_or(false), padding.unwrap_or(true))
        .decode(input.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn base64url_encode(input: Uint8Array) -> Buffer {
    Buffer::from(engine(true, false).encode(input.as_ref()).into_bytes())
}

#[napi]
pub fn base64url_decode(input: Uint8Array) -> Result<Buffer> {
    engine(true, false)
        .decode(input.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Base64-encode to raw bytes (no Buffer wrapping). Shared by the scalar and
/// packed-batch paths.
pub fn base64_encode_bytes(input: &[u8], url_safe: bool, padding: bool) -> Vec<u8> {
    engine(url_safe, padding).encode(input).into_bytes()
}

/// Base64-decode from raw bytes. Errors on invalid input. Shared by the scalar
/// and packed-batch paths.
pub fn base64_decode_bytes(input: &[u8], url_safe: bool, padding: bool) -> Result<Vec<u8>> {
    engine(url_safe, padding)
        .decode(input)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Base64url (RFC 7515 §2 — URL-safe alphabet, NO padding) encode to raw
/// bytes. The single shared source of truth for JWT segment encoding
/// (`crate::crypto::jwt`) and Ed25519 keypair serialization
/// (`crate::crypto::ed25519`) — keeps the url-safe alphabet defined in exactly
/// one place.
#[inline]
pub fn base64url_encode_bytes(data: &[u8]) -> Vec<u8> {
    engine(true, false).encode(data).into_bytes()
}

/// Base64url (RFC 7515 §2 — URL-safe alphabet, NO padding) decode from raw
/// bytes. Returns `None` on invalid UTF-8 or non-base64url input.
#[inline]
pub fn base64url_decode_bytes(data: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(data).ok()?;
    engine(true, false).decode(text).ok()
}

// ── hex ──────────────────────────────────────────────────────────
//
// Lowercase hex encode + case-insensitive decode. Encode goes through the
// `faster-hex` SIMD engine (runtime-dispatched SSE→AVX2; measured 4.3-18.9x
// faster than Buffer.toString("hex") at every size 64B→1MB, replacing the
// per-byte table loop that lost 0.30x; the 1KB outlier ~19x is Bun-side). Decode has TWO tiers:
//   - x86_64 + AVX2: our single-pass `hex_fast` kernel (validity mask + value
//     map in one vector pass, 64 chars/iteration, scalar fallback on any
//     invalid chunk). faster-hex decode does a separate validation scan +
//     decode pass (~5GB/s cap vs Buffer.from(s,"hex") ~10.5GB/s); the
//     single-pass kernel targets that class directly.
//   - everywhere else: faster-hex decode (SSE/scalar, validated).
// Both tiers are byte-identical to the HEX_VAL_LUT semantics — verified by
// exhaustive tests (all 256 bytes × encode, all 65,536 byte-pairs × decode,
// plus a length sweep across the 64-char chunk boundary).

/// Lowercase-hex encode (SIMD via `faster-hex`).
///
/// # Safety
///
/// Hex output is always ASCII (`HEX_LOWER` is a byte string of `0-9a-f`), so
/// the built `Vec<u8>` is valid UTF-8 by construction; `from_utf8_unchecked`
/// skips a redundant validation pass on the allocating hot path.
pub fn hex_encode_bytes(input: &[u8]) -> String {
    let mut out = vec![0u8; input.len() * 2];
    // faster-hex encode cannot fail on an exactly-sized buffer.
    faster_hex::hex_encode(input, &mut out).expect("hex encode: exact-size output buffer");
    // SAFETY: every byte written is an ASCII hex digit from `HEX_LOWER`.
    unsafe { String::from_utf8_unchecked(out) }
}

/// Decode lowercase/uppercase hex to bytes. On x86_64 + AVX2 this uses the
/// single-pass `hex_fast` kernel; elsewhere the validated `faster-hex` engine
/// — both reject `[^0-9a-fA-F]` exactly like `hex_val`.
pub fn hex_decode_bytes(input: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    if !input.len().is_multiple_of(2) {
        return Err("odd hex length");
    }
    let mut out = vec![0u8; input.len() / 2];
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            // SAFETY: AVX2 runtime-detected; `input` even, `out` exactly
            // `input.len() / 2` (both established above).
            unsafe { hex_fast::decode(input, &mut out) }?;
            return Ok(out);
        }
    }
    faster_hex::hex_decode(input, &mut out).map_err(|_| "invalid hex digit")?;
    Ok(out)
}

#[napi]
pub fn hex_encode(input: Uint8Array) -> Buffer {
    Buffer::from(hex_encode_bytes(input.as_ref()).into_bytes())
}

#[napi]
pub fn hex_decode(input: Uint8Array) -> Result<Buffer> {
    hex_decode_bytes(input.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(e.to_string()))
}

// ── Reusable-output (_into) variants ────────────────────────────
//
// These write into a caller-provided output buffer and return the number of
// bytes written (u32), so hot loops can pool the buffer instead of allocating
// a fresh Vec + napi Buffer per call. They error on a buffer that is too small;
// input/output overlap is handled by `crate::util::run_packed_into`.

/// Lowercase-hex encode directly into `out` (SIMD via `faster-hex`). Returns
/// bytes written (`input.len() * 2`). Errors if `out` is too small.
#[inline]
pub fn hex_encode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let needed = input
        .len()
        .checked_mul(2)
        .ok_or_else(|| Error::from_reason("hex encode: input too large (length overflow)"))?;
    if out.len() < needed {
        return Err(Error::from_reason("hex encode: output buffer too small"));
    }
    // Slice to the exact size so the pipeline never sees a ragged tail: the
    // caller-sized-buffer contract is preserved (error above), and the engine
    // fills `needed` bytes exactly.
    let exact = &mut out[..needed];
    faster_hex::hex_encode(input, exact).expect("hex encode: exact-size output buffer");
    Ok(needed)
}

#[napi]
pub fn hex_encode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, hex_encode_into_slice)
}

/// Hex-decode directly into `out` — case-insensitive, rejects
/// `[^0-9a-fA-F]` exactly like `hex_val`. Returns bytes written
/// (`input.len() / 2`). Errors on odd length, invalid digits, or an output
/// buffer that is too small. On x86_64 with AVX2 this dispatches to the
/// single-pass `hex_fast` kernel; everywhere else it uses the validated
/// `faster-hex` engine — both byte-identical to the scalar LUT semantics.
#[inline]
pub fn hex_decode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    if !input.len().is_multiple_of(2) {
        return Err(Error::from_reason("odd hex length"));
    }
    let needed = input.len() / 2;
    if out.len() < needed {
        return Err(Error::from_reason("hex decode: output buffer too small"));
    }
    hex_decode_into_slice_impl(input, &mut out[..needed])
}

#[cfg(target_arch = "x86_64")]
#[inline]
fn hex_decode_into_slice_impl(input: &[u8], out: &mut [u8]) -> Result<usize> {
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: AVX2 runtime-detected; `input` even and `out` exactly
        // `input.len() / 2` (checked above).
        unsafe { hex_fast::decode(input, out) }.map_err(Error::from_reason)
    } else {
        faster_hex::hex_decode(input, out).map_err(|_| Error::from_reason("invalid hex digit"))?;
        Ok(out.len())
    }
}

#[cfg(not(target_arch = "x86_64"))]
#[inline]
fn hex_decode_into_slice_impl(input: &[u8], out: &mut [u8]) -> Result<usize> {
    faster_hex::hex_decode(input, out).map_err(|_| Error::from_reason("invalid hex digit"))?;
    Ok(out.len())
}

#[napi]
pub fn hex_decode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, hex_decode_into_slice)
}

/// Single-pass AVX2 hex decode — the accelerated decode tier on x86_64 (see
/// the hex section header). Decodes 64 hex chars (32 output bytes) per
/// iteration, computing the validity mask and the hex-digit values in ONE
/// vector pass. Any chunk containing a non-hex byte rejects the whole input
/// (byte-identical to the HEX_VAL_LUT scalar reject-everywhere semantics —
/// no partial writes). The remainder (< 64 chars) is decoded by the validated
/// `faster-hex` engine, so error behavior and output are identical everywhere.
///
/// faster-hex decode does a separate validation scan + decode pass (~5GB/s
/// cap measured vs Buffer.from(hex) ~10.5GB/s); this kernel is single-pass
/// and targets that gap.
#[cfg(target_arch = "x86_64")]
pub mod hex_fast {
    use std::arch::x86_64::*;

    /// Decode `chars[0..64]` → `out[0..32]`. Returns false when any of the 64
    /// chars is not `[0-9a-fA-F]`; on false, `out` is left untouched so
    /// callers can error without partial writes.
    #[target_feature(enable = "avx2")]
    unsafe fn decode_chunk(chars: *const u8, out: *mut u8) -> bool {
        let lo = _mm256_loadu_si256(chars as *const __m256i); // chars 0..31
        let hi = _mm256_loadu_si256(chars.add(32) as *const __m256i); // chars 32..63

        // Lowercase for the letter test ('A'-'F' | 0x20 == 'a'-'f').
        let loo = _mm256_or_si256(lo, _mm256_set1_epi8(0x20));
        let hio = _mm256_or_si256(hi, _mm256_set1_epi8(0x20));

        // Validity per byte (signed compares; all bounds are < 0x80 so signed
        // and unsigned agree for the printable range, and bytes >= 0x80 fail
        // both bounds): (b in '0'..='9') | (b|0x20 in 'a'..='f').
        let lo_digit = _mm256_and_si256(
            _mm256_cmpgt_epi8(loo, _mm256_set1_epi8((b'0' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'9' + 1) as i8), loo),
        );
        let lo_letter = _mm256_and_si256(
            _mm256_cmpgt_epi8(loo, _mm256_set1_epi8((b'a' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'f' + 1) as i8), loo),
        );
        let hi_digit = _mm256_and_si256(
            _mm256_cmpgt_epi8(hio, _mm256_set1_epi8((b'0' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'9' + 1) as i8), hio),
        );
        let hi_letter = _mm256_and_si256(
            _mm256_cmpgt_epi8(hio, _mm256_set1_epi8((b'a' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'f' + 1) as i8), hio),
        );
        let lo_valid = _mm256_or_si256(lo_digit, lo_letter);
        let hi_valid = _mm256_or_si256(hi_digit, hi_letter);
        if _mm256_movemask_epi8(lo_valid) != -1 || _mm256_movemask_epi8(hi_valid) != -1 {
            return false;
        }

        // Value: (b|0x20) - '0' gives 0-9 for digits and 49-54 for a-f;
        // subtract 39 where it is a letter so a-f map to 10-15.
        let lo_letter_sel = _mm256_cmpgt_epi8(loo, _mm256_set1_epi8((b'a' - 1) as i8));
        let hi_letter_sel = _mm256_cmpgt_epi8(hio, _mm256_set1_epi8((b'a' - 1) as i8));
        let v_lo = _mm256_sub_epi8(
            _mm256_sub_epi8(loo, _mm256_set1_epi8(b'0' as i8)),
            _mm256_and_si256(lo_letter_sel, _mm256_set1_epi8(39)),
        );
        let v_hi = _mm256_sub_epi8(
            _mm256_sub_epi8(hio, _mm256_set1_epi8(b'0' as i8)),
            _mm256_and_si256(hi_letter_sel, _mm256_set1_epi8(39)),
        );

        // Pack adjacent pairs (v0, v1) -> (v0 << 4) | v1 with pmaddubsw
        // (unsigned v * signed pattern [16, 1] per pair, summed into u16).
        let pat = _mm256_set1_epi16(0x0110); // little-endian bytes: 0x10=16, 0x01=1
        let p_lo = _mm256_maddubs_epi16(v_lo, pat); // u16 lanes: out[0..8] (half0), out[8..16] (half1)
        let p_hi = _mm256_maddubs_epi16(v_hi, pat); // u16 lanes: out[16..24] (half0), out[24..32] (half1)

        // packus_epi16 lays halves side by side per 128-bit lane:
        //   lane0 = out[0..8]  + out[16..24]   lane1 = out[8..16] + out[24..32]
        // so a 64-bit lane permute [0, 2, 1, 3] restores the byte order.
        let packed = _mm256_packus_epi16(p_lo, p_hi);
        let ordered = _mm256_permute4x64_epi64(packed, 0b11_01_10_00);
        _mm256_storeu_si256(out as *mut __m256i, ordered);
        true
    }

    /// Single-pass decode of `input` into `out`. Preconditions (checked by the
    /// callers): `input.len()` is even and `out.len() == input.len()/2`.
    /// Returns `Ok(limit / 2)` or `Err("invalid hex digit")`.
    ///
    /// # Safety
    /// The caller must have runtime-detected AVX2
    /// (`is_x86_feature_detected!("avx2")`) and must uphold the length
    /// preconditions above.
    #[target_feature(enable = "avx2")]
    pub unsafe fn decode(input: &[u8], out: &mut [u8]) -> std::result::Result<usize, &'static str> {
        let limit = input.len();
        let mut i = 0usize;
        while i + 64 <= limit {
            if !decode_chunk(input.as_ptr().add(i), out.as_mut_ptr().add(i / 2)) {
                return Err("invalid hex digit");
            }
            i += 64;
        }
        if i < limit {
            // Tail (a multiple-of-2 remainder < 64 chars): validated engine.
            faster_hex::hex_decode(&input[i..], &mut out[i / 2..limit / 2])
                .map_err(|_| "invalid hex digit")?;
        }
        Ok(limit / 2)
    }
}

/// Pure core: base64-encode `input` into `out` (zero-alloc `encode_slice`).
/// Returns bytes written; errors if `out` is too small. Shared by the `_into`
/// napi path and the pure-core unit tests.
pub fn base64_encode_into_slice(
    input: &[u8],
    out: &mut [u8],
    url_safe: bool,
    padding: bool,
) -> Result<usize> {
    engine(url_safe, padding)
        .encode_slice(input, out)
        .map_err(|e| Error::from_reason(format!("base64 encode: {e}")))
}

/// Base64-encode into a caller-provided output buffer (zero-alloc via
/// `Engine::encode_slice`). Returns bytes written; errors if `output` is too
/// small.
#[napi]
pub fn base64_encode_into(
    input: Uint8Array,
    mut output: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, move |inp, out| {
        base64_encode_into_slice(inp, out, url_safe.unwrap_or(false), padding.unwrap_or(true))
    })
}

/// Pure core: base64-decode `input` into `out` (zero-alloc `decode_slice`).
/// Returns bytes written; errors on invalid input or a too-small output
/// buffer. Shared by the `_into` napi path and the pure-core unit tests.
pub fn base64_decode_into_slice(
    input: &[u8],
    out: &mut [u8],
    url_safe: bool,
    padding: bool,
) -> Result<usize> {
    engine(url_safe, padding)
        .decode_slice(input, out)
        .map_err(|e| Error::from_reason(format!("base64 decode: {e}")))
}

/// Base64-decode into a caller-provided output buffer (zero-alloc via
/// `Engine::decode_slice`). Returns bytes written; errors on invalid input or
/// an output buffer that is too small.
#[napi]
pub fn base64_decode_into(
    input: Uint8Array,
    mut output: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, move |inp, out| {
        base64_decode_into_slice(inp, out, url_safe.unwrap_or(false), padding.unwrap_or(true))
    })
}

/// Higher-order instance: the alphabet/padding engine is selected ONCE at
/// construction and stored concretely, so `encode`/`decode` never re-run the
/// 4-way engine match on the per-call path. On x86_64/aarch64 this holds the
/// SIMD runtime-dispatched engine, so large payloads also get AVX2/NEON.
#[napi]
pub struct Base64Codec {
    engine: engine_sel::Engine,
}

#[napi]
impl Base64Codec {
    #[napi(constructor)]
    pub fn new(url_safe: Option<bool>, padding: Option<bool>) -> Self {
        Self {
            engine: engine(url_safe.unwrap_or(false), padding.unwrap_or(true)),
        }
    }

    #[napi]
    pub fn encode(&self, input: Uint8Array) -> Buffer {
        Buffer::from(self.engine.encode(input.as_ref()).into_bytes())
    }

    #[napi]
    pub fn decode(&self, input: Uint8Array) -> Result<Buffer> {
        self.engine
            .decode(input.as_ref())
            .map(Buffer::from)
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_standard() {
        let data = b"hello world!";
        let enc = base64::engine::general_purpose::STANDARD.encode(data);
        assert_eq!(
            base64_decode(Uint8Array::new(enc.into_bytes()), None, None)
                .unwrap()
                .as_ref(),
            data
        );
    }

    #[test]
    fn base64url_no_padding() {
        // 0xfb → 111110 11 → "-w" (url-safe, no padding)
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xfb]);
        assert_eq!(enc, "-w");
        let dec = base64url_decode(Uint8Array::new(enc.into_bytes())).unwrap();
        assert_eq!(dec.as_ref(), [0xfb]);
    }

    #[test]
    fn base64_decode_rejects_invalid() {
        assert!(base64_decode(Uint8Array::new(b"!!!".to_vec()), None, None).is_err());
    }

    #[test]
    fn hex_roundtrip() {
        let data = b"\x00\x01\xfe\xffAB";
        let enc = hex_encode_bytes(data);
        assert_eq!(enc, "0001feff4142");
        assert_eq!(hex_decode_bytes(enc.as_bytes()).unwrap(), data);
    }

    #[test]
    fn hex_rejects_odd_and_bad() {
        assert!(hex_decode_bytes(b"abc").is_err());
        assert!(hex_decode_bytes(b"zz").is_err());
    }

    #[test]
    fn codec_instance_encodes_urlsafe() {
        let c = Base64Codec::new(Some(true), Some(false));
        let enc = c.encode(Uint8Array::new(b"\xfb".to_vec()));
        assert_eq!(enc.as_ref(), b"-w");
    }

    // ── SIMD engine (x86_64 / aarch64: AVX2 / NEON kernels) ──
    //
    // The SIMD engine must be a drop-in for the scalar one: byte-identical
    // output, identical validity/padding errors, on payloads both above the
    // SIMD thresholds (decode ≥ 64 B, encode ≥ 128 B) and below them.

    fn deterministic(n: usize) -> Vec<u8> {
        (0..n)
            .map(|i| (i.wrapping_mul(31) ^ (i >> 3)) as u8)
            .collect()
    }

    #[test]
    fn simd_large_payload_roundtrip_into_slice() {
        // 16 KiB: well above both SIMD thresholds — exercises the wide kernels
        // end-to-end and must round-trip byte-identically.
        let data = deterministic(16 * 1024);
        let mut enc = vec![0u8; data.len().div_ceil(3) * 4];
        let w = base64_encode_into_slice(&data, &mut enc, false, true).unwrap();
        assert_eq!(w, enc.len());
        let mut dec = vec![0u8; data.len()];
        let m = base64_decode_into_slice(&enc, &mut dec, false, true).unwrap();
        assert_eq!(&dec[..m], &data[..]);
    }

    #[test]
    fn simd_output_byte_identical_to_scalar() {
        // Large payload: SIMD encode/decode must match the scalar engines
        // exactly (alphabet + padding wire contract unchanged).
        let data = deterministic(2048);
        // standard w/ padding
        let mut enc = vec![0u8; data.len().div_ceil(3) * 4];
        let w = base64_encode_into_slice(&data, &mut enc, false, true).unwrap();
        let scalar_exp = base64::engine::general_purpose::STANDARD.encode(&data);
        assert_eq!(&enc[..w], scalar_exp.as_bytes());
        // url-safe, no padding
        let mut encu = vec![0u8; data.len().div_ceil(3) * 4];
        let wu = base64_encode_into_slice(&data, &mut encu, true, false).unwrap();
        let scalar_expu = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&data);
        assert_eq!(&encu[..wu], scalar_expu.as_bytes());
        // decode path parity
        let mut dec = vec![0u8; data.len()];
        let m = base64_decode_into_slice(scalar_exp.as_bytes(), &mut dec, false, true).unwrap();
        assert_eq!(&dec[..m], &data[..]);
        let mut decu = vec![0u8; data.len()];
        let mu = base64_decode_into_slice(scalar_expu.as_bytes(), &mut decu, true, false).unwrap();
        assert_eq!(&decu[..mu], &data[..]);
    }

    #[test]
    fn simd_large_decode_rejects_invalid() {
        // Invalid base64 symbol mid-buffer above the SIMD threshold: the wide
        // kernel breaks out and the scalar decoder reports the error — parity
        // with the scalar engine's rejection.
        let mut bad = vec![b'A'; 4096];
        bad[2048] = b'!';
        let mut out = vec![0u8; 4096];
        assert!(base64_decode_into_slice(&bad, &mut out, false, true).is_err());
        let scalar = base64::engine::general_purpose::STANDARD.decode(bad.as_slice());
        assert!(scalar.is_err());
    }

    #[test]
    fn simd_small_payload_matches_scalar() {
        // Below the SIMD thresholds the engine is scalar internally; output
        // and errors must match the preconfigured engines.
        let data = b"hello world!";
        let mut enc = [0u8; 32];
        let w = base64_encode_into_slice(data, &mut enc, false, true).unwrap();
        assert_eq!(&enc[..w], b"aGVsbG8gd29ybGQh");
        let mut dec = [0u8; 16];
        let m = base64_decode_into_slice(b"aGVsbG8gd29ybGQh", &mut dec, false, true).unwrap();
        assert_eq!(&dec[..m], data);
    }

    // ── reusable-output (_into) variants ──

    #[test]
    fn hex_encode_into_slice_matches_allocating() {
        let data = b"\x00\x01\xfe\xffAB";
        let expected = hex_encode_bytes(data);
        let mut out = [0u8; 32];
        let n = hex_encode_into_slice(data, &mut out).unwrap();
        assert_eq!(n, expected.len());
        assert_eq!(&out[..n], expected.as_bytes());
    }

    #[test]
    fn hex_encode_into_reports_length() {
        let data = b"hello";
        let out = Uint8Array::new(vec![0u8; 16]);
        let n = hex_encode_into(Uint8Array::new(data.to_vec()), out).unwrap();
        assert_eq!(n as usize, data.len() * 2);
    }

    #[test]
    fn hex_encode_into_small_buffer_errors() {
        let mut out = [0u8; 2];
        assert!(hex_encode_into_slice(b"abc", &mut out).is_err());
        let out2 = Uint8Array::new(vec![0u8; 4]);
        assert!(hex_encode_into(Uint8Array::new(b"abcdef".to_vec()), out2).is_err());
    }

    #[test]
    fn hex_decode_into_roundtrips() {
        let enc = hex_encode_bytes(b"\x00\x01\xfe\xffAB");
        let mut out = [0u8; 16];
        let n = hex_decode_into_slice(enc.as_bytes(), &mut out).unwrap();
        assert_eq!(&out[..n], b"\x00\x01\xfe\xffAB");
    }

    #[test]
    fn hex_decode_into_rejects_bad_input() {
        let mut out = [0u8; 4];
        assert!(hex_decode_into_slice(b"abc", &mut out).is_err());
        assert!(hex_decode_into_slice(b"zz", &mut out).is_err());
    }

    #[test]
    fn hex_decode_into_small_buffer_errors() {
        let mut out = [0u8; 2];
        assert!(hex_decode_into_slice(b"0001020304", &mut out).is_err());
    }

    // ── hex SIMD engine (faster-hex: runtime-dispatched SSE→AVX2) ──
    //
    // faster-hex must be a drop-in for the previous HEX_VAL_LUT scalar loops:
    // byte-identical encode output, identical accept/reject + values on
    // decode, at lengths both below and above the SIMD chunk boundaries
    // (pshufb processes 16 bytes/iteration, so 15/16/17, 31/32/33, … are the
    // straddle cases that would expose a broken fast path).

    /// Reference lowercase-hex encode (the previous per-byte LUT loop).
    fn ref_hex_encode(input: &[u8]) -> Vec<u8> {
        let hex = b"0123456789abcdef";
        let mut out = Vec::with_capacity(input.len() * 2);
        for &b in input {
            out.push(hex[(b >> 4) as usize]);
            out.push(hex[(b & 0x0f) as usize]);
        }
        out
    }

    /// Reference hex-digit value (the previous HEX_VAL_LUT semantics).
    fn ref_hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }

    #[test]
    fn hex_simd_encode_parity_all_lengths_and_sizes() {
        // Every length 0..=96 (covers every pshufb chunk boundary twice) plus
        // larger payloads that exercise the wide kernels end-to-end.
        let mut lens: Vec<usize> = (0..=96).collect();
        lens.extend([128, 255, 256, 511, 512, 1024, 16 * 1024, 256 * 1024]);
        for n in lens {
            let data = deterministic(n);
            let expect = ref_hex_encode(&data);
            // allocating path
            assert_eq!(hex_encode_bytes(&data).as_bytes(), &expect[..], "len {n}");
            // into-slice path (exact-size buffer, like the C-ABI caller)
            let mut out = vec![0u8; n * 2];
            let w = hex_encode_into_slice(&data, &mut out).unwrap();
            assert_eq!(w, n * 2);
            assert_eq!(&out[..w], &expect[..], "len {n}");
        }
    }

    #[test]
    fn hex_simd_decode_exhaustive_pair_matrix() {
        // All 65,536 two-char combos: accept/reject and decoded value must be
        // identical to the reference LUT semantics (case-insensitive digits,
        // everything else rejected). A SIMD engine with a divergent validity
        // mask fails here.
        for hi in 0u16..=255 {
            for lo in 0u16..=255 {
                let pair = [hi as u8, lo as u8];
                let want = match (ref_hex_val(pair[0]), ref_hex_val(pair[1])) {
                    (Some(h), Some(l)) => Some((h << 4) | l),
                    _ => None,
                };
                let mut out = [0u8; 1];
                let got = hex_decode_into_slice(&pair, &mut out);
                match want {
                    Some(v) => {
                        assert!(got.is_ok(), "{pair:02x?}: expected OK");
                        assert_eq!(out[0], v, "{pair:02x?}: value");
                    }
                    None => assert!(got.is_err(), "{pair:02x?}: expected reject"),
                }
            }
        }
    }

    #[test]
    fn hex_simd_large_roundtrip() {
        // 2 MiB deterministic payload: SIMD encode → SIMD decode must be the
        // identity, and the decoded bytes must match the source exactly.
        let data = deterministic(2 * 1024 * 1024);
        let mut enc = vec![0u8; data.len() * 2];
        let w = hex_encode_into_slice(&data, &mut enc).unwrap();
        assert_eq!(w, data.len() * 2);
        let mut dec = vec![0u8; data.len()];
        let m = hex_decode_into_slice(&enc, &mut dec).unwrap();
        assert_eq!(m, data.len());
        assert_eq!(&dec[..], &data[..]);
        // uppercase decodes to the same bytes (case-insensitive)
        for b in enc.iter_mut() {
            if b.is_ascii_lowercase() {
                *b = b.to_ascii_uppercase();
            }
        }
        let mut dec2 = vec![0u8; data.len()];
        let m2 = hex_decode_into_slice(&enc, &mut dec2).unwrap();
        assert_eq!(&dec2[..m2], &data[..]);
    }

    #[test]
    fn hex_simd_large_decode_rejects_invalid_tail() {
        // An invalid char at the very END of a 256 KiB string: the SIMD tail
        // handler must still reject (parity with the scalar loop's rejection
        // at any position).
        let mut hex = Vec::with_capacity(256 * 1024);
        for _ in 0..(128 * 1024) {
            hex.extend_from_slice(b"ab");
        }
        hex.push(b'g'); // 'g' is not a hex digit → odd+invalid
        let mut out = vec![0u8; 128 * 1024];
        assert!(hex_decode_into_slice(&hex, &mut out).is_err());

        // Even-length with a bad char one past the SIMD chunk boundary.
        let mut hex2 = hex[..hex.len() - 1].to_vec(); // even, all "ab..."
        hex2[200_001] = b'z';
        assert!(hex_decode_into_slice(&hex2, &mut out).is_err());
    }

    #[test]
    fn hex_simd_decode_chunk_boundary_sweep() {
        // Every length 0..=160 crosses the AVX2 kernel's 64-char chunk
        // boundary several times: valid inputs must decode to the reference
        // bytes, and an invalid char must be rejected no matter which bucket
        // it lands in (chunk body, chunk boundary, or the < 64-char tail).
        // This is the direct guard on the single-pass kernel's chunk loop +
        // tail handoff (the exhaustive pair matrix above covers 2-char inputs,
        // which only ever exercise the tail path).
        let mut lens: Vec<usize> = (0..=160).collect();
        lens.extend([192, 200, 512, 4096]);
        for n in lens {
            let even = n - n % 2; // even number of HEX CHARS in the input
            let expect: Vec<u8> = (0..even / 2)
                .map(|i| (i.wrapping_mul(13) + 7) as u8)
                .collect();
            let hex: String = expect.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex.len(), even);
            let mut out = vec![0u8; even / 2];
            let w = hex_decode_into_slice(hex.as_bytes(), &mut out).unwrap();
            assert_eq!(&out[..w], &expect[..], "len {even}");
            // Reject an invalid char at one position per bucket.
            for &pos in &[
                0usize,
                1,
                14,
                30,
                31,
                32,
                62,
                63,
                64,
                65,
                even.saturating_sub(2),
                even.saturating_sub(1),
            ] {
                if pos < even {
                    let mut bad = hex.clone().into_bytes();
                    bad[pos] = b'g'; // 'g' is never a hex digit
                    let mut o = vec![0u8; even / 2];
                    assert!(
                        hex_decode_into_slice(&bad, &mut o).is_err(),
                        "len {even} pos {pos}"
                    );
                }
            }
        }
    }

    #[test]
    fn base64_encode_into_reports_length() {
        let data = b"hello world!";
        let out = Uint8Array::new(vec![0u8; 64]);
        let n = base64_encode_into(Uint8Array::new(data.to_vec()), out, None, None).unwrap();
        assert_eq!(
            n as usize,
            base64::engine::general_purpose::STANDARD.encode(data).len()
        );
    }

    #[test]
    fn base64_encode_into_small_buffer_errors() {
        let out = Uint8Array::new(vec![0u8; 4]);
        assert!(
            base64_encode_into(Uint8Array::new(b"hello world!".to_vec()), out, None, None).is_err()
        );
    }

    #[test]
    fn base64_decode_into_roundtrips() {
        let data = b"hello world!";
        let enc = base64::engine::general_purpose::STANDARD.encode(data);
        let out = Uint8Array::new(vec![0u8; 32]);
        let n = base64_decode_into(Uint8Array::new(enc.into_bytes()), out, None, None).unwrap();
        assert_eq!(n as usize, data.len());
    }

    #[test]
    fn base64_decode_into_rejects_invalid() {
        let out = Uint8Array::new(vec![0u8; 32]);
        assert!(base64_decode_into(Uint8Array::new(b"!!!".to_vec()), out, None, None).is_err());
    }
}
