// rust/ffi/jwt.rs — JWT + Ed25519 C-ABI exports.
//
// HS256/EdDSA signing + verification and Ed25519 keypair/sign/verify for the
// RBAC auth path. Opaque-handle variants use the precompiled-key instances;
// the scalar variants derive the key per call.

use std::slice;

use super::util::{cstring_return, panic_guard};

/// JwtSigner: sign pre-serialized claim JSON with the PRECOMPILED key + ttl via
/// its opaque inner handle. Needed-size convention; 0 = invalid claims JSON /
/// null handle (real error).
///
/// # Safety
/// `inner` must be a valid `JwtSigner` pointer from `inner_ptr()`, alive for
/// the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_signer_sign(
    inner: usize,
    claims: *const u8,
    claims_len: usize,
    now_seconds: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || claims.is_null() || out.is_null() {
        return 0;
    }
    let c = slice::from_raw_parts(claims, claims_len);
    let Some(token) = panic_guard(
        || unsafe {
            crate::crypto::jwt::jwt_signer_sign_bytes_core(
                inner as *const crate::crypto::jwt::JwtSigner,
                c,
                now_seconds,
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if token.len() > out_cap {
        return token.len();
    }
    slice::from_raw_parts_mut(out, token.len()).copy_from_slice(&token);
    token.len()
}

/// JwtSigner: verify a JWT with the PRECOMPILED key → claims JSON bytes.
/// Returns bytes written (0 = invalid signature / expired / malformed → null).
///
/// # Safety
/// `inner` must be a valid `JwtSigner` pointer from `inner_ptr()`, alive for
/// the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_signer_verify(
    inner: usize,
    token: *const u8,
    token_len: usize,
    now_seconds: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || token.is_null() || out.is_null() {
        return 0;
    }
    let t = slice::from_raw_parts(token, token_len);
    let Some(claims) = panic_guard(
        || unsafe {
            crate::crypto::jwt::jwt_signer_verify_core(
                inner as *const crate::crypto::jwt::JwtSigner,
                t,
                now_seconds,
            )
        },
        None,
    ) else {
        return 0;
    };
    if claims.len() > out_cap {
        return claims.len();
    }
    slice::from_raw_parts_mut(out, claims.len()).copy_from_slice(&claims);
    claims.len()
}

/// Sign a JWT (HS256) from pre-serialized claim JSON bytes — the C-ABI sibling
/// of `jwt_sign_bytes`. `ttl <= 0` means no `iat`/`exp` injection (the napi
/// `Option<i64>` sentinel). Returns bytes written (0 on invalid claims JSON); a
/// result larger than `out_cap` reports the exact needed size (see
/// `compress_to_out!` for the convention).
///
/// # Safety
/// `claims`/`secret` must be valid for reads of their lengths; `out` for
/// writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_sign_bytes(
    claims: *const u8,
    clen: usize,
    secret: *const u8,
    slen: usize,
    ttl: i64,
    now: i64,
) -> *const std::os::raw::c_char {
    if claims.is_null() || secret.is_null() {
        return std::ptr::null();
    }
    // Wrap in panic_guard: sonic parse + token build allocate — a panic must
    // not unwind through the C ABI (process crash); it becomes null instead.
    let token = panic_guard(
        || {
            let Ok(mut value) =
                sonic_rs::from_slice::<sonic_rs::Value>(slice::from_raw_parts(claims, clen))
            else {
                return None;
            };
            let Ok(payload_b64) = crate::crypto::jwt::inject_and_payload_b64_sonic(
                &mut value,
                if ttl > 0 { Some(ttl) } else { None },
                now,
            ) else {
                return None;
            };
            Some(crate::crypto::jwt::build_token(
                crate::crypto::jwt::jwt_header_b64(),
                &payload_b64,
                slice::from_raw_parts(secret, slen),
            ))
        },
        None,
    );
    let Some(token) = token else {
        return std::ptr::null();
    };
    cstring_return(token.len(), |out| {
        out[..token.len()].copy_from_slice(&token);
        Some(token.len())
    })
}

/// Sign a JWT (HS256) written directly into a caller buffer — the pooled
/// sibling of `castrum_jwt_sign_bytes` (no cstring round-trip; the caller
/// sizes from the claim JSON — same bound the cstring path uses). Returns
/// bytes written, the exact required size when `out_cap` is too small, or 0 on
/// invalid claims JSON.
///
/// # Safety
/// `claims`/`secret` must be valid for reads of their lengths; `out` for
/// writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_sign_bytes_into(
    claims: *const u8,
    clen: usize,
    secret: *const u8,
    slen: usize,
    ttl: i64,
    now: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if claims.is_null() || secret.is_null() || out.is_null() {
        return 0;
    }
    // Wrap in panic_guard: sonic parse + token build allocate — a panic must
    // not unwind through the C ABI (process crash); it becomes 0 instead.
    let token = panic_guard(
        || {
            let Ok(mut value) =
                sonic_rs::from_slice::<sonic_rs::Value>(slice::from_raw_parts(claims, clen))
            else {
                return None;
            };
            let Ok(payload_b64) = crate::crypto::jwt::inject_and_payload_b64_sonic(
                &mut value,
                if ttl > 0 { Some(ttl) } else { None },
                now,
            ) else {
                return None;
            };
            Some(crate::crypto::jwt::build_token(
                crate::crypto::jwt::jwt_header_b64(),
                &payload_b64,
                slice::from_raw_parts(secret, slen),
            ))
        },
        None,
    );
    let Some(token) = token else {
        return 0;
    };
    if out_cap < token.len() {
        // Needed-size convention: exact retry, no re-run.
        return token.len();
    }
    let o = slice::from_raw_parts_mut(out, token.len());
    o.copy_from_slice(&token);
    token.len()
}

/// Verify an HS256 compact JWT → its claims as a null-terminated JSON C string
/// into the per-thread reused buffer (`cstring` return). `null` on invalid
/// signature / expired / malformed. This replaces the NAPI `jwtVerify` object
/// marshal (which builds a `serde_json::Value` + napi value on the verify
/// path) with a plain string crossing for the claims.
///
/// # Safety
/// `token`/`secret` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_verify(
    token: *const u8,
    tlen: usize,
    secret: *const u8,
    slen: usize,
    now: i64,
) -> *const std::os::raw::c_char {
    if token.is_null() || secret.is_null() {
        return std::ptr::null();
    }
    let claims = panic_guard(
        || {
            crate::crypto::jwt::verify_token(
                slice::from_raw_parts(token, tlen),
                slice::from_raw_parts(secret, slen),
                now,
            )
        },
        None,
    );
    let Some(json) = claims else {
        return std::ptr::null();
    };
    cstring_return(json.len(), |out| {
        out[..json.len()].copy_from_slice(&json);
        Some(json.len())
    })
}

// ── Ed25519 / EdDSA JWT (RBAC auth) ────────────────────────────
// Ed25519 keypair generation + sign/verify for the EdDSA JWT path used by the
// auth module. Key formats: PKCS#8 v1 DER (private, 48 B) + SPKI DER (public,
// 44 B) — byte-identical to Node `crypto` exports, so the pure-TS fallback and
// the Rust addon produce the same `.env` keys.

/// Generate an Ed25519 keypair → packed `[u32 privLen][priv PKCS#8 v1 DER]
/// [u32 pubLen][pub SPKI DER]` (100 bytes total) written into `out`. Returns
/// bytes written, the exact required size when `out_cap` is too small, or 0
/// on CSPRNG failure.
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ed25519_generate_keypair(
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if out.is_null() {
        return 0;
    }
    let priv_len = crate::crypto::ed25519::ED25519_PKCS8_V1_LEN;
    let pub_len = crate::crypto::ed25519::ED25519_SPKI_LEN;
    let packed_len = 4 + priv_len + 4 + pub_len; // 100
    if out_cap < packed_len {
        // Needed-size convention: exact required size, no re-run.
        return packed_len;
    }
    let result = panic_guard(crate::crypto::ed25519::generate_keypair, None);
    let Some((private_der, public_der)) = result else {
        return 0;
    };
    let o = slice::from_raw_parts_mut(out, packed_len);
    o[0..4].copy_from_slice(&(private_der.len() as u32).to_le_bytes());
    o[4..4 + private_der.len()].copy_from_slice(&private_der);
    let pub_start = 4 + private_der.len();
    o[pub_start..pub_start + 4].copy_from_slice(&(public_der.len() as u32).to_le_bytes());
    o[pub_start + 4..packed_len].copy_from_slice(&public_der);
    packed_len
}

/// Sign a message with an Ed25519 private key (PKCS#8 DER) → the 64-byte
/// signature written into `out`. Returns bytes written (64), the exact
/// required size when `out_cap` is too small, or 0 on invalid private key.
///
/// # Safety
/// `key`/`msg` must be valid for reads of their lengths; `out` for writes up
/// to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ed25519_sign(
    key: *const u8,
    klen: usize,
    msg: *const u8,
    mlen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if key.is_null() || msg.is_null() || out.is_null() {
        return 0;
    }
    let sig_len = crate::crypto::ed25519::ED25519_SIGNATURE_LEN; // 64
    if out_cap < sig_len {
        return sig_len; // exact needed size
    }
    let sig = panic_guard(
        || {
            crate::crypto::ed25519::sign(
                slice::from_raw_parts(key, klen),
                slice::from_raw_parts(msg, mlen),
            )
        },
        None,
    );
    let Some(sig) = sig else {
        return 0; // invalid private key — real error
    };
    slice::from_raw_parts_mut(out, sig_len).copy_from_slice(&sig);
    sig_len
}

/// Verify a 64-byte Ed25519 signature over `msg` with an SPKI DER (or raw
/// 32-byte) public key. Returns 1 (valid) or 0 (invalid).
///
/// # Safety
/// `key`/`msg`/`sig` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_ed25519_verify(
    key: *const u8,
    klen: usize,
    msg: *const u8,
    mlen: usize,
    sig: *const u8,
    slen: usize,
) -> u32 {
    if key.is_null() || msg.is_null() || sig.is_null() {
        return 0;
    }
    let valid = panic_guard(
        || {
            crate::crypto::ed25519::verify(
                slice::from_raw_parts(key, klen),
                slice::from_raw_parts(msg, mlen),
                slice::from_raw_parts(sig, slen),
            )
        },
        false,
    );
    valid as u32
}

/// Sign an EdDSA (Ed25519) JWT from pre-serialized claim JSON → compact token
/// as a null-terminated C string (cstring return — the engine clones it). `ttl
/// <= 0` means no `iat`/`exp` injection. `null` on invalid claims JSON /
/// invalid private key.
///
/// # Safety
/// `claims`/`key` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_eddsa_sign(
    claims: *const u8,
    clen: usize,
    key: *const u8,
    klen: usize,
    ttl: i64,
    now: i64,
) -> *const std::os::raw::c_char {
    if claims.is_null() || key.is_null() {
        return std::ptr::null();
    }
    let token = panic_guard(
        || {
            crate::crypto::jwt::sign_eddsa(
                slice::from_raw_parts(claims, clen),
                slice::from_raw_parts(key, klen),
                if ttl > 0 { Some(ttl) } else { None },
                now,
            )
        },
        None,
    );
    let Some(token) = token else {
        return std::ptr::null();
    };
    cstring_return(token.len(), |out| {
        out[..token.len()].copy_from_slice(&token);
        Some(token.len())
    })
}

/// Verify an EdDSA (Ed25519) JWT → its claims as a null-terminated JSON C
/// string (cstring return). `null` on invalid signature / expired / malformed.
///
/// # Safety
/// `token`/`key` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_jwt_eddsa_verify(
    token: *const u8,
    tlen: usize,
    key: *const u8,
    klen: usize,
    now: i64,
) -> *const std::os::raw::c_char {
    if token.is_null() || key.is_null() {
        return std::ptr::null();
    }
    let claims = panic_guard(
        || {
            crate::crypto::jwt::verify_token_eddsa(
                slice::from_raw_parts(token, tlen),
                slice::from_raw_parts(key, klen),
                now,
            )
        },
        None,
    );
    let Some(json) = claims else {
        return std::ptr::null();
    };
    cstring_return(json.len(), |out| {
        out[..json.len()].copy_from_slice(&json);
        Some(json.len())
    })
}
