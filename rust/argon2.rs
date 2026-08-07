// rust/argon2.rs — argon2id password hashing.
//
// Backend-framework feature: password storage hashing. argon2id is the OWASP
// recommendation for new hashes; it is deliberately CPU/memory-heavy, which
// makes it an ideal candidate to offload to Rust (and parallelize with rayon).
// The `argon2` crate (RustCrypto) is pure Rust; `SaltString::encode_b64` lets us
// feed a caller-supplied salt so outputs are deterministic (unit-testable).
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};

// ── Options ────────────────────────────────────────────────────

/// argon2id parameters (defaults follow OWASP: 19 MiB, 2 iterations, 1 lane,
/// 32-byte output). Callers may lower the memory cost for fast benchmarks.
#[napi(object)]
pub struct PasswordHashOptions {
    /// Memory cost in KiB (m). Default: 19_456 (19 MiB).
    pub m_cost: Option<u32>,
    /// Iterations (t). Default: 2.
    pub t_cost: Option<u32>,
    /// Parallelism (p). Default: 1.
    pub p_cost: Option<u32>,
    /// Output length in bytes. Default: 32.
    pub out_len: Option<u32>,
}

fn resolve_opts(o: Option<&PasswordHashOptions>) -> (u32, u32, u32, u32) {
    match o {
        Some(o) => (
            o.m_cost.unwrap_or(19_456),
            o.t_cost.unwrap_or(2),
            o.p_cost.unwrap_or(1),
            o.out_len.unwrap_or(32),
        ),
        None => (19_456, 2, 1, 32),
    }
}

// ── Pure-Rust core ─────────────────────────────────────────────

/// Hash `password` with argon2id using the given raw salt bytes. Returns the
/// PHC string (`$argon2id$v=19$m=...,t=...,p=...$<b64 salt>$<b64 hash>`).
pub fn hash_password(
    password: &[u8],
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    out_len: u32,
) -> std::result::Result<String, argon2::password_hash::Error> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(out_len as usize))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::encode_b64(salt)?;
    Ok(argon2.hash_password(password, &salt)?.to_string())
}

/// Verify a password against a PHC string (constant-time internally).
pub fn verify_password(password: &[u8], phc: &[u8]) -> bool {
    let Ok(phc_str) = std::str::from_utf8(phc) else {
        return false;
    };
    let Ok(parsed) = PasswordHash::new(phc_str) else {
        return false;
    };
    Argon2::default().verify_password(password, &parsed).is_ok()
}

// ── NAPI entry points ──────────────────────────────────────────

/// Hash a password with argon2id. `salt` must be at least 8 bytes; output is a
/// PHC string. Deterministic given the same inputs.
#[napi]
pub fn password_hash(
    password: Uint8Array,
    salt: Uint8Array,
    options: Option<PasswordHashOptions>,
) -> Result<Buffer> {
    let (m, t, p, out_len) = resolve_opts(options.as_ref());
    let phc = hash_password(password.as_ref(), salt.as_ref(), m, t, p, out_len)
        .map_err(|e| Error::from_reason(format!("argon2 hash failed: {e}")))?;
    Ok(Buffer::from(phc.into_bytes()))
}

/// Verify a password against a PHC string. Returns false on any parse failure.
#[napi]
pub fn password_verify(password: Uint8Array, phc: Buffer) -> bool {
    verify_password(password.as_ref(), phc.as_ref())
}

/// Parallel argon2id batch: packed `[u32 count]{[u32 len][password]}` in →
/// packed `[u32 count]{[u32 len][phc]}` out, all hashed with the SAME salt.
#[napi]
pub fn password_hash_batch_packed(
    data: Uint8Array,
    salt: Uint8Array,
    options: Option<PasswordHashOptions>,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let (m, t, p, out_len) = resolve_opts(options.as_ref());

    let phc_for = |password: &[u8]| -> Vec<u8> {
        hash_password(password, salt.as_ref(), m, t, p, out_len)
            .map(|s| s.into_bytes())
            .unwrap_or_default()
    };

    let mut out = Vec::with_capacity(4 + items.len() * 96);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items.par_iter().map(|p| phc_for(p)).collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for p in items {
            let r = phc_for(p);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &[u8] = b"correct horse battery staple";
    const SALT: &[u8] = b"0123456789abcdef";

    #[test]
    fn hash_then_verify_roundtrip() {
        let phc = hash_password(PASSWORD, SALT, 4096, 2, 1, 32).unwrap();
        assert!(phc.starts_with("$argon2id$v=19$"));
        assert!(verify_password(PASSWORD, phc.as_bytes()));
    }

    #[test]
    fn verify_rejects_wrong_password() {
        let phc = hash_password(PASSWORD, SALT, 4096, 2, 1, 32).unwrap();
        assert!(!verify_password(b"wrong password", phc.as_bytes()));
    }

    #[test]
    fn verify_is_deterministic_given_salt() {
        let a = hash_password(PASSWORD, SALT, 4096, 2, 1, 32).unwrap();
        let b = hash_password(PASSWORD, SALT, 4096, 2, 1, 32).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_salt_different_hash() {
        let a = hash_password(PASSWORD, b"aaaaaaaaaaaaaaaa", 4096, 2, 1, 32).unwrap();
        let b = hash_password(PASSWORD, b"bbbbbbbbbbbbbbbb", 4096, 2, 1, 32).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn verify_rejects_garbage() {
        assert!(!verify_password(PASSWORD, b"not-a-phc-string"));
        assert!(!verify_password(PASSWORD, b""));
    }

    #[test]
    fn params_validation() {
        assert!(hash_password(PASSWORD, SALT, 0, 2, 1, 32).is_err());
        // Salt too short (argon2 requires >= 8 bytes).
        assert!(hash_password(PASSWORD, b"123", 4096, 2, 1, 32).is_err());
    }
}
