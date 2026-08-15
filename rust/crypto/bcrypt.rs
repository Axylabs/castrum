// rust/crypto/bcrypt.rs — bcrypt password hashing.
//
// Pure-Rust (bcrypt crate, Blowfish-based). Unlike argon2id (memory-hard), a
// bcrypt cost of `2^cost` is CPU-bound. We expose the standard `$2b$` PHC
// string format so the output is interchangeable with Bun.password / bcryptjs.
//
// Pure-Rust core stays unit-testable; only the entry points use napi types.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// bcrypt cost lower bound (bcrypt crate enforces 4..=31).
pub const BCRYPT_MIN_COST: u32 = 4;
/// bcrypt cost upper bound.
pub const BCRYPT_MAX_COST: u32 = 31;

/// Clamp a caller cost into the bcrypt-legal range (4..=31).
#[inline]
pub fn clamp_cost(cost: u32) -> u32 {
    cost.clamp(BCRYPT_MIN_COST, BCRYPT_MAX_COST)
}

/// Hash a password with bcrypt at `cost`, returning a `$2b$` PHC string.
#[napi]
pub fn password_hash_bcrypt(password: Uint8Array, cost: u32) -> Result<String> {
    let cost = clamp_cost(cost);
    bcrypt::hash(password.as_ref(), cost).map_err(|e| Error::from_reason(e.to_string()))
}

/// Verify a password against a bcrypt `$2b$` PHC string.
/// Returns false on ANY malformed hash (parity with argon2 `password_verify`).
#[napi]
pub fn password_verify_bcrypt(password: Uint8Array, hash: String) -> bool {
    bcrypt::verify(password.as_ref(), &hash).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_cost_bounds() {
        assert_eq!(clamp_cost(0), BCRYPT_MIN_COST);
        assert_eq!(clamp_cost(3), BCRYPT_MIN_COST);
        assert_eq!(clamp_cost(4), 4);
        assert_eq!(clamp_cost(10), 10);
        assert_eq!(clamp_cost(31), 31);
        assert_eq!(clamp_cost(99), BCRYPT_MAX_COST);
    }

    #[test]
    fn bcrypt_roundtrip_and_wrong_password() {
        let h = bcrypt::hash(b"password".as_slice(), 4).unwrap();
        assert!(h.starts_with("$2b$04$"));
        assert_eq!(h.len(), 60); // PHC bcrypt strings are exactly 60 chars
        assert!(bcrypt::verify(b"password".as_slice(), &h).unwrap());
        assert!(!bcrypt::verify(b"wrong".as_slice(), &h).unwrap());
    }

    #[test]
    fn bcrypt_is_cost_sensitive_and_self_contained() {
        // Same password, two hashes differ (random salt) but both verify.
        let a = bcrypt::hash(b"pw".as_slice(), 4).unwrap();
        let b = bcrypt::hash(b"pw".as_slice(), 4).unwrap();
        assert_ne!(a, b);
        assert!(bcrypt::verify(b"pw".as_slice(), &a).unwrap());
        assert!(bcrypt::verify(b"pw".as_slice(), &b).unwrap());
    }

    #[test]
    fn napi_wrapper_clamps_and_roundtrips() {
        // cost 3 is clamped up to 4 (cheap) — exercises the napi boundary.
        let h = password_hash_bcrypt(Uint8Array::new(b"pw".to_vec()), 3).unwrap();
        assert!(h.starts_with("$2b$04$"));
        assert!(password_verify_bcrypt(
            Uint8Array::new(b"pw".to_vec()),
            h.clone()
        ));
        assert!(!password_verify_bcrypt(
            Uint8Array::new(b"nope".to_vec()),
            h
        ));
        // Malformed hash -> false (not a throw), matching argon2 semantics.
        assert!(!password_verify_bcrypt(
            Uint8Array::new(b"pw".to_vec()),
            "garbage".to_string()
        ));
    }
}
