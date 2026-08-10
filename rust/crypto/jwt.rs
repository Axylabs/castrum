// rust/crypto/jwt.rs — HS256 JSON Web Token signing/verification.
//
// Backend-framework feature: JWTs for auth. We implement HS256 by hand on top
// of the existing aws-lc-rs HMAC + base64 crates (no `jsonwebtoken` dep) to
// keep the dependency tree small and match this crate's byte-machinery style.
// RS256 (RSA via aws-lc-rs) can be layered on later.
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use base64::Engine as _;
use memchr::memchr;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::OnceLock;

/// Clock-skew tolerance (seconds) for the `iat` claim in `jwt_verify`.
const CLOCK_SKEW_LEEWAY_SECS: i64 = 60;

/// The canonical HS256 JWT header (`{"alg":"HS256","typ":"JWT"}`), serialized
/// and base64url-encoded ONCE (lazily). `JwtSigner::sign`, the scalar
/// `jwt_sign` and the batch sign all reuse it instead of rebuilding +
/// re-serializing the constant header on every call.
static JWT_HEADER_B64: OnceLock<Vec<u8>> = OnceLock::new();

fn jwt_header_b64() -> &'static [u8] {
    JWT_HEADER_B64.get_or_init(|| {
        let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
        b64url_encode(&serde_json::to_vec(&header).expect("constant JWT header serializes"))
    })
}

// ── base64url (RFC 7515 §2 — URL-safe, no padding) ─────────────

#[inline]
fn b64url_encode(data: &[u8]) -> Vec<u8> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(data).into_bytes()
}

#[inline]
fn b64url_decode(data: &[u8]) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let text = std::str::from_utf8(data).ok()?;
    URL_SAFE_NO_PAD.decode(text).ok()
}

// ── HMAC-SHA256 (aws-lc-rs) ────────────────────────────────────

/// HMAC-SHA256 with a freshly derived key (scalar convenience path).
pub fn hmac_sha256(secret: &[u8], data: &[u8]) -> [u8; 32] {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    hmac_sha256_with_key(&key, data)
}

/// HMAC-SHA256 with a PRE-COMPILED key — avoids re-deriving the key on every
/// call (the win the `JwtSigner`/`HmacSigner` instances exploit).
pub fn hmac_sha256_with_key(key: &aws_lc_rs::hmac::Key, data: &[u8]) -> [u8; 32] {
    let tag = aws_lc_rs::hmac::sign(key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

// ── Token assembly / splitting ─────────────────────────────────

pub struct TokenParts<'a> {
    pub header_b64: &'a [u8],
    pub payload_b64: &'a [u8],
    pub sig_b64: &'a [u8],
}

/// Split a compact JWT into its three dot-separated segments.
pub fn split_token(token: &[u8]) -> Option<TokenParts<'_>> {
    let first = memchr(b'.', token)?;
    let header_b64 = &token[..first];
    let rest = &token[first + 1..];
    let second = memchr(b'.', rest)?;
    let payload_b64 = &rest[..second];
    let sig_b64 = &rest[second + 1..];
    if memchr(b'.', sig_b64).is_some() {
        return None;
    }
    Some(TokenParts {
        header_b64,
        payload_b64,
        sig_b64,
    })
}

/// Build a full HS256 token from base64url-encoded header + payload segments.
pub fn build_token(header_b64: &[u8], payload_b64: &[u8], secret: &[u8]) -> Vec<u8> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    build_token_with_key(header_b64, payload_b64, &key)
}

/// Build a token with a PRE-COMPILED key (per-call key derivation removed).
pub fn build_token_with_key(
    header_b64: &[u8],
    payload_b64: &[u8],
    key: &aws_lc_rs::hmac::Key,
) -> Vec<u8> {
    let mut signing_input = Vec::with_capacity(header_b64.len() + 1 + payload_b64.len());
    signing_input.extend_from_slice(header_b64);
    signing_input.push(b'.');
    signing_input.extend_from_slice(payload_b64);

    let sig = hmac_sha256_with_key(key, &signing_input);
    let sig_b64 = b64url_encode(&sig);

    signing_input.push(b'.');
    signing_input.extend_from_slice(&sig_b64);
    signing_input
}

/// Constant-time byte comparison (no early exit on length mismatch beyond the
/// required guard — lengths differ → false).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify an HS256 signature (constant-time). Does NOT check claims/expiry.
pub fn verify_signature(token: &[u8], secret: &[u8]) -> bool {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    verify_signature_with_key(token, &key)
}

/// Verify an HS256 signature (constant-time) with a PRE-COMPILED key.
pub fn verify_signature_with_key(token: &[u8], key: &aws_lc_rs::hmac::Key) -> bool {
    let Some(parts) = split_token(token) else {
        return false;
    };

    let mut signing_input =
        Vec::with_capacity(parts.header_b64.len() + 1 + parts.payload_b64.len());
    signing_input.extend_from_slice(parts.header_b64);
    signing_input.push(b'.');
    signing_input.extend_from_slice(parts.payload_b64);

    let sig = hmac_sha256_with_key(key, &signing_input);

    match b64url_decode(parts.sig_b64) {
        Some(provided) => ct_eq(&sig, &provided),
        None => false,
    }
}

// ── NAPI entry points ──────────────────────────────────────────

/// Sign a JWT (HS256). `claims` is any JSON value; when it is an object and a
/// positive `ttlSeconds` is given, `iat`/`exp` are injected (unless present).
/// `nowSeconds` is the caller-supplied current epoch seconds (keeps the core
/// time-free and testable). Returns the compact token bytes.
#[napi]
pub fn jwt_sign(
    claims: serde_json::Value,
    secret: Uint8Array,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Buffer> {
    let mut claims = claims;

    if let Some(obj) = claims.as_object_mut() {
        if let Some(ttl) = ttl_seconds {
            if ttl > 0 {
                obj.entry("iat")
                    .or_insert_with(|| serde_json::json!(now_seconds));
                obj.entry("exp")
                    .or_insert_with(|| serde_json::json!(now_seconds + ttl));
            }
        }
    }

    let header_b64 = jwt_header_b64();
    let payload_b64 = b64url_encode(&serde_json::to_vec(&claims).map_err(napi_err)?);

    Ok(Buffer::from(build_token(
        header_b64,
        &payload_b64,
        secret.as_ref(),
    )))
}

/// Pure-core JWT verification: HS256 signature + `alg` allowlist + time claims
/// (`exp`/`nbf`/`iat`). Returns the decoded claims, or `None` on any failure.
pub fn verify_token(token: &[u8], secret: &[u8], now_seconds: i64) -> Option<serde_json::Value> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    verify_token_with_key(token, &key, now_seconds)
}

/// Verify with a PRE-COMPILED key (no per-call key derivation).
pub fn verify_token_with_key(
    token: &[u8],
    key: &aws_lc_rs::hmac::Key,
    now_seconds: i64,
) -> Option<serde_json::Value> {
    if !verify_signature_with_key(token, key) {
        return None;
    }

    let parts = split_token(token)?;

    // ── Header: enforce the alg allowlist (prevents alg-confusion) ──
    // Fast path: the canonical HS256 header matches — accept without parsing
    // the header into a DOM. Otherwise fall back to the full parse (which
    // accepts alternative key order / extra header fields), so behavior is
    // identical to the previous always-parse path.
    if parts.header_b64 != jwt_header_b64() {
        let header: serde_json::Value =
            serde_json::from_slice(&b64url_decode(parts.header_b64)?).ok()?;
        if header.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
            return None;
        }
    }

    // ── Payload ──
    let value: serde_json::Value =
        serde_json::from_slice(&b64url_decode(parts.payload_b64)?).ok()?;

    // `exp`: reject when now >= exp.
    if let Some(exp) = value.get("exp").and_then(|v| v.as_i64()) {
        if now_seconds >= exp {
            return None;
        }
    }

    // `nbf` (not before): reject when the token is not yet valid.
    if let Some(nbf) = value.get("nbf").and_then(|v| v.as_i64()) {
        if now_seconds < nbf {
            return None;
        }
    }

    // `iat` (issued at): reject tokens issued in the future beyond a small
    // clock-skew leeway.
    if let Some(iat) = value.get("iat").and_then(|v| v.as_i64()) {
        if now_seconds < iat.saturating_sub(CLOCK_SKEW_LEEWAY_SECS) {
            return None;
        }
    }

    Some(value)
}

/// Verify a JWT (HS256 signature + time claims). Returns the decoded claims
/// object, or `null` on any failure (malformed, bad signature, wrong `alg`,
/// expired, not-yet-valid `nbf`/`iat`, non-JSON payload).
#[napi]
pub fn jwt_verify(token: Uint8Array, secret: Uint8Array, now_seconds: i64) -> serde_json::Value {
    verify_token(token.as_ref(), secret.as_ref(), now_seconds).unwrap_or(serde_json::Value::Null)
}

/// Higher-order instance: precompiles the HMAC-SHA256 key once from `secret`,
/// so `sign`/`verify` never re-derive the key on the per-call path. `ttl` is
/// fixed at construction (0/absent → no `iat`/`exp` injection).
#[napi]
pub struct JwtSigner {
    key: aws_lc_rs::hmac::Key,
    ttl_seconds: Option<i64>,
}

#[napi]
impl JwtSigner {
    #[napi(constructor)]
    pub fn new(secret: Uint8Array, ttl_seconds: Option<i64>) -> Self {
        Self {
            key: aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref()),
            ttl_seconds,
        }
    }

    /// Sign a JWT with the precompiled key. When `ttl` was set at construction,
    /// `iat`/`exp` are injected into object claims (unless already present).
    #[napi]
    pub fn sign(&self, claims: serde_json::Value, now_seconds: i64) -> Result<Buffer> {
        let mut claims = claims;
        if let Some(obj) = claims.as_object_mut() {
            if let Some(ttl) = self.ttl_seconds {
                if ttl > 0 {
                    obj.entry("iat")
                        .or_insert_with(|| serde_json::json!(now_seconds));
                    obj.entry("exp")
                        .or_insert_with(|| serde_json::json!(now_seconds + ttl));
                }
            }
        }

        let header_b64 = jwt_header_b64();
        let payload_b64 = b64url_encode(&serde_json::to_vec(&claims).map_err(napi_err)?);

        Ok(Buffer::from(build_token_with_key(
            header_b64,
            &payload_b64,
            &self.key,
        )))
    }

    /// Verify a JWT with the precompiled key (signature + `alg` + time claims).
    /// Returns the decoded claims, or `null` on any failure.
    #[napi]
    pub fn verify(&self, token: Uint8Array, now_seconds: i64) -> serde_json::Value {
        verify_token_with_key(token.as_ref(), &self.key, now_seconds)
            .unwrap_or(serde_json::Value::Null)
    }
}

fn napi_err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

/// Parallel sign batch: packed `[u32 count]{[u32 len][claims-json]}` in →
/// packed `[u32 count]{[u32 len][token]}` out (same secret/ttl/now for all).
#[napi]
pub fn jwt_sign_batch_packed(
    data: Uint8Array,
    secret: Uint8Array,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Buffer> {
    let items = crate::util::unpack(data.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 96);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    let sign_one = |claims_json: &[u8]| -> Vec<u8> {
        let Ok(claims) = serde_json::from_slice::<serde_json::Value>(claims_json) else {
            return Vec::new();
        };
        let mut claims = claims;
        if let Some(obj) = claims.as_object_mut() {
            if let Some(ttl) = ttl_seconds {
                if ttl > 0 {
                    obj.entry("iat")
                        .or_insert_with(|| serde_json::json!(now_seconds));
                    obj.entry("exp")
                        .or_insert_with(|| serde_json::json!(now_seconds + ttl));
                }
            }
        }
        let header_b64 = jwt_header_b64();
        let Ok(payload_bytes) = serde_json::to_vec(&claims) else {
            return Vec::new();
        };
        let payload_b64 = b64url_encode(&payload_bytes);
        build_token(header_b64, &payload_b64, secret.as_ref())
    };

    if crate::util::should_parallelize(items.len(), crate::util::total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items.par_iter().map(|c| sign_one(c)).collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for c in items {
            let r = sign_one(c);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

/// Parallel verify batch: packed `[u32 count]{[u32 len][token]}` in → bitset
/// (`[u32 count][ceil(n/8) bytes]`) of valid tokens.
#[napi]
pub fn jwt_verify_batch_packed(
    data: Uint8Array,
    secret: Uint8Array,
    now_seconds: i64,
) -> Result<Buffer> {
    let items = crate::util::unpack(data.as_ref())?;
    let n = items.len();

    let verify_one =
        |token: &[u8]| -> bool { verify_token(token, secret.as_ref(), now_seconds).is_some() };

    let mut out = Vec::with_capacity(4 + n.div_ceil(8));
    out.extend_from_slice(&(n as u32).to_le_bytes());

    let mut bits = vec![0u8; n.div_ceil(8)];
    if crate::util::should_parallelize(n, crate::util::total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<bool> = items.par_iter().map(|t| verify_one(t)).collect();
        for (i, ok) in results.into_iter().enumerate() {
            if ok {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
    } else {
        for (i, t) in items.iter().enumerate() {
            if verify_one(t) {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
    }

    out.extend_from_slice(&bits);
    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-key";

    fn token(claims: &serde_json::Value, secret: &[u8]) -> Vec<u8> {
        token_with_header(
            &serde_json::json!({ "alg": "HS256", "typ": "JWT" }),
            claims,
            secret,
        )
    }

    fn token_with_header(
        header: &serde_json::Value,
        claims: &serde_json::Value,
        secret: &[u8],
    ) -> Vec<u8> {
        let header_b64 = b64url_encode(&serde_json::to_vec(header).unwrap());
        let payload_b64 = b64url_encode(&serde_json::to_vec(claims).unwrap());
        build_token(&header_b64, &payload_b64, secret)
    }

    #[test]
    fn verify_token_rejects_wrong_alg() {
        // Regression: `alg` must be allowlisted. A token with a VALID HS256
        // signature but header `alg: "none"` (or any non-HS256) must be
        // rejected — otherwise alg-confusion attacks become possible later.
        let claims = serde_json::json!({ "sub": "1" });
        let none = token_with_header(
            &serde_json::json!({ "alg": "none", "typ": "JWT" }),
            &claims,
            SECRET,
        );
        assert!(verify_token(&none, SECRET, 1_000_000).is_none());

        let rs256 = token_with_header(
            &serde_json::json!({ "alg": "RS256", "typ": "JWT" }),
            &claims,
            SECRET,
        );
        assert!(verify_token(&rs256, SECRET, 1_000_000).is_none());
    }

    #[test]
    fn verify_token_enforces_nbf() {
        let claims = serde_json::json!({ "sub": "1", "nbf": 2_000_000 });
        let t = token(&claims, SECRET);
        // Before nbf -> rejected; at/after nbf -> accepted.
        assert!(verify_token(&t, SECRET, 1_999_999).is_none());
        assert!(verify_token(&t, SECRET, 2_000_000).is_some());
    }

    #[test]
    fn verify_token_enforces_iat_leeway() {
        let now = 1_000_000;
        // iat in the far future -> rejected (beyond 60s skew leeway).
        let far = token(
            &serde_json::json!({ "sub": "1", "iat": now + 10_000 }),
            SECRET,
        );
        assert!(verify_token(&far, SECRET, now).is_none());
        // iat within leeway -> accepted.
        let near = token(&serde_json::json!({ "sub": "1", "iat": now + 30 }), SECRET);
        assert!(verify_token(&near, SECRET, now).is_some());
    }

    #[test]
    fn verify_token_accepts_valid_claims() {
        let claims = serde_json::json!({ "sub": "123", "role": "admin" });
        let t = token(&claims, SECRET);
        let v = verify_token(&t, SECRET, 1_000_000).expect("valid token verifies");
        assert_eq!(v["sub"], "123");
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let claims = serde_json::json!({ "sub": "123", "name": "John", "role": "admin" });
        let t = token(&claims, SECRET);
        assert!(verify_signature(&t, SECRET));
    }

    #[test]
    fn verify_rejects_wrong_secret() {
        let claims = serde_json::json!({ "sub": "1" });
        let t = token(&claims, SECRET);
        assert!(!verify_signature(&t, b"wrong-secret"));
    }

    #[test]
    fn verify_rejects_tampered_payload() {
        let claims = serde_json::json!({ "sub": "1", "role": "user" });
        let t = token(&claims, SECRET);
        let first_dot = memchr(b'.', &t).unwrap();
        let second_rel = memchr(b'.', &t[first_dot + 1..]).unwrap();
        let payload_start = first_dot + 1;
        let payload_end = payload_start + second_rel;
        let mid = (payload_start + payload_end) / 2;

        let mut tampered = t.clone();
        tampered[mid] ^= 0x01;
        assert!(!verify_signature(&tampered, SECRET));
    }

    #[test]
    fn verify_rejects_malformed() {
        assert!(!verify_signature(b"no-dots-here", SECRET));
        assert!(!verify_signature(b"a.b.c.d", SECRET));
        assert!(!verify_signature(b".", SECRET));
        assert!(!verify_signature(b"", SECRET));
    }

    #[test]
    fn base64url_roundtrip() {
        let data = b"hello world \x00\xff binary";
        let enc = b64url_encode(data);
        assert_eq!(b64url_decode(&enc).unwrap(), data);
        assert!(!enc.contains(&b'='));
    }

    #[test]
    fn base64url_uses_urlsafe_alphabet() {
        // Bytes 0xfb 0xff encode to base64url "-_8" (no +/ or /).
        assert_eq!(b64url_encode(b"\xfb\xff"), b"-_8");
    }

    #[test]
    fn split_handles_three_segments() {
        let t = b"aaa.bbb.ccc";
        let parts = split_token(t).unwrap();
        assert_eq!(parts.header_b64, b"aaa");
        assert_eq!(parts.payload_b64, b"bbb");
        assert_eq!(parts.sig_b64, b"ccc");
    }

    #[test]
    fn jwt_signer_instance_roundtrips_and_injects_claims() {
        // Precompiled-key instance: sign+verify with no per-call key derivation.
        let signer = JwtSigner::new(Uint8Array::new(SECRET.to_vec()), Some(3600));
        let now = 1_000_000i64;

        let claims = serde_json::json!({ "sub": "123" });
        let token = signer.sign(claims.clone(), now).unwrap();

        // ttl injected iat/exp at construction time.
        let verified = signer.verify(Uint8Array::new(token.to_vec()), now);
        assert_eq!(verified["sub"], "123");
        assert_eq!(verified["iat"], now);
        assert_eq!(verified["exp"], now + 3600);

        // Same instance verifies, wrong key instance rejects.
        let other = JwtSigner::new(Uint8Array::new(b"other-secret".to_vec()), None);
        assert_eq!(
            other.verify(Uint8Array::new(token.to_vec()), now),
            serde_json::Value::Null
        );

        // No ttl -> no iat/exp injected.
        let no_ttl = JwtSigner::new(Uint8Array::new(SECRET.to_vec()), None);
        let t2 = no_ttl.sign(claims.clone(), now).unwrap();
        let v2 = no_ttl.verify(Uint8Array::new(t2.to_vec()), now);
        assert!(v2.get("iat").is_none());
        assert!(v2.get("exp").is_none());
    }
}
