// rust/core/hmac_sha256.rs — HMAC-SHA256 operations
// Pure Rust, no napi dependencies.

use aws_lc_rs::hmac;

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Compute HMAC-SHA256 and return hex-encoded result.
#[inline]
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let tag = hmac::sign(&key, data);
    hex_encode(tag.as_ref())
}

/// Verify an HMAC-SHA256 signature (hex-encoded).
#[inline]
pub fn hmac_sha256_verify(key: &[u8], data: &[u8], sig: &[u8]) -> bool {
    if sig.len() != 64 {
        return false;
    }

    let mut sig_bytes = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        let hi = match sig[2 * i] {
            b @ b'0'..=b'9' => b - b'0',
            b @ b'a'..=b'f' => b - b'a' + 10,
            b @ b'A'..=b'F' => b - b'A' + 10,
            _ => return false,
        };
        let lo = match sig[2 * i + 1] {
            b @ b'0'..=b'9' => b - b'0',
            b @ b'a'..=b'f' => b - b'a' + 10,
            b @ b'A'..=b'F' => b - b'A' + 10,
            _ => return false,
        };
        sig_bytes[i] = (hi << 4) | lo;
        i += 1;
    }

    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::verify(&key, data, &sig_bytes).is_ok()
}

fn hex_encode(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; bytes.len() * 2];
    for (i, &b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_LOWER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_LOWER[(b & 0x0f) as usize];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hmac_sha256_roundtrip() {
        let key = b"secret";
        let data = b"message";
        let sig = hmac_sha256(key, data);
        assert_eq!(sig.len(), 64);
        assert!(hmac_sha256_verify(key, data, &sig));
    }

    #[test]
    fn test_hmac_verify_fails_wrong_key() {
        let key = b"secret";
        let data = b"message";
        let sig = hmac_sha256(key, data);
        assert!(!hmac_sha256_verify(b"wrong", data, &sig));
    }
}