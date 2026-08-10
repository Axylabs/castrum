// rust/crypto/aead.rs — authenticated encryption (AES-256-GCM, ChaCha20-Poly1305).
//
// Backend-framework feature: symmetric encryption for cookies / session
// payloads / at-rest secrets. Uses aws-lc-rs's `aead` module (already a
// dependency for HMAC-SHA256), so no new crate is pulled in. Nonce and plaintext
// lengths are validated; a 12-byte nonce is required (both algorithms use the
// same 96-bit nonce length).
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use aws_lc_rs::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::error::Unspecified;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};

const NONCE_LEN: usize = 12;

/// Derive a unique per-item nonce for the batch APIs.
///
/// AES-GCM and ChaCha20-Poly1305 are catastrophic under nonce reuse with the
/// same key. The batch APIs accept ONE caller-provided base nonce; this derives
/// a distinct nonce per item by XOR-ing the item index into the low 8 bytes.
///
/// SAFETY CONTRACT: callers MUST use a fresh base nonce for every batch call
/// (never reuse a base nonce with the same key across calls), otherwise item `i`
/// of two different batches share a nonce and keystream/tag reuse applies.
#[inline]
fn batch_nonce(base: &[u8], index: usize) -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(base);
    let idx = (index as u64).to_be_bytes();
    for (slot, byte) in nonce[4..].iter_mut().zip(idx.iter()) {
        *slot ^= byte;
    }
    nonce
}

fn resolve_algorithm(name: Option<&str>) -> Result<&'static aead::Algorithm> {
    match name {
        None | Some("aes-256-gcm") => Ok(&aead::AES_256_GCM),
        Some("chacha20-poly1305") => Ok(&aead::CHACHA20_POLY1305),
        Some(other) => Err(Error::from_reason(format!(
            "unsupported aead algorithm: {other} (expected aes-256-gcm | chacha20-poly1305)"
        ))),
    }
}

// ── Pure-Rust core ─────────────────────────────────────────────

/// Encrypt `plaintext`, appending the 16-byte auth tag. Returns the ciphertext
/// (plaintext length + tag).
pub fn encrypt(
    alg: &'static aead::Algorithm,
    key: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
) -> std::result::Result<Vec<u8>, Unspecified> {
    let unbound = UnboundKey::new(alg, key)?;
    let sealing = LessSafeKey::new(unbound);
    encrypt_with_key(&sealing, nonce, plaintext)
}

/// Encrypt with a PRE-COMPILED key (no per-call `UnboundKey`/`LessSafeKey`
/// derivation — the win the `AeadCipher` instance exploits).
pub fn encrypt_with_key(
    sealing: &LessSafeKey,
    nonce: &[u8],
    plaintext: &[u8],
) -> std::result::Result<Vec<u8>, Unspecified> {
    if nonce.len() != NONCE_LEN {
        return Err(Unspecified);
    }
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce);
    let nonce = Nonce::assume_unique_for_key(nonce_arr);
    let mut in_out = plaintext.to_vec();
    sealing.seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)?;
    Ok(in_out)
}

/// Decrypt `ciphertext` (ciphertext + tag), returning the plaintext.
pub fn decrypt(
    alg: &'static aead::Algorithm,
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> std::result::Result<Vec<u8>, Unspecified> {
    let unbound = UnboundKey::new(alg, key)?;
    let opening = LessSafeKey::new(unbound);
    decrypt_with_key(&opening, nonce, ciphertext)
}

/// Decrypt with a PRE-COMPILED key (no per-call key derivation).
pub fn decrypt_with_key(
    opening: &LessSafeKey,
    nonce: &[u8],
    ciphertext: &[u8],
) -> std::result::Result<Vec<u8>, Unspecified> {
    if nonce.len() != NONCE_LEN {
        return Err(Unspecified);
    }
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce);
    let nonce = Nonce::assume_unique_for_key(nonce_arr);
    // Single copy: borrow the ciphertext in, then truncate in place to the
    // plaintext length (the tag occupies the trailing bytes) and return it.
    let mut in_out = ciphertext.to_vec();
    let opened = opening.open_in_place(nonce, Aad::empty(), &mut in_out)?;
    let plaintext_len = opened.len();
    in_out.truncate(plaintext_len);
    Ok(in_out)
}

// ── NAPI entry points ──────────────────────────────────────────

/// Encrypt `plaintext` → ciphertext+tag. `key` must be 32 bytes; `nonce` must
/// be 12 bytes. Defaults to AES-256-GCM; pass `"chacha20-poly1305"` to switch.
#[napi]
pub fn aead_encrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm: Option<String>,
) -> Result<Buffer> {
    let alg = resolve_algorithm(algorithm.as_deref())?;
    encrypt(alg, key.as_ref(), nonce.as_ref(), plaintext.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("aead encrypt failed: {e:?}")))
}

/// Decrypt `ciphertext`+tag → plaintext. Returns `null` when the tag fails to
/// authenticate (tampered / wrong key) or the inputs are malformed.
#[napi]
pub fn aead_decrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm: Option<String>,
) -> Result<Option<Buffer>> {
    let alg = resolve_algorithm(algorithm.as_deref())?;
    match decrypt(alg, key.as_ref(), nonce.as_ref(), ciphertext.as_ref()) {
        Ok(pt) => Ok(Some(Buffer::from(pt))),
        Err(_) => Ok(None),
    }
}

/// Higher-order instance: precompiles the algorithm + key into a `LessSafeKey`
/// once at construction, so `encrypt`/`decrypt` never re-derive the key on the
/// per-call path.
#[napi]
pub struct AeadCipher {
    key: LessSafeKey,
}

#[napi]
impl AeadCipher {
    #[napi(constructor)]
    pub fn new(key: Uint8Array, algorithm: Option<String>) -> Result<Self> {
        let alg = resolve_algorithm(algorithm.as_deref())?;
        let unbound = UnboundKey::new(alg, key.as_ref())
            .map_err(|e| Error::from_reason(format!("invalid aead key: {e:?}")))?;
        Ok(Self {
            key: LessSafeKey::new(unbound),
        })
    }

    /// Encrypt `plaintext` → ciphertext+tag with the precompiled key.
    #[napi]
    pub fn encrypt(&self, nonce: Uint8Array, plaintext: Uint8Array) -> Result<Buffer> {
        encrypt_with_key(&self.key, nonce.as_ref(), plaintext.as_ref())
            .map(Buffer::from)
            .map_err(|e| Error::from_reason(format!("aead encrypt failed: {e:?}")))
    }

    /// Decrypt `ciphertext`+tag → plaintext, or `null` on auth failure.
    #[napi]
    pub fn decrypt(&self, nonce: Uint8Array, ciphertext: Uint8Array) -> Result<Option<Buffer>> {
        match decrypt_with_key(&self.key, nonce.as_ref(), ciphertext.as_ref()) {
            Ok(pt) => Ok(Some(Buffer::from(pt))),
            Err(_) => Ok(None),
        }
    }
}

/// Parallel encrypt batch: packed `[u32 count]{[u32 len][plaintext]}` in →
/// packed `[u32 count]{[u32 len][ciphertext+tag]}` out.
///
/// SECURITY: a unique nonce is derived per item from the caller-provided base
/// `nonce` (item index XOR-ed into the low 8 bytes). The base nonce MUST be
/// fresh for every batch call — never reuse a base nonce with the same key.
#[napi]
pub fn aead_encrypt_batch_packed(
    data: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm: Option<String>,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let alg = resolve_algorithm(algorithm.as_deref())?;

    let enc_for = |plaintext: &[u8], index: usize| -> Vec<u8> {
        let n = batch_nonce(nonce.as_ref(), index);
        encrypt(alg, key.as_ref(), &n, plaintext).unwrap_or_default()
    };

    let mut out = Vec::with_capacity(4 + items.len() * 24);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items
            .par_iter()
            .enumerate()
            .map(|(i, p)| enc_for(p, i))
            .collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for (i, p) in items.iter().enumerate() {
            let r = enc_for(p, i);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

/// Parallel decrypt batch: packed ciphertexts in → packed plaintexts out.
/// Items whose tag fails to authenticate produce an empty (zero-length) entry.
///
/// SECURITY: the SAME per-item nonce derivation as
/// {@link aead_encrypt_batch_packed} must be used — pass the same base `nonce`
/// and batch ordering to decrypt what was encrypted.
#[napi]
pub fn aead_decrypt_batch_packed(
    data: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    algorithm: Option<String>,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let alg = resolve_algorithm(algorithm.as_deref())?;

    let dec_for = |ciphertext: &[u8], index: usize| -> Vec<u8> {
        let n = batch_nonce(nonce.as_ref(), index);
        decrypt(alg, key.as_ref(), &n, ciphertext).unwrap_or_default()
    };

    let mut out = Vec::with_capacity(4 + items.len() * 24);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items
            .par_iter()
            .enumerate()
            .map(|(i, c)| dec_for(c, i))
            .collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for (i, c) in items.iter().enumerate() {
            let r = dec_for(c, i);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_bytes() -> [u8; 32] {
        [7u8; 32]
    }

    fn nonce_bytes() -> [u8; 12] {
        [3u8; 12]
    }

    #[test]
    fn aes256gcm_roundtrip() {
        let pt = b"secret session payload";
        let ct = encrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), pt).unwrap();
        assert_eq!(ct.len(), pt.len() + 16);
        let dec = decrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), &ct).unwrap();
        assert_eq!(dec, pt);
    }

    #[test]
    fn aead_cipher_instance_roundtrips_and_rejects() {
        // Precompiled-key instance: encrypt/decrypt with no per-call key
        // derivation. Must match the scalar core exactly.
        let cipher = AeadCipher::new(Uint8Array::new(key_bytes().to_vec()), None).unwrap();
        let pt = b"session cookie value";

        let ct = cipher
            .encrypt(
                Uint8Array::new(nonce_bytes().to_vec()),
                Uint8Array::new(pt.to_vec()),
            )
            .unwrap();
        assert_eq!(ct.len(), pt.len() + 16);

        let ct_bytes = ct.to_vec();
        let dec = cipher
            .decrypt(
                Uint8Array::new(nonce_bytes().to_vec()),
                Uint8Array::new(ct_bytes.clone()),
            )
            .unwrap();
        assert_eq!(&dec.unwrap()[..], pt);

        // Wrong-key instance fails to authenticate.
        let other = AeadCipher::new(Uint8Array::new([9u8; 32].to_vec()), None).unwrap();
        assert!(other
            .decrypt(
                Uint8Array::new(nonce_bytes().to_vec()),
                Uint8Array::new(ct_bytes)
            )
            .unwrap()
            .is_none());

        // Malformed nonce length → error.
        assert!(cipher
            .encrypt(Uint8Array::new(vec![0u8; 8]), Uint8Array::new(pt.to_vec()))
            .is_err());

        // Unsupported algorithm → construction error.
        assert!(AeadCipher::new(
            Uint8Array::new(key_bytes().to_vec()),
            Some("aes-128-gcm".to_string())
        )
        .is_err());
    }

    #[test]
    fn batch_nonce_unique_per_item() {
        // Regression: the batch APIs must NEVER reuse a nonce across items.
        let base = nonce_bytes();
        let n0 = batch_nonce(&base, 0);
        let n1 = batch_nonce(&base, 1);
        let n2 = batch_nonce(&base, 2);
        assert_ne!(n0, n1, "nonce for item 0 and 1 must differ");
        assert_ne!(n1, n2, "nonce for item 1 and 2 must differ");
        assert_ne!(n0, n2);
        // Uniqueness for a full large batch too.
        let mut seen = std::collections::HashSet::new();
        for i in 0..1024 {
            assert!(
                seen.insert(batch_nonce(&base, i)),
                "nonce reused at item {i}"
            );
        }
    }

    #[test]
    fn batch_nonce_derived_encrypt_roundtrip() {
        // Each item encrypted with its derived nonce decrypts correctly, and a
        // mismatched nonce fails to authenticate (catches nonce-reuse misuse).
        let alg = &aead::AES_256_GCM;
        let key = key_bytes();
        let base = nonce_bytes();

        let p0 = b"first payload";
        let p1 = b"second payload";

        let c0 = encrypt(alg, &key, &batch_nonce(&base, 0), p0).unwrap();
        let c1 = encrypt(alg, &key, &batch_nonce(&base, 1), p1).unwrap();

        assert_eq!(decrypt(alg, &key, &batch_nonce(&base, 0), &c0).unwrap(), p0);
        assert_eq!(decrypt(alg, &key, &batch_nonce(&base, 1), &c1).unwrap(), p1);
        // Cross-nonce decryption must fail authentication.
        assert!(decrypt(alg, &key, &batch_nonce(&base, 1), &c0).is_err());
        assert!(decrypt(alg, &key, &batch_nonce(&base, 0), &c1).is_err());
    }

    #[test]
    fn chacha20_roundtrip() {
        let pt = b"another payload";
        let ct = encrypt(&aead::CHACHA20_POLY1305, &key_bytes(), &nonce_bytes(), pt).unwrap();
        let dec = decrypt(&aead::CHACHA20_POLY1305, &key_bytes(), &nonce_bytes(), &ct).unwrap();
        assert_eq!(dec, pt);
    }

    #[test]
    fn tampered_ciphertext_fails_auth() {
        let pt = b"integrity matters";
        let mut ct = encrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), pt).unwrap();
        ct[0] ^= 0xff;
        assert!(decrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), &ct).is_err());
    }

    #[test]
    fn wrong_key_fails_auth() {
        let pt = b"integrity matters";
        let ct = encrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), pt).unwrap();
        let wrong_key = [9u8; 32];
        assert!(decrypt(&aead::AES_256_GCM, &wrong_key, &nonce_bytes(), &ct).is_err());
    }

    #[test]
    fn wrong_nonce_fails_auth() {
        let pt = b"integrity matters";
        let ct = encrypt(&aead::AES_256_GCM, &key_bytes(), &nonce_bytes(), pt).unwrap();
        let wrong_nonce = [4u8; 12];
        assert!(decrypt(&aead::AES_256_GCM, &key_bytes(), &wrong_nonce, &ct).is_err());
    }

    #[test]
    fn rejects_bad_nonce_length() {
        assert!(encrypt(&aead::AES_256_GCM, &key_bytes(), &[0u8; 8], b"x").is_err());
        assert!(decrypt(&aead::AES_256_GCM, &key_bytes(), &[0u8; 8], b"x").is_err());
    }
}
