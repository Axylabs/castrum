// rust/crypto/jwt/api.rs — napi entry points for JWT signing/verification.
//
// Thin napi boundary over the pure token core in `token.rs`: scalar sign/
// verify, the precompiled-key `JwtSigner` instance, the C-ABI `_core` helpers
// consumed by `rust/ffi.rs`, and the packed sign/verify batches.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::crypto::base64::base64url_encode_bytes;

use super::{
    build_token, build_token_with_key, inject_and_payload_b64, inject_and_payload_b64_sonic,
    inject_ttl_claims, jwt_header_b64, sign_eddsa, verify_token, verify_token_eddsa,
    verify_token_with_key,
};

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
    let payload_b64 = inject_and_payload_b64(&mut claims, ttl_seconds, now_seconds)?;
    Ok(Buffer::from(build_token(
        jwt_header_b64(),
        &payload_b64,
        secret.as_ref(),
    )))
}

/// Sign a JWT (HS256) from pre-serialized claim JSON bytes. Avoids the napi
/// `serde_json::Value` DOM marshal of `jwt_sign` for callers that already hold
/// the claim bytes (e.g. JSON.stringify'd on the JS side). The claims are
/// parsed straight into a `sonic_rs::Value` (compact, no per-key heap
/// `String`). Semantics are identical to `jwt_sign` (incl. `iat`/`exp`
/// injection).
#[napi]
pub fn jwt_sign_bytes(
    claims_json: Uint8Array,
    secret: Uint8Array,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Buffer> {
    let mut claims: sonic_rs::Value =
        sonic_rs::from_slice(claims_json.as_ref()).map_err(napi_err)?;
    let payload_b64 = inject_and_payload_b64_sonic(&mut claims, ttl_seconds, now_seconds)?;
    Ok(Buffer::from(build_token(
        jwt_header_b64(),
        &payload_b64,
        secret.as_ref(),
    )))
}

/// Verify a JWT (HS256 signature + time claims). Returns the decoded claims
/// object (marshaled from the compact sonic Value), or `null` on any failure
/// (malformed, bad signature, wrong `alg`, expired, not-yet-valid `nbf`/`iat`,
/// non-JSON payload).
#[napi]
pub fn jwt_verify(
    env: Env,
    token: Uint8Array,
    secret: Uint8Array,
    now_seconds: i64,
) -> Result<Unknown<'static>> {
    let Some(payload) = verify_token(token.as_ref(), secret.as_ref(), now_seconds) else {
        return crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new());
    };
    match sonic_rs::from_slice::<sonic_rs::Value>(&payload) {
        Ok(v) => crate::json::napi_marshal::sonic_value_to_js(&env, &v),
        // The payload already parsed for the time-claim check — unreachable.
        Err(_) => crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new()),
    }
}

/// Sign an EdDSA (Ed25519) JWT from pre-serialized claim JSON bytes. Semantics
/// identical to `jwt_sign_bytes` (incl. `iat`/`exp` injection); the signature
/// is Ed25519 (RFC 8032) under the `EdDSA` alg.
#[napi]
pub fn jwt_sign_eddsa(
    claims_json: Uint8Array,
    private_key: Uint8Array,
    ttl_seconds: Option<i64>,
    now_seconds: i64,
) -> Result<Buffer> {
    match sign_eddsa(
        claims_json.as_ref(),
        private_key.as_ref(),
        ttl_seconds,
        now_seconds,
    ) {
        Some(token) => Ok(Buffer::from(token)),
        None => Err(Error::from_reason(
            "EdDSA sign failed (invalid claims or private key)",
        )),
    }
}

/// Verify an EdDSA (Ed25519) JWT (signature + time claims). Returns the decoded
/// claims object, or `null` on any failure.
#[napi]
pub fn jwt_verify_eddsa(
    env: Env,
    token: Uint8Array,
    public_key: Uint8Array,
    now_seconds: i64,
) -> Result<Unknown<'static>> {
    let Some(payload) = verify_token_eddsa(token.as_ref(), public_key.as_ref(), now_seconds) else {
        return crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new());
    };
    match sonic_rs::from_slice::<sonic_rs::Value>(&payload) {
        Ok(v) => crate::json::napi_marshal::sonic_value_to_js(&env, &v),
        // The payload already parsed for the time-claim check — unreachable.
        Err(_) => crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new()),
    }
}

/// Higher-order instance: precompiles the HMAC-SHA256 key once from `secret`,
/// so `sign`/`verify` never re-derive the key on the per-call path. `ttl` is
/// fixed at construction (0/absent → no `iat`/`exp` injection).
#[napi]
pub struct JwtSigner {
    pub(crate) key: aws_lc_rs::hmac::Key,
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

    /// Opaque handle to the precompiled key + ttl, for the `bun:ffi` C-ABI
    /// fast path (`castrum_jwt_signer_*` in rust/ffi.rs). Only valid while THIS
    /// instance is alive; the JS wrapper holds the instance.
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        self as *const JwtSigner as u64
    }

    /// Sign a JWT with the precompiled key. When `ttl` was set at construction,
    /// `iat`/`exp` are injected into object claims (unless already present).
    #[napi]
    pub fn sign(&self, claims: serde_json::Value, now_seconds: i64) -> Result<Buffer> {
        let mut claims = claims;
        let payload_b64 = inject_and_payload_b64(&mut claims, self.ttl_seconds, now_seconds)?;
        Ok(Buffer::from(build_token_with_key(
            jwt_header_b64(),
            &payload_b64,
            &self.key,
        )))
    }

    /// Sign a JWT from pre-serialized claim JSON bytes with the precompiled
    /// key — no napi `serde_json::Value` marshal, no per-call key derivation.
    #[napi]
    pub fn sign_bytes(&self, claims_json: Uint8Array, now_seconds: i64) -> Result<Buffer> {
        let mut claims: sonic_rs::Value =
            sonic_rs::from_slice(claims_json.as_ref()).map_err(napi_err)?;
        let payload_b64 = inject_and_payload_b64_sonic(&mut claims, self.ttl_seconds, now_seconds)?;
        Ok(Buffer::from(build_token_with_key(
            jwt_header_b64(),
            &payload_b64,
            &self.key,
        )))
    }

    /// Verify a JWT with the precompiled key (signature + `alg` + time claims).
    /// Returns the decoded claims object, or `null` on any failure.
    #[napi]
    pub fn verify(
        &self,
        env: Env,
        token: Uint8Array,
        now_seconds: i64,
    ) -> Result<Unknown<'static>> {
        let Some(payload) = verify_token_with_key(token.as_ref(), &self.key, now_seconds) else {
            return crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new());
        };
        match sonic_rs::from_slice::<sonic_rs::Value>(&payload) {
            Ok(v) => crate::json::napi_marshal::sonic_value_to_js(&env, &v),
            // The payload already parsed for the time-claim check — unreachable.
            Err(_) => crate::json::napi_marshal::sonic_value_to_js(&env, &sonic_rs::Value::new()),
        }
    }
}

/// C-ABI support: sign pre-serialized claim JSON with the precompiled key.
/// `Err(())` on invalid claims JSON (napi parity: throws).
///
/// # Safety
/// `p` must be a valid `*const JwtSigner` from `inner_ptr`, alive for the call.
pub(crate) unsafe fn jwt_signer_sign_bytes_core(
    p: *const JwtSigner,
    claims_json: &[u8],
    now_seconds: i64,
) -> std::result::Result<Vec<u8>, ()> {
    let this = &*p;
    let mut claims: sonic_rs::Value = sonic_rs::from_slice(claims_json).map_err(|_| ())?;
    let payload_b64 =
        inject_and_payload_b64_sonic(&mut claims, this.ttl_seconds, now_seconds).map_err(|_| ())?;
    Ok(build_token_with_key(
        jwt_header_b64(),
        &payload_b64,
        &this.key,
    ))
}

/// C-ABI support: verify a JWT with the precompiled key → the decoded payload
/// BYTES (valid JSON claims), or None on invalid signature / expired /
/// malformed. No `serde_json::Value` DOM, no re-serialize.
///
/// # Safety
/// `p` must be a valid `*const JwtSigner` from `inner_ptr`, alive for the call.
pub(crate) unsafe fn jwt_signer_verify_core(
    p: *const JwtSigner,
    token: &[u8],
    now_seconds: i64,
) -> Option<Vec<u8>> {
    let this = &*p;
    verify_token_with_key(token, &this.key, now_seconds)
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
    // Derive the HMAC key ONCE for the whole batch (build_token derives a
    // fresh key per call), then route through the shared packed batch helper
    // (zero-alloc serial PackedIter path; rayon direct-write when justified).
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());

    let sign_one = |claims_json: &[u8]| -> Vec<u8> {
        let Ok(mut claims) = sonic_rs::from_slice::<sonic_rs::Value>(claims_json) else {
            return Vec::new();
        };
        inject_ttl_claims(&mut claims, ttl_seconds, now_seconds);
        let header_b64 = jwt_header_b64();
        let Ok(payload_bytes) = sonic_rs::to_vec(&claims) else {
            return Vec::new();
        };
        let payload_b64 = base64url_encode_bytes(&payload_bytes);
        build_token_with_key(header_b64, &payload_b64, &key)
    };

    crate::util::run_packed_batch(data.as_ref(), sign_one).map(Buffer::from)
}

/// Parallel verify batch: packed `[u32 count]{[u32 len][token]}` in → bitset
/// (`[u32 count][ceil(n/8) bytes]`) of valid tokens.
#[napi]
pub fn jwt_verify_batch_packed(
    data: Uint8Array,
    secret: Uint8Array,
    now_seconds: i64,
) -> Result<Buffer> {
    // Derive the HMAC key ONCE for the whole batch (verify_token derives a
    // fresh key per call), then route through the shared bitset batch helper
    // (zero-alloc serial PackedIter path; rayon direct-write when justified).
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    crate::util::run_bitset_batch(
        data.as_ref(),
        |token| verify_token_with_key(token, &key, now_seconds).is_some(),
        4096,
    )
    .map(Buffer::from)
}
