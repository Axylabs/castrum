// rust/crypto/jwt/token.rs — HS256/EdDSA JWT token core (assembly + verification).
//
// Backend-framework feature: JWTs for auth. We implement HS256 by hand on top
// of the existing aws-lc-rs HMAC + base64 crates (no `jsonwebtoken` dep) to
// keep the dependency tree small and match this crate's byte-machinery style.
// RS256 (RSA via aws-lc-rs) can be layered on later.
//
// This is the pure token machinery: header constants, base64url (shared via
// `crate::crypto::base64`), HMAC-SHA256, split/build/verify, zero-DOM
// time-claim checks, and `iat`/`exp` injection. It is reused by the napi entry
// points (`napi.rs`), the C-ABI fast paths in `rust/ffi.rs`, and
// `crate::crypto::ed25519` keypair serialization. Only the
// `inject_and_payload_b64*` helpers touch napi types (`napi::Result`), because
// `rust/ffi.rs` reuses them; everything else is napi-free and unit-testable.

use memchr::memchr;
use napi::{Error, Result};
use sonic_rs::{JsonValueMutTrait, JsonValueTrait};
use std::sync::OnceLock;

use crate::crypto::base64::{base64url_decode_bytes, base64url_encode_bytes};

/// Clock-skew tolerance (seconds) for the `iat` claim in `jwt_verify`.
const CLOCK_SKEW_LEEWAY_SECS: i64 = 60;

/// The canonical HS256 JWT header (`{"alg":"HS256","typ":"JWT"}`), serialized
/// and base64url-encoded ONCE (lazily). `JwtSigner::sign`, the scalar
/// `jwt_sign` and the batch sign all reuse it instead of rebuilding +
/// re-serializing the constant header on every call.
static JWT_HEADER_B64: OnceLock<Vec<u8>> = OnceLock::new();

pub fn jwt_header_b64() -> &'static [u8] {
    JWT_HEADER_B64.get_or_init(|| {
        let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
        base64url_encode_bytes(
            &serde_json::to_vec(&header).expect("constant JWT header serializes"),
        )
    })
}

/// The canonical EdDSA (Ed25519) JWT header (`{"alg":"EdDSA","typ":"JWT"}`),
/// serialized + base64url-encoded ONCE (lazily) — twin of `jwt_header_b64`.
static EDDSA_HEADER_B64: OnceLock<Vec<u8>> = OnceLock::new();

pub fn eddsa_header_b64() -> &'static [u8] {
    EDDSA_HEADER_B64.get_or_init(|| {
        let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT" });
        base64url_encode_bytes(
            &serde_json::to_vec(&header).expect("constant JWT header serializes"),
        )
    })
}

// ── HMAC-SHA256 (aws-lc-rs) ────────────────────────────────────

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
    let sig_b64 = base64url_encode_bytes(&sig);

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
///
/// Test-only convenience over the fresh-key derivation: production code uses
/// `verify_signature_with_key` with a precompiled key.
#[cfg(test)]
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

    match base64url_decode_bytes(parts.sig_b64) {
        Some(provided) => ct_eq(&sig, &provided),
        None => false,
    }
}

// ── Claim injection (iat/exp) ──────────────────────────────────

/// Inject `iat`/`exp` into object claims when `ttl_seconds` is set, then
/// serialize + base64url-encode the payload. Shared by the scalar, instance,
/// and byte-JSON sign paths so the injection semantics can't drift.
pub fn inject_and_payload_b64(
    claims: &mut serde_json::Value,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Vec<u8>> {
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
    Ok(base64url_encode_bytes(
        &serde_json::to_vec(claims).map_err(napi_err)?,
    ))
}

/// Inject `iat`/`exp` into a sonic object when `ttl_seconds` is set (unless
/// already present) — shared by the sonic byte-sign paths.
pub(crate) fn inject_ttl_claims(
    claims: &mut sonic_rs::Value,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) {
    if let Some(ttl) = ttl_seconds {
        if ttl > 0 {
            if let Some(obj) = claims.as_object_mut() {
                if obj.get(&"iat").is_none() {
                    obj.insert("iat", now_seconds);
                }
                if obj.get(&"exp").is_none() {
                    obj.insert("exp", now_seconds + ttl);
                }
            }
        }
    }
}

/// Sonic twin of [`inject_and_payload_b64`] for the pre-serialized-claim-byte
/// sign paths (no `serde_json::Value` DOM): parse the claims once into a
/// compact `sonic_rs::Value`, inject `iat`/`exp`, serialize + base64url.
pub fn inject_and_payload_b64_sonic(
    claims: &mut sonic_rs::Value,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Vec<u8>> {
    inject_ttl_claims(claims, ttl_seconds, now_seconds);
    Ok(base64url_encode_bytes(
        &sonic_rs::to_vec(claims).map_err(napi_err)?,
    ))
}

fn napi_err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

// ── Verification ───────────────────────────────────────────────

/// Pure-core JWT verification: HS256 signature + `alg` allowlist + time claims
/// (`exp`/`nbf`/`iat`). Returns the decoded payload BYTES (valid JSON claims),
/// or `None` on any failure — no `serde_json::Value` DOM and no re-serialize.
pub fn verify_token(token: &[u8], secret: &[u8], now_seconds: i64) -> Option<Vec<u8>> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    verify_token_with_key(token, &key, now_seconds)
}

/// Zero-DOM time-claim checks over a base64url payload segment: `exp`
/// (reject when `now >= exp`), `nbf` (reject when not yet valid), `iat`
/// (reject tokens issued beyond the clock-skew leeway). Returns the decoded
/// payload bytes (valid JSON claims) or `None`. Shared by the HS256 and
/// EdDSA verify paths so the claim semantics can't drift.
pub(crate) fn verify_time_claims(payload_b64: &[u8], now_seconds: i64) -> Option<Vec<u8>> {
    let payload = base64url_decode_bytes(payload_b64)?;
    let value: sonic_rs::Value = sonic_rs::from_slice(&payload).ok()?;

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

    Some(payload)
}

/// Verify with a PRE-COMPILED key (no per-call key derivation). Time-claim
/// checks run over a compact `sonic_rs::Value` (zero per-key heap `String`);
/// the decoded payload bytes are returned verbatim.
pub fn verify_token_with_key(
    token: &[u8],
    key: &aws_lc_rs::hmac::Key,
    now_seconds: i64,
) -> Option<Vec<u8>> {
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
        let header: sonic_rs::Value =
            sonic_rs::from_slice(&base64url_decode_bytes(parts.header_b64)?).ok()?;
        if header.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
            return None;
        }
    }

    // ── Payload: decode once; zero-DOM time-claim checks (shared) ──
    verify_time_claims(parts.payload_b64, now_seconds)
}

// ── EdDSA (Ed25519) ────────────────────────────────────────────

/// Sign an EdDSA (Ed25519) JWT from pre-serialized claim JSON bytes. Claims
/// parsing/`iat`/`exp` injection is shared with the HS256 byte path; only the
/// signature primitive differs. Returns the compact token bytes, or `None` on
/// invalid claims JSON / invalid private key.
pub fn sign_eddsa(
    claims_json: &[u8],
    private_der: &[u8],
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Option<Vec<u8>> {
    let mut claims: sonic_rs::Value = sonic_rs::from_slice(claims_json).ok()?;
    let payload_b64 = inject_and_payload_b64_sonic(&mut claims, ttl_seconds, now_seconds).ok()?;
    build_eddsa_token(eddsa_header_b64(), &payload_b64, private_der)
}

/// Assemble an EdDSA token from base64url header + payload segments: sign
/// `header.payload` with the Ed25519 private key, append the base64url sig.
pub fn build_eddsa_token(
    header_b64: &[u8],
    payload_b64: &[u8],
    private_der: &[u8],
) -> Option<Vec<u8>> {
    let mut signing_input = Vec::with_capacity(header_b64.len() + 1 + payload_b64.len());
    signing_input.extend_from_slice(header_b64);
    signing_input.push(b'.');
    signing_input.extend_from_slice(payload_b64);
    let sig = crate::crypto::ed25519::sign(private_der, &signing_input)?;
    signing_input.push(b'.');
    signing_input.extend_from_slice(&base64url_encode_bytes(&sig));
    Some(signing_input)
}

/// Verify an EdDSA (Ed25519) JWT: signature + `alg` allowlist + time claims
/// (shared with the HS256 path). Returns the decoded payload bytes (valid JSON
/// claims), or `None` on any failure.
pub fn verify_token_eddsa(token: &[u8], public_der: &[u8], now_seconds: i64) -> Option<Vec<u8>> {
    let parts = split_token(token)?;

    // ── Header: enforce the alg allowlist (prevents alg-confusion) ──
    // Fast path: the canonical EdDSA header matches — accept without parsing.
    if parts.header_b64 != eddsa_header_b64() {
        let header: sonic_rs::Value =
            sonic_rs::from_slice(&base64url_decode_bytes(parts.header_b64)?).ok()?;
        if header.get("alg").and_then(|v| v.as_str()) != Some("EdDSA") {
            return None;
        }
    }

    // ── Signature: constant-time Ed25519 verify over `header.payload` ──
    let sig = base64url_decode_bytes(parts.sig_b64)?;
    let mut signing_input =
        Vec::with_capacity(parts.header_b64.len() + 1 + parts.payload_b64.len());
    signing_input.extend_from_slice(parts.header_b64);
    signing_input.push(b'.');
    signing_input.extend_from_slice(parts.payload_b64);
    if !crate::crypto::ed25519::verify(public_der, &signing_input, &sig) {
        return None;
    }

    verify_time_claims(parts.payload_b64, now_seconds)
}
