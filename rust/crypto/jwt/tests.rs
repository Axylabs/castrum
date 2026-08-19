// rust/crypto/jwt/tests.rs — unit tests for the JWT core + napi entry points.
//
// Exercises the token core in `token.rs` and the napi boundary in `napi.rs`.
// The old local base64url helpers were consolidated into
// `crate::crypto::base64`; the tests import them under their former `b64url_*`
// names so the assertions read the same.

use super::*;
use crate::crypto::base64::{
    base64url_decode_bytes as b64url_decode, base64url_encode_bytes as b64url_encode,
};
use napi::bindgen_prelude::*;
use sonic_rs::JsonValueTrait;

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
    let payload = verify_token(&t, SECRET, 1_000_000).expect("valid token verifies");
    let v: sonic_rs::Value = sonic_rs::from_slice(&payload).unwrap();
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
    let first_dot = memchr::memchr(b'.', &t).unwrap();
    let second_rel = memchr::memchr(b'.', &t[first_dot + 1..]).unwrap();
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
    let verified_payload =
        verify_token_with_key(&token, &signer.key, now).expect("token verifies");
    let verified: sonic_rs::Value = sonic_rs::from_slice(&verified_payload).unwrap();
    assert_eq!(verified["sub"], "123");
    assert_eq!(verified["iat"], now);
    assert_eq!(verified["exp"], now + 3600);

    // Same instance verifies, wrong key instance rejects.
    let other = JwtSigner::new(Uint8Array::new(b"other-secret".to_vec()), None);
    assert!(verify_token_with_key(&token, &other.key, now).is_none());

    // No ttl -> no iat/exp injected.
    let no_ttl = JwtSigner::new(Uint8Array::new(SECRET.to_vec()), None);
    let t2 = no_ttl.sign(claims.clone(), now).unwrap();
    let v2_payload = verify_token_with_key(&t2, &no_ttl.key, now).unwrap();
    let v2: sonic_rs::Value = sonic_rs::from_slice(&v2_payload).unwrap();
    assert!(v2.get("iat").is_none());
    assert!(v2.get("exp").is_none());
}

#[test]
fn jwt_sign_bytes_matches_value_sign_and_verifies() {
    let claims_json = br#"{"sub":"123","name":"John"}"#.to_vec();
    let secret = Uint8Array::new(SECRET.to_vec());

    // Byte-JSON sign (no napi Value marshal) matches the Value sign
    // semantically. Key ORDER differs between the two serializers — sonic
    // (`sort_keys` → BTreeMap) emits sorted keys, serde_json
    // (`preserve_order` → IndexMap) emits insertion order — so compare the
    // decoded claims, not the raw token bytes.
    let from_bytes = jwt_sign_bytes(
        Uint8Array::new(claims_json.clone()),
        secret,
        None,
        1_000_000,
    )
    .unwrap();
    let claims: serde_json::Value = serde_json::from_slice(&claims_json).unwrap();
    let from_value =
        jwt_sign(claims, Uint8Array::new(SECRET.to_vec()), None, 1_000_000).unwrap();
    let claims_from_bytes: sonic_rs::Value = sonic_rs::from_slice(
        &b64url_decode(split_token(&from_bytes).unwrap().payload_b64).unwrap(),
    )
    .unwrap();
    let claims_from_value: sonic_rs::Value = sonic_rs::from_slice(
        &b64url_decode(split_token(&from_value).unwrap().payload_b64).unwrap(),
    )
    .unwrap();
    assert_eq!(claims_from_bytes, claims_from_value);

    // The bytes-signed token verifies and carries the claims.
    let verified_payload = verify_token(from_bytes.as_ref(), SECRET, 1_000_000).unwrap();
    let verified: sonic_rs::Value = sonic_rs::from_slice(&verified_payload).unwrap();
    assert_eq!(verified["sub"], "123");
    assert_eq!(verified["name"], "John");
}

#[test]
fn jwt_sign_bytes_injects_ttl_and_instance_sign_bytes_works() {
    let claims_json = br#"{"sub":"123"}"#.to_vec();
    let token = jwt_sign_bytes(
        Uint8Array::new(claims_json.clone()),
        Uint8Array::new(SECRET.to_vec()),
        Some(3600),
        1_000_000,
    )
    .unwrap();
    let payload = verify_token(&token, SECRET, 1_000_000).unwrap();
    let v: sonic_rs::Value = sonic_rs::from_slice(&payload).unwrap();
    assert_eq!(v["iat"], 1_000_000);
    assert_eq!(v["exp"], 1_000_000 + 3600);

    // Precompiled-key instance: sign_bytes injects its construction ttl.
    let signer = JwtSigner::new(Uint8Array::new(SECRET.to_vec()), Some(3600));
    let t2 = signer
        .sign_bytes(Uint8Array::new(claims_json), 2_000_000)
        .unwrap();
    let v2_payload = verify_token_with_key(&t2, &signer.key, 2_000_000).unwrap();
    let v2: sonic_rs::Value = sonic_rs::from_slice(&v2_payload).unwrap();
    assert_eq!(v2["iat"], 2_000_000);
    assert_eq!(v2["exp"], 2_000_000 + 3600);
}

#[test]
fn eddsa_sign_verify_round_trip() {
    let (private_der, public_der) = crate::crypto::ed25519::generate_keypair().unwrap();
    let claims_json = br#"{"sub":"user-1","roles":["admin"]}"#.to_vec();

    let token = sign_eddsa(&claims_json, &private_der, None, 1_000_000).unwrap();
    // Compact token: exactly two dots, EdDSA header.
    let parts = split_token(&token).unwrap();
    assert_eq!(
        b64url_decode(parts.header_b64).unwrap(),
        br#"{"alg":"EdDSA","typ":"JWT"}"#
    );

    // Verifies with the matching public key.
    let payload = verify_token_eddsa(&token, &public_der, 1_000_000).unwrap();
    let v: sonic_rs::Value = sonic_rs::from_slice(&payload).unwrap();
    assert_eq!(v["sub"], "user-1");
    assert_eq!(v["roles"][0], "admin");

    // Wrong public key (a different keypair) fails.
    let (_, other_pub) = crate::crypto::ed25519::generate_keypair().unwrap();
    assert!(verify_token_eddsa(&token, &other_pub, 1_000_000).is_none());

    // Tampered payload fails (signature over header.payload is invalid).
    let mut bad = token.clone();
    let n = bad.len();
    bad[n - 2] ^= 0x01;
    assert!(verify_token_eddsa(&bad, &public_der, 1_000_000).is_none());
}

#[test]
fn eddsa_injects_ttl_and_enforces_time_claims() {
    let (private_der, public_der) = crate::crypto::ed25519::generate_keypair().unwrap();
    let claims_json = br#"{"sub":"user-1"}"#.to_vec();

    let token = sign_eddsa(&claims_json, &private_der, Some(3600), 1_000_000).unwrap();
    let v: sonic_rs::Value =
        sonic_rs::from_slice(&verify_token_eddsa(&token, &public_der, 1_000_000).unwrap())
            .unwrap();
    assert_eq!(v["iat"], 1_000_000);
    assert_eq!(v["exp"], 1_000_000 + 3600);

    // Expired token rejected.
    assert!(verify_token_eddsa(&token, &public_der, 1_000_000 + 3600).is_none());
    // Not-yet-valid (future iat beyond leeway) rejected.
    let future = sign_eddsa(&claims_json, &private_der, Some(3600), 1_000_000).unwrap();
    assert!(verify_token_eddsa(&future, &public_der, 1_000_000 - 61).is_none());
    assert!(verify_token_eddsa(&future, &public_der, 1_000_000).is_some());
}

#[test]
fn eddsa_rejects_wrong_alg_and_malformed() {
    let (private_der, public_der) = crate::crypto::ed25519::generate_keypair().unwrap();
    let claims_json = br#"{"sub":"x"}"#.to_vec();
    let token = sign_eddsa(&claims_json, &private_der, None, 1_000_000).unwrap();

    // Swap the header alg to HS256 while keeping a valid Ed25519 signature
    // over the new header.payload — the alg allowlist must reject it.
    let header_b64 = b64url_encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let parts = split_token(&token).unwrap();
    let mut forged_input = Vec::new();
    forged_input.extend_from_slice(&header_b64);
    forged_input.push(b'.');
    forged_input.extend_from_slice(parts.payload_b64);
    let sig = crate::crypto::ed25519::sign(&private_der, &forged_input).unwrap();
    let mut forged = forged_input;
    forged.push(b'.');
    forged.extend_from_slice(&b64url_encode(&sig));
    assert!(verify_token_eddsa(&forged, &public_der, 1_000_000).is_none());

    // Malformed tokens.
    assert!(verify_token_eddsa(b"not-a-token", &public_der, 1_000_000).is_none());
    assert!(verify_token_eddsa(b"a.b.c.d", &public_der, 1_000_000).is_none());
    assert!(verify_token_eddsa(&token, &[], 1_000_000).is_none());
}
