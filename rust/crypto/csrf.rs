// rust/csrf.rs — CSRF tokens (32-byte random hex + HMAC-SHA256 signature).
//
// Token format: `<random-hex>.<hex(HMAC-SHA256(secret, random-hex))>`. The
// `CsrfProtector` higher-order instance precomputes the HMAC key once.

use aws_lc_rs::hmac;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::bytes::{hex_decode_32, hex_encode};

fn csrf_token_with_key(key: &hmac::Key) -> Result<Buffer> {
    let mut rnd = [0u8; 32];
    getrandom::fill(&mut rnd).map_err(|e| Error::from_reason(e.to_string()))?;
    let mut rnd_hex = [0u8; 64];
    hex_encode(&rnd, &mut rnd_hex);
    let tag = hmac::sign(key, &rnd_hex);
    let mut sig_hex = [0u8; 64];
    hex_encode(tag.as_ref(), &mut sig_hex);
    let mut out = Vec::with_capacity(64 + 1 + 64);
    out.extend_from_slice(&rnd_hex);
    out.push(b'.');
    out.extend_from_slice(&sig_hex);
    Ok(Buffer::from(out))
}

/// Constant-time verify; returns true when the signature matches.
pub fn csrf_verify_with_key(token: &[u8], key: &hmac::Key) -> bool {
    let Some(dot) = token.iter().position(|&b| b == b'.') else {
        return false;
    };
    let (rnd_hex, sig_hex) = token.split_at(dot);
    let sig_hex = &sig_hex[1..];
    if rnd_hex.len() != 64 || sig_hex.len() != 64 {
        return false;
    }
    let Some(sig) = hex_decode_32(sig_hex) else {
        return false;
    };
    hmac::verify(key, rnd_hex, &sig).is_ok()
}

#[napi]
pub fn csrf_token(secret: Uint8Array) -> Result<Buffer> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref());
    csrf_token_with_key(&key)
}

#[napi]
pub fn csrf_verify(token: Uint8Array, secret: Uint8Array) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref());
    csrf_verify_with_key(token.as_ref(), &key)
}

/// Higher-order instance: HMAC key compiled once, reused across create/verify.
#[napi]
pub struct CsrfProtector {
    key: hmac::Key,
}

#[napi]
impl CsrfProtector {
    #[napi(constructor)]
    pub fn new(secret: Uint8Array) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_ref()),
        }
    }

    #[napi]
    pub fn create(&self) -> Result<Buffer> {
        csrf_token_with_key(&self.key)
    }

    #[napi]
    pub fn verify(&self, token: Uint8Array) -> bool {
        csrf_verify_with_key(token.as_ref(), &self.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(secret: &[u8]) -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, secret)
    }

    #[test]
    fn token_roundtrip() {
        let k = key(b"csrf-secret");
        let token = csrf_token_with_key(&k).unwrap();
        let t = token.as_ref();
        assert_eq!(t.len(), 64 + 1 + 64);
        assert_eq!(t[64], b'.');
        assert!(csrf_verify_with_key(t, &k));
    }

    #[test]
    fn rejects_wrong_secret_and_malformed() {
        let token = csrf_token_with_key(&key(b"secret-a")).unwrap();
        assert!(!csrf_verify_with_key(token.as_ref(), &key(b"secret-b")));
        assert!(!csrf_verify_with_key(b"tooshort", &key(b"s")));
        assert!(!csrf_verify_with_key(b"x.bad", &key(b"s")));
    }
}
