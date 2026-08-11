// rust/crypto/base64.rs — base64 (standard/url-safe) + hex encode/decode.
//
// Uses the `base64` crate engines (Cargo dep already present). The
// `Base64Codec` higher-order instance precompiles the alphabet/decoding
// configuration once in its constructor and reuses it across calls.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::bytes::{hex_val, HEX_LOWER};
use base64::Engine as _;

fn engine(url_safe: bool, padding: bool) -> base64::engine::general_purpose::GeneralPurpose {
    use base64::engine::general_purpose::*;
    match (url_safe, padding) {
        (false, true) => STANDARD,
        (false, false) => STANDARD_NO_PAD,
        (true, true) => URL_SAFE,
        (true, false) => URL_SAFE_NO_PAD,
    }
}

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
    Buffer::from(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(input.as_ref())
            .into_bytes(),
    )
}

#[napi]
pub fn base64url_decode(input: Uint8Array) -> Result<Buffer> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
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

// ── hex ──────────────────────────────────────────────────────────

/// Encode bytes as lowercase hex (uses the shared `HEX_LOWER` table — direct
/// byte writes, no per-nibble `char` push).
///
/// # Safety
///
/// Hex output is always ASCII (`HEX_LOWER` is a byte string of `0-9a-f`), so
/// the built `Vec<u8>` is valid UTF-8 by construction; `from_utf8_unchecked`
/// skips a redundant validation pass on the allocating hot path.
pub fn hex_encode_bytes(input: &[u8]) -> String {
    let mut out = Vec::with_capacity(input.len() * 2);
    for &b in input {
        out.push(HEX_LOWER[(b >> 4) as usize]);
        out.push(HEX_LOWER[(b & 0x0f) as usize]);
    }
    // SAFETY: every byte pushed is an ASCII hex digit from `HEX_LOWER`.
    unsafe { String::from_utf8_unchecked(out) }
}

/// Decode lowercase/uppercase hex to bytes.
pub fn hex_decode_bytes(input: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    if !input.len().is_multiple_of(2) {
        return Err("odd hex length");
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    for i in (0..input.len()).step_by(2) {
        let hi = hex_val(input[i]).ok_or("invalid hex digit")?;
        let lo = hex_val(input[i + 1]).ok_or("invalid hex digit")?;
        out.push((hi << 4) | lo);
    }
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

/// Lowercase-hex encode directly into `out`. Returns bytes written
/// (`input.len() * 2`). Errors if `out` is too small.
#[inline]
pub fn hex_encode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let needed = input
        .len()
        .checked_mul(2)
        .ok_or_else(|| Error::from_reason("hex encode: input too large (length overflow)"))?;
    if out.len() < needed {
        return Err(Error::from_reason("hex encode: output buffer too small"));
    }
    let mut pos = 0usize;
    for &b in input {
        out[pos] = HEX_LOWER[(b >> 4) as usize];
        out[pos + 1] = HEX_LOWER[(b & 0x0f) as usize];
        pos += 2;
    }
    Ok(pos)
}

#[napi]
pub fn hex_encode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, hex_encode_into_slice)
}

/// Hex-decode directly into `out`. Returns bytes written (`input.len() / 2`).
/// Errors on odd length, invalid digits, or an output buffer that is too small.
#[inline]
pub fn hex_decode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    if !input.len().is_multiple_of(2) {
        return Err(Error::from_reason("odd hex length"));
    }
    let needed = input.len() / 2;
    if out.len() < needed {
        return Err(Error::from_reason("hex decode: output buffer too small"));
    }
    let mut pos = 0usize;
    for i in (0..input.len()).step_by(2) {
        let hi = hex_val(input[i]).ok_or_else(|| Error::from_reason("invalid hex digit"))?;
        let lo = hex_val(input[i + 1]).ok_or_else(|| Error::from_reason("invalid hex digit"))?;
        out[pos] = (hi << 4) | lo;
        pos += 1;
    }
    Ok(pos)
}

#[napi]
pub fn hex_decode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, hex_decode_into_slice)
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
/// 4-way engine match on the per-call path.
#[napi]
pub struct Base64Codec {
    engine: base64::engine::general_purpose::GeneralPurpose,
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
