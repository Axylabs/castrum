// rust/base64.rs — base64 (standard/url-safe) + hex encode/decode.
//
// Uses the `base64` crate engines (Cargo dep already present). The
// `Base64Codec` higher-order instance precompiles the alphabet/decoding
// configuration once in its constructor and reuses it across calls.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use base64::Engine as _;
use crate::bytes::hex_val;

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
pub fn base64_encode(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Buffer {
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

// ── hex ──────────────────────────────────────────────────────────

/// Encode bytes as lowercase hex.
pub fn hex_encode_bytes(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for &b in input {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    out
}

/// Decode lowercase/uppercase hex to bytes.
pub fn hex_decode_bytes(input: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    if input.len() % 2 != 0 {
        return Err("odd hex length");
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    for pair in input.chunks(2) {
        let hi = hex_val(pair[0]).ok_or("invalid hex digit")?;
        let lo = hex_val(pair[1]).ok_or("invalid hex digit")?;
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
}
