// rust/crypto/ed25519.rs — Ed25519 keypair generation + sign/verify.
//
// Backend-framework feature: EdDSA (Ed25519) signing for JWT auth. Uses
// aws-lc-rs (already a dependency for HMAC/argon2/etc.) — no new crates.
//
// Pure-Rust core (no napi types in signatures) stays unit-testable; only the
// entry points use napi types — same split as the other crypto modules.
//
// Key formats (the `.env` contract consumed by @ignex/native):
//   - private key: PKCS#8 v1 DER (RFC 5208/8410, 48 bytes) — byte-identical
//     to Node `crypto.generateKeyPairSync("ed25519").privateKey.export({type:
//     "pkcs8", format: "der"})`.
//   - public key:  SPKI DER (RFC 5280/8410, 44 bytes) — byte-identical to
//     Node `publicKey.export({type: "spki", format: "der"})`.
// The raw 32-byte seed/public are recovered at the core boundary so the pure
// core only deals in raw bytes (aws-lc-rs `Ed25519KeyPair`/`UnparsedPublicKey`
// consume raw Ed25519 keys).

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair as _, UnparsedPublicKey, ED25519};
use napi::bindgen_prelude::*;
use napi_derive::napi;

pub const ED25519_SIGNATURE_LEN: usize = 64;
pub const ED25519_SEED_LEN: usize = 32;
pub const ED25519_PUBLIC_KEY_LEN: usize = 32;
/// PKCS#8 v1 DER length for an Ed25519 private key (RFC 8410: 48 bytes).
pub const ED25519_PKCS8_V1_LEN: usize = 48;
/// SPKI DER length for an Ed25519 public key (RFC 8410: 44 bytes).
pub const ED25519_SPKI_LEN: usize = 44;

/// The fixed SPKI DER header (AlgorithmIdentifier + BIT STRING wrapper) that
/// precedes the raw 32-byte Ed25519 public key — matches Node/OpenSSL.
const SPKI_HEADER: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Build the RFC 8410 SPKI DER encoding of a raw 32-byte Ed25519 public key.
pub fn spki_der(raw_public_key: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ED25519_SPKI_LEN);
    out.extend_from_slice(&SPKI_HEADER);
    out.extend_from_slice(raw_public_key);
    out
}

/// Recover the raw 32-byte public key from SPKI DER (44 bytes) — also accepts
/// the raw 32-byte form so callers can skip the DER round trip.
pub fn raw_public_key(public_der: &[u8]) -> Option<&[u8]> {
    match public_der.len() {
        ED25519_PUBLIC_KEY_LEN => Some(public_der),
        ED25519_SPKI_LEN if public_der.starts_with(&SPKI_HEADER) => {
            Some(&public_der[SPKI_HEADER.len()..])
        }
        _ => None,
    }
}

/// Generate an Ed25519 keypair → `(pkcs8_v1_private_der, spki_public_der)`.
///
/// `None` only if the OS CSPRNG fails (effectively never).
pub fn generate_keypair() -> Option<(Vec<u8>, Vec<u8>)> {
    let rng = SystemRandom::new();
    let document = Ed25519KeyPair::generate_pkcs8v1(&rng).ok()?;
    let private_der = document.as_ref().to_vec();
    let pair = Ed25519KeyPair::from_pkcs8(&private_der).ok()?;
    let public_der = spki_der(pair.public_key().as_ref());
    Some((private_der, public_der))
}

/// Sign `msg` with an Ed25519 private key (PKCS#8 v1/v2 DER) → 64-byte sig.
///
/// `None` on an unparseable/invalid private key.
pub fn sign(private_der: &[u8], msg: &[u8]) -> Option<Vec<u8>> {
    let pair = Ed25519KeyPair::from_pkcs8(private_der).ok()?;
    let sig = pair.try_sign(msg).ok()?;
    Some(sig.as_ref().to_vec())
}

/// Verify a 64-byte Ed25519 signature over `msg` with an SPKI DER (or raw
/// 32-byte) public key. Constant-time signature verification (aws-lc-rs).
pub fn verify(public_der: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let Some(raw) = raw_public_key(public_der) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, raw)
        .verify(msg, sig)
        .is_ok()
}

// ── NAPI entry points ──────────────────────────────────────────

/// An Ed25519 keypair serialized for `.env` storage — PKCS#8 v1 DER (private)
/// + SPKI DER (public), base64url encoded (RFC 7515 §2, no padding). The
/// fields are camelCased by napi-rs → `{ privateKey, publicKey }` on the JS
/// side.
#[napi(object)]
pub struct Ed25519Keypair {
    /// PKCS#8 v1 DER private key, base64url.
    pub private_key: String,
    /// SPKI DER public key, base64url.
    pub public_key: String,
}

/// Generate an Ed25519 keypair. Returns `{ privateKey, publicKey }` as
/// base64url DER strings, ready to persist in `.env`.
#[napi]
pub fn generate_ed25519_keypair() -> Result<Ed25519Keypair> {
    let (private_key, public_key) = generate_keypair()
        .ok_or_else(|| Error::from_reason("ed25519 keypair generation failed (CSPRNG error)"))?;
    Ok(Ed25519Keypair {
        private_key: String::from_utf8(crate::crypto::base64::base64url_encode_bytes(&private_key))
            .expect("base64url output is ASCII"),
        public_key: String::from_utf8(crate::crypto::base64::base64url_encode_bytes(&public_key))
            .expect("base64url output is ASCII"),
    })
}

/// Sign `msg` with an Ed25519 private key (PKCS#8 DER) → 64-byte signature.
#[napi]
pub fn ed25519_sign(msg: Uint8Array, private_key: Uint8Array) -> Result<Buffer> {
    sign(private_key.as_ref(), msg.as_ref())
        .map(Buffer::from)
        .ok_or_else(|| Error::from_reason("ed25519 sign failed (invalid private key)"))
}

/// Verify a 64-byte Ed25519 signature over `msg` with an SPKI DER (or raw
/// 32-byte) public key.
#[napi]
pub fn ed25519_verify(msg: Uint8Array, signature: Uint8Array, public_key: Uint8Array) -> bool {
    verify(public_key.as_ref(), msg.as_ref(), signature.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 §7.1 test vector 1.
    const TEST_SECRET: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];
    const TEST_PUBLIC: [u8; 32] = [
        0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07,
        0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07,
        0x51, 0x1a,
    ];
    const TEST_SIGNATURE: [u8; 64] = [
        0xe5, 0x56, 0x43, 0x00, 0xc3, 0x60, 0xac, 0x72, 0x90, 0x86, 0xe2, 0xcc, 0x80, 0x6e, 0x82,
        0x8a, 0x84, 0x87, 0x7f, 0x1e, 0xb8, 0xe5, 0xd9, 0x74, 0xd8, 0x73, 0xe0, 0x65, 0x22, 0x49,
        0x01, 0x55, 0x5f, 0xb8, 0x82, 0x15, 0x90, 0xa3, 0x3b, 0xac, 0xc6, 0x1e, 0x39, 0x70, 0x1c,
        0xf9, 0xb4, 0x6b, 0xd2, 0x5b, 0xf5, 0xf0, 0x59, 0x5b, 0xbe, 0x24, 0x65, 0x51, 0x41, 0x43,
        0x8e, 0x7a, 0x10, 0x0b,
    ];
    const TEST_MESSAGE: &[u8] = b"";

    fn pkcs8_v1_from_seed(seed: &[u8]) -> Vec<u8> {
        // RFC 8410 PKCS#8 v1 for Ed25519: 48 bytes (16-byte prefix + seed).
        let mut der = Vec::with_capacity(ED25519_PKCS8_V1_LEN);
        der.extend_from_slice(&[
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ]);
        der.extend_from_slice(seed);
        der
    }

    #[test]
    fn spki_der_round_trips() {
        let der = spki_der(&TEST_PUBLIC);
        assert_eq!(der.len(), ED25519_SPKI_LEN);
        assert_eq!(raw_public_key(&der), Some(&TEST_PUBLIC[..]));
        assert_eq!(raw_public_key(&TEST_PUBLIC), Some(&TEST_PUBLIC[..]));
        assert_eq!(raw_public_key(&der[..4]), None);
        assert_eq!(raw_public_key(&[]), None);
    }

    #[test]
    fn verify_rfc8032_vector_1() {
        let spki = spki_der(&TEST_PUBLIC);
        assert!(verify(&spki, TEST_MESSAGE, &TEST_SIGNATURE));
        // Signature is over the empty message — a non-empty message fails.
        assert!(!verify(&spki, b"x", &TEST_SIGNATURE));
        // Tampered signature fails.
        let mut bad = TEST_SIGNATURE;
        bad[0] ^= 0x01;
        assert!(!verify(&spki, TEST_MESSAGE, &bad));
    }

    #[test]
    fn sign_matches_rfc8032_vector_1() {
        let pkcs8 = pkcs8_v1_from_seed(&TEST_SECRET);
        let sig = sign(&pkcs8, TEST_MESSAGE).expect("sign should succeed");
        assert_eq!(sig, TEST_SIGNATURE);
        assert_eq!(sig.len(), ED25519_SIGNATURE_LEN);
    }

    #[test]
    fn generate_sign_verify_round_trip() {
        let (private_der, public_der) = generate_keypair().expect("keypair generation");
        assert_eq!(private_der.len(), ED25519_PKCS8_V1_LEN);
        assert_eq!(public_der.len(), ED25519_SPKI_LEN);

        let msg = b"integration plan for ignex + ninox + rbac";
        let sig = sign(&private_der, msg).expect("sign");
        assert!(verify(&public_der, msg, &sig));
        assert!(!verify(&public_der, b"tampered", &sig));
    }

    #[test]
    fn invalid_key_rejected() {
        assert!(sign(&[0u8; 10], b"msg").is_none());
        assert!(!verify(&[0u8; 10], b"msg", &[0u8; 64]));
    }
}
