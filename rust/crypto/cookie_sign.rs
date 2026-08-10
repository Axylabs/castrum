// rust/crypto/cookie_sign.rs — signed cookies (`value.signature`, HMAC-SHA256).
//
// Composes the existing HMAC core + hex tables. The `CookieSigner`
// higher-order instance precomputes the HMAC key once in its constructor and
// reuses it across sign/verify calls.

use aws_lc_rs::hmac;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::bytes::{hex_decode_32, hex_encode_32};

/// `value` ++ "." ++ lowercase-hex(HMAC-SHA256(secret, value)).
pub fn sign_cookie_bytes(value: &[u8], key: &hmac::Key) -> Vec<u8> {
    let tag = hmac::sign(key, value);
    let mut sig = [0u8; 64];
    hex_encode_32(tag.as_ref(), &mut sig);
    let mut out = Vec::with_capacity(value.len() + 1 + 64);
    out.extend_from_slice(value);
    out.push(b'.');
    out.extend_from_slice(&sig);
    out
}

/// Constant-time verify; returns the signed value without its signature.
pub fn verify_cookie_bytes(signed: &[u8], key: &hmac::Key) -> Option<Vec<u8>> {
    let dot = signed.iter().rposition(|&b| b == b'.')?;
    let (value, sig) = signed.split_at(dot);
    let sig = &sig[1..];
    if sig.len() != 64 {
        return None;
    }
    let sig_bytes = hex_decode_32(sig)?;
    hmac::verify(key, value, &sig_bytes)
        .ok()
        .map(|()| value.to_vec())
}

#[napi]
pub fn sign_cookie(value: Uint8Array, secret: Uint8Array) -> Buffer {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref());
    Buffer::from(sign_cookie_bytes(value.as_ref(), &key))
}

#[napi]
pub fn verify_cookie(signed: Uint8Array, secret: Uint8Array) -> Option<Buffer> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref());
    verify_cookie_bytes(signed.as_ref(), &key).map(Buffer::from)
}

/// Higher-order instance: HMAC key compiled once, reused across calls.
#[napi]
pub struct CookieSigner {
    key: hmac::Key,
}

#[napi]
impl CookieSigner {
    #[napi(constructor)]
    pub fn new(secret: Uint8Array) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref()),
        }
    }

    #[napi]
    pub fn sign(&self, value: Uint8Array) -> Buffer {
        Buffer::from(sign_cookie_bytes(value.as_ref(), &self.key))
    }

    #[napi]
    pub fn verify(&self, signed: Uint8Array) -> Option<Buffer> {
        verify_cookie_bytes(signed.as_ref(), &self.key).map(Buffer::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(secret: &[u8]) -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, secret)
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let k = key(b"super-secret");
        let value = b"session=abc123";
        let signed = sign_cookie_bytes(value, &k);
        assert!(signed.starts_with(value));
        assert_eq!(signed[value.len()], b'.');
        assert_eq!(verify_cookie_bytes(&signed, &k).unwrap(), value);
    }

    #[test]
    fn verify_rejects_tampered() {
        let k = key(b"super-secret");
        let value = b"session=abc123";
        let mut signed = sign_cookie_bytes(value, &k);
        let last = signed.len() - 1;
        signed[last] = if signed[last] == b'0' { b'1' } else { b'0' };
        assert!(verify_cookie_bytes(&signed, &k).is_none());
    }

    #[test]
    fn verify_rejects_wrong_secret_and_malformed() {
        let signed = sign_cookie_bytes(b"x", &key(b"secret-a"));
        assert!(verify_cookie_bytes(&signed, &key(b"secret-b")).is_none());
        assert!(verify_cookie_bytes(b"no-dot", &key(b"s")).is_none());
        assert!(verify_cookie_bytes(b"x.bad", &key(b"s")).is_none());
    }
}
