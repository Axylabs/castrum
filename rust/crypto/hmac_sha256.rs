use napi::bindgen_prelude::*;
use napi_derive::napi;
use aws_lc_rs::hmac;
use crate::util::bytes::{hex_decode_32, hex_encode_32, trim_ascii_whitespace};

#[napi]
pub fn hmac_sha256(key: Uint8Array, data: Buffer) -> Buffer {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_ref());
    let tag = hmac::sign(&key, data.as_ref());

    let mut out = [0u8; 64];
    hex_encode_32(tag.as_ref(), &mut out);

    Buffer::from(out.to_vec())
}

#[napi]
pub fn hmac_sha256_verify(key: Uint8Array, data: Buffer, sig: Buffer) -> bool {
    let sig = trim_ascii_whitespace(sig.as_ref());

    let Some(sig_bytes) = hex_decode_32(sig) else {
        return false;
    };

    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_ref());
    hmac::verify(&key, data.as_ref(), &sig_bytes).is_ok()
}

#[napi]
pub struct HmacSigner {
    key: hmac::Key,
}

#[napi]
impl HmacSigner {
    #[napi(constructor)]
    pub fn new(key: Uint8Array) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, key.as_ref()),
        }
    }

    #[napi]
    pub fn sign(&self, data: Buffer) -> Buffer {
        let tag = hmac::sign(&self.key, data.as_ref());

        let mut out = [0u8; 64];
        hex_encode_32(tag.as_ref(), &mut out);

        Buffer::from(out.to_vec())
    }

    #[napi]
    pub fn verify(&self, data: Buffer, sig: Buffer) -> bool {
        let sig = trim_ascii_whitespace(sig.as_ref());

        let Some(sig_bytes) = hex_decode_32(sig) else {
            return false;
        };

        hmac::verify(&self.key, data.as_ref(), &sig_bytes).is_ok()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hmac_sign_then_verify_roundtrip() {
        let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret-key");
        let data = b"hello world";
        let tag = aws_lc_rs::hmac::sign(&key, data);

        let mut hex = [0u8; 64];
        crate::util::bytes::hex_encode_32(tag.as_ref(), &mut hex);
        let decoded = crate::util::bytes::hex_decode_32(&hex).expect("valid hex decodes");

        assert!(aws_lc_rs::hmac::verify(&key, data, &decoded).is_ok());
    }

    #[test]
    fn hex_decode_32_rejects_bad_length_and_digits() {
        assert!(crate::util::bytes::hex_decode_32(b"abc").is_none());
        assert!(crate::util::bytes::hex_decode_32(&[b'0'; 64]).is_some());
        assert!(crate::util::bytes::hex_decode_32(&[b'g'; 64]).is_none());
    }
}