use napi::bindgen_prelude::*;
use napi_derive::napi;
use aws_lc_rs::hmac;
use crate::util::{hex_val, trim_ascii_whitespace};

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";



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

    if sig.len() != 64 {
        return false;
    }

    let mut sig_bytes = [0u8; 32];

    let mut i = 0;
    while i < 32 {
        let hi = match hex_val(sig[2 * i]) {
            Some(v) => v,
            None => return false,
        };

        let lo = match hex_val(sig[2 * i + 1]) {
            Some(v) => v,
            None => return false,
        };

        sig_bytes[i] = (hi << 4) | lo;
        i += 1;
    }

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

        if sig.len() != 64 {
            return false;
        }

        let mut sig_bytes = [0u8; 32];

        let mut i = 0;

        while i < 32 {
            let hi = match hex_val(sig[2 * i]) {
                Some(v) => v,
                None => return false,
            };

            let lo = match hex_val(sig[2 * i + 1]) {
                Some(v) => v,
                None => return false,
            };

            sig_bytes[i] = (hi << 4) | lo;
            i += 1;
        }

        hmac::verify(&self.key, data.as_ref(), &sig_bytes).is_ok()
    }
}

fn hex_encode_32(bytes: &[u8], out: &mut [u8; 64]) {
    debug_assert_eq!(bytes.len(), 32);

    for (i, b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_LOWER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_LOWER[(b & 0x0f) as usize];
    }
}