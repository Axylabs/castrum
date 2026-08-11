// rust/crypto/pbkdf2.rs — PBKDF2-HMAC-SHA256 key derivation.
//
// Pure-Rust (RustCrypto pbkdf2 + sha2). Standard NIST 800-132 KDF, exposed as
// a NAPI scalar. Bun has no synchronous PBKDF2 built-in (crypto.subtle.deriveBits
// is async), so this fills a real gap — the honest baseline is node:crypto's
// pbkdf2Sync, and @flux/native can prefer Bun's async path where a caller wants
// it. Output length is caller-chosen (default 32 bytes).

use napi::bindgen_prelude::*;
use napi_derive::napi;

use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;

/// Minimum output length (1 byte) / maximum sanity cap (1 MiB).
pub const PBKDF2_MIN_LEN: u32 = 1;
/// Cap derived-key length so a hostile caller can't request a huge allocation.
pub const PBKDF2_MAX_LEN: u32 = 1024 * 1024;

/// Derive a PBKDF2-HMAC-SHA256 key: `out = PBKDF2(password, salt, rounds, dkLen)`.
#[napi]
pub fn pbkdf2_sha256(
    password: Uint8Array,
    salt: Uint8Array,
    rounds: u32,
    dk_len: u32,
) -> Result<Buffer> {
    let dk_len = dk_len.clamp(PBKDF2_MIN_LEN, PBKDF2_MAX_LEN);
    let mut out = vec![0u8; dk_len as usize];
    // PBKDF2 rounds must be >= 1 (a 0-round call would be meaningless).
    let rounds = rounds.max(1);
    pbkdf2_hmac::<Sha256>(password.as_ref(), salt.as_ref(), rounds, &mut out);
    Ok(out.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_sha256_known_vector() {
        // RFC 7914 / NIST-style known answer: password "password", salt "salt",
        // 1 iteration, 32 bytes — cross-checked with node:crypto pbkdf2Sync.
        let out = pbkdf2_sha256(
            Uint8Array::new(b"password".to_vec()),
            Uint8Array::new(b"salt".to_vec()),
            1,
            32,
        )
        .unwrap();
        let expected: [u8; 32] = [
            0x12, 0x0f, 0xb6, 0xcf, 0xfc, 0xf8, 0xb3, 0x2c, 0x43, 0xe7, 0x22, 0x52, 0x56, 0xc4,
            0xf8, 0x37, 0xa8, 0x65, 0x48, 0xc9, 0x2c, 0xcc, 0x35, 0x48, 0x08, 0x05, 0x98, 0x7c,
            0xb7, 0x0b, 0xe1, 0x7b,
        ];
        assert_eq!(out.as_ref(), &expected);
    }

    #[test]
    fn pbkdf2_is_iteration_sensitive() {
        let a = pbkdf2_sha256(
            Uint8Array::new(b"pw".to_vec()),
            Uint8Array::new(b"salt".to_vec()),
            1,
            16,
        )
        .unwrap();
        let b = pbkdf2_sha256(
            Uint8Array::new(b"pw".to_vec()),
            Uint8Array::new(b"salt".to_vec()),
            2,
            16,
        )
        .unwrap();
        assert_ne!(a.as_ref(), b.as_ref());
    }

    #[test]
    fn pbkdf2_zero_rounds_treated_as_one() {
        let one = pbkdf2_sha256(
            Uint8Array::new(b"pw".to_vec()),
            Uint8Array::new(b"salt".to_vec()),
            1,
            16,
        )
        .unwrap();
        let zero = pbkdf2_sha256(
            Uint8Array::new(b"pw".to_vec()),
            Uint8Array::new(b"salt".to_vec()),
            0,
            16,
        )
        .unwrap();
        assert_eq!(one.as_ref(), zero.as_ref());
    }
}
