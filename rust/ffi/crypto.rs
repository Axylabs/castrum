// rust/ffi/crypto.rs — crypto C-ABI exports (hmac / cookies / csrf / passwords /
// aead / base64 / random token).
//
// Compiled keys go through `hmac_key_cached` (per-thread LRU — see `util.rs`);
// fallible / allocating cores route through `panic_guard`.

use aws_lc_rs::hmac;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use std::slice;

use super::util::{aead_alg, cstring_return, hmac_key_cached, panic_guard};

/// HMAC-SHA256 verify → 1/0 (constant-time, hex sig compared after
/// whitespace-trim — mirrors the napi scalar path).
///
/// # Safety
/// `key`/`data`/`sig` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_hmac_sha256_verify(
    key: *const u8,
    klen: usize,
    data: *const u8,
    dlen: usize,
    sig: *const u8,
    slen: usize,
) -> u8 {
    if key.is_null() || data.is_null() || sig.is_null() {
        return 0;
    }
    let sig_t = crate::util::bytes::trim_ascii_whitespace(slice::from_raw_parts(sig, slen));
    let Some(sig_bytes) = crate::util::bytes::hex_decode_32(sig_t) else {
        return 0;
    };
    let k = hmac_key_cached(slice::from_raw_parts(key, klen));
    u8::from(hmac::verify(&k, slice::from_raw_parts(data, dlen), &sig_bytes).is_ok())
}

/// CSRF constant-time verify → 1/0 (token format `<64-hex>.<64-hex>`).
///
/// # Safety
/// `token`/`secret` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_csrf_verify(
    token: *const u8,
    tlen: usize,
    secret: *const u8,
    slen: usize,
) -> u8 {
    if token.is_null() || secret.is_null() {
        return 0;
    }
    let k = hmac_key_cached(slice::from_raw_parts(secret, slen));
    u8::from(crate::crypto::csrf::csrf_verify_with_key(
        slice::from_raw_parts(token, tlen),
        &k,
    ))
}

/// Argon2id password verify → 1/0 (constant-time internally).
///
/// # Safety
/// `password`/`phc` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_password_verify(
    password: *const u8,
    plen: usize,
    phc: *const u8,
    phclen: usize,
) -> u8 {
    if password.is_null() || phc.is_null() {
        return 0;
    }
    u8::from(crate::crypto::argon2::verify_password(
        slice::from_raw_parts(password, plen),
        slice::from_raw_parts(phc, phclen),
    ))
}

/// bcrypt password verify → 1/0 (PHC `$2b$` string).
///
/// `hash` is a `bun:ffi` `cstring` ARG (the engine transcodes the JS PHC string
/// in-engine; the callee borrows via `CStr::from_ptr`). The password stays a
/// `(ptr,len)` byte slice — it may contain arbitrary bytes (including NUL).
///
/// # Safety
/// `password` must be valid for reads of `plen` bytes; `hash` must be a valid
/// NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn castrum_password_verify_bcrypt(
    password: *const u8,
    plen: usize,
    hash: *const std::os::raw::c_char,
) -> u8 {
    if password.is_null() || hash.is_null() {
        return 0;
    }
    let Ok(h) = std::ffi::CStr::from_ptr(hash).to_str() else {
        return 0;
    };
    u8::from(bcrypt::verify(slice::from_raw_parts(password, plen), h).unwrap_or(false))
}

/// HMAC-SHA256 hex (64 chars) into `out`.
///
/// # Safety
/// `key`/`data` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_hmac_sha256(
    key: *const u8,
    klen: usize,
    data: *const u8,
    dlen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if key.is_null() || data.is_null() || out.is_null() || out_cap < 64 {
        return 0;
    }
    let k = hmac_key_cached(slice::from_raw_parts(key, klen));
    let tag = hmac::sign(&k, slice::from_raw_parts(data, dlen));
    let mut hex = [0u8; 64];
    crate::util::bytes::hex_encode_32(tag.as_ref(), &mut hex);
    slice::from_raw_parts_mut(out, 64).copy_from_slice(&hex);
    64
}

/// Sign a cookie `value` as `value.<64-hex sig>`, returned as a null-terminated
/// C string into the per-thread reused buffer (`cstring` return).
///
/// # Safety
/// `value`/`secret` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_sign_cookie(
    value: *const u8,
    vlen: usize,
    secret: *const u8,
    slen: usize,
) -> *const std::os::raw::c_char {
    if value.is_null() || secret.is_null() {
        return std::ptr::null();
    }
    let v = slice::from_raw_parts(value, vlen);
    let key = hmac_key_cached(slice::from_raw_parts(secret, slen));
    cstring_return(vlen + 65, |out| {
        crate::crypto::cookie_sign::sign_cookie_into(v, &key, out)
    })
}

/// Sign a cookie `value` as `value.<64-hex sig>` written directly into a caller
/// buffer — the pooled sibling of `castrum_sign_cookie` (no cstring round-trip;
/// this is the path `signCookieInto` must use). Writes `vlen + 65` bytes;
/// returns bytes written, the exact required size when `out_cap` is too small,
/// or 0 on invalid input.
///
/// # Safety
/// `value`/`secret` must be valid for reads of their lengths; `out` for writes
/// up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_sign_cookie_into(
    value: *const u8,
    vlen: usize,
    secret: *const u8,
    slen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if value.is_null() || secret.is_null() || out.is_null() {
        return 0;
    }
    let needed = vlen + 65;
    if out_cap < needed {
        return needed;
    }
    let v = slice::from_raw_parts(value, vlen);
    let key = hmac_key_cached(slice::from_raw_parts(secret, slen));
    crate::crypto::cookie_sign::sign_cookie_into(v, &key, slice::from_raw_parts_mut(out, out_cap))
        .unwrap_or_default()
}

/// Verify a signed cookie → the value without its signature, returned as a
/// null-terminated C string into the per-thread reused buffer. `null` on an
/// invalid signature / malformed input (the JS side maps to verify-fail).
///
/// # Safety
/// `signed`/`secret` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_verify_cookie(
    signed: *const u8,
    slen: usize,
    secret: *const u8,
    klen: usize,
) -> *const std::os::raw::c_char {
    if signed.is_null() || secret.is_null() {
        return std::ptr::null();
    }
    let s = slice::from_raw_parts(signed, slen);
    let key = hmac_key_cached(slice::from_raw_parts(secret, klen));
    cstring_return(slen, |out| {
        crate::crypto::cookie_sign::verify_cookie_into(s, &key, out)
    })
}

/// Verify a signed cookie → its value written directly into a caller buffer —
/// the pooled sibling of `castrum_verify_cookie` (no cstring round-trip; the
/// value length is unknown a priori, so the caller sizes to `slen` — the value
/// is always a prefix of `signed`). Returns the value length, the exact
/// required size when `out_cap` is too small, or 0 on invalid signature /
/// malformed input.
///
/// # Safety
/// `signed`/`secret` must be valid for reads of their lengths; `out` for writes
/// up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_verify_cookie_into(
    signed: *const u8,
    slen: usize,
    secret: *const u8,
    klen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if signed.is_null() || secret.is_null() || out.is_null() {
        return 0;
    }
    let s = slice::from_raw_parts(signed, slen);
    let key = hmac_key_cached(slice::from_raw_parts(secret, klen));
    // The value is a prefix of `signed` (everything before the last `.`), so
    // `slen` is always a sufficient bound — needed-size only differs when the
    // caller passed less.
    if out_cap < slen {
        // Compute the actual needed length without writing (a full verify is
        // wasted if we're just sizing; the caller retries at most once).
        let dot = s.iter().rposition(|&b| b == b'.').unwrap_or(0);
        if dot != 0 {
            return dot;
        }
        return slen;
    }
    crate::crypto::cookie_sign::verify_cookie_into(s, &key, slice::from_raw_parts_mut(out, out_cap))
        .unwrap_or_default()
}

/// CSRF token (`<64-hex(rnd)>.<64-hex(sig)>`, 129 bytes) returned as a
/// null-terminated C string into the per-thread reused buffer.
///
/// # Safety
/// `secret` must be valid for reads of `slen` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_csrf_token(
    secret: *const u8,
    slen: usize,
) -> *const std::os::raw::c_char {
    if secret.is_null() {
        return std::ptr::null();
    }
    let k = hmac_key_cached(slice::from_raw_parts(secret, slen));
    let mut rnd = [0u8; 32];
    if getrandom::fill(&mut rnd).is_err() {
        return std::ptr::null();
    }
    let mut rnd_hex = [0u8; 64];
    crate::util::bytes::hex_encode(&rnd, &mut rnd_hex);
    let mut sig_hex = [0u8; 64];
    crate::util::bytes::hex_encode(hmac::sign(&k, &rnd_hex).as_ref(), &mut sig_hex);
    cstring_return(129, |out| {
        out[..64].copy_from_slice(&rnd_hex);
        out[64] = b'.';
        out[65..129].copy_from_slice(&sig_hex);
        Some(129)
    })
}

/// CSRF token (`<64-hex(rnd)>.<64-hex(sig)>`, 129 bytes) written directly into
/// a caller buffer — the pooled sibling of `castrum_csrf_token` (no cstring
/// round-trip). Returns 129, the exact required size when `out_cap` is too
/// small, or 0 on RNG failure.
///
/// # Safety
/// `secret` must be valid for reads of `slen` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_csrf_token_into(
    secret: *const u8,
    slen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if secret.is_null() || out.is_null() {
        return 0;
    }
    if out_cap < 129 {
        return 129;
    }
    let k = hmac_key_cached(slice::from_raw_parts(secret, slen));
    let mut rnd = [0u8; 32];
    if getrandom::fill(&mut rnd).is_err() {
        return 0;
    }
    let mut rnd_hex = [0u8; 64];
    crate::util::bytes::hex_encode(&rnd, &mut rnd_hex);
    let mut sig_hex = [0u8; 64];
    crate::util::bytes::hex_encode(hmac::sign(&k, &rnd_hex).as_ref(), &mut sig_hex);
    let o = slice::from_raw_parts_mut(out, 129);
    o[..64].copy_from_slice(&rnd_hex);
    o[64] = b'.';
    o[65..129].copy_from_slice(&sig_hex);
    129
}

/// Argon2id password hash → PHC string bytes into `out` (m/t/p/out_len params).
///
/// # Safety
/// `password`/`salt` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_password_hash(
    password: *const u8,
    plen: usize,
    salt: *const u8,
    slen: usize,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    out_len: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if password.is_null() || salt.is_null() || out.is_null() {
        return 0;
    }
    let Some(phc) = panic_guard(
        || {
            crate::crypto::argon2::hash_password(
                slice::from_raw_parts(password, plen),
                slice::from_raw_parts(salt, slen),
                m_cost,
                t_cost,
                p_cost,
                out_len,
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    let bytes = phc.as_bytes();
    if bytes.len() > out_cap {
        // Needed-size convention: report the exact PHC length so the JS side
        // can pre-size (or retry once) instead of re-running the hash.
        return bytes.len();
    }
    slice::from_raw_parts_mut(out, bytes.len()).copy_from_slice(bytes);
    bytes.len()
}

/// bcrypt password hash → `$2b$` PHC string into `out` (cost clamped 4..=31).
///
/// # Safety
/// `password` must be valid for reads of `plen` bytes; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_password_hash_bcrypt(
    password: *const u8,
    plen: usize,
    cost: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if password.is_null() || out.is_null() {
        return 0;
    }
    let Some(h) = panic_guard(
        || {
            bcrypt::hash(
                slice::from_raw_parts(password, plen),
                crate::crypto::bcrypt::clamp_cost(cost),
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    let bytes = h.as_bytes();
    if bytes.len() > out_cap {
        return 0;
    }
    slice::from_raw_parts_mut(out, bytes.len()).copy_from_slice(bytes);
    bytes.len()
}

/// PBKDF2-HMAC-SHA256 → `dk_len` bytes into `out` (dk_len clamped 1..=1MiB).
///
/// # Safety
/// `password`/`salt` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_pbkdf2_sha256(
    password: *const u8,
    plen: usize,
    salt: *const u8,
    slen: usize,
    rounds: u32,
    dk_len: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if password.is_null() || salt.is_null() || out.is_null() {
        return 0;
    }
    let dk_len = dk_len.clamp(
        crate::crypto::pbkdf2::PBKDF2_MIN_LEN,
        crate::crypto::pbkdf2::PBKDF2_MAX_LEN,
    ) as usize;
    if out_cap < dk_len {
        return 0;
    }
    pbkdf2_hmac::<Sha256>(
        slice::from_raw_parts(password, plen),
        slice::from_raw_parts(salt, slen),
        rounds.max(1),
        slice::from_raw_parts_mut(out, dk_len),
    );
    dk_len
}

/// AEAD encrypt → ciphertext+tag into `out`; `alg` 0 = AES-256-GCM, 1 = ChaCha20.
///
/// # Safety
/// `key`/`nonce`/`plaintext` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_aead_encrypt(
    key: *const u8,
    klen: usize,
    nonce: *const u8,
    nlen: usize,
    plaintext: *const u8,
    plen: usize,
    alg: u8,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let Some(alg) = aead_alg(alg) else {
        return 0;
    };
    if key.is_null() || nonce.is_null() || plaintext.is_null() || out.is_null() {
        return 0;
    }
    let Some(ct) = panic_guard(
        || {
            crate::crypto::aead::encrypt(
                alg,
                slice::from_raw_parts(key, klen),
                slice::from_raw_parts(nonce, nlen),
                slice::from_raw_parts(plaintext, plen),
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if ct.len() > out_cap {
        return 0;
    }
    slice::from_raw_parts_mut(out, ct.len()).copy_from_slice(&ct);
    ct.len()
}

/// AEAD decrypt → plaintext into `out`; returns 0 on auth failure / malformed.
///
/// # Safety
/// `key`/`nonce`/`ciphertext` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_aead_decrypt(
    key: *const u8,
    klen: usize,
    nonce: *const u8,
    nlen: usize,
    ciphertext: *const u8,
    clen: usize,
    alg: u8,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let Some(alg) = aead_alg(alg) else {
        return 0;
    };
    if key.is_null() || nonce.is_null() || ciphertext.is_null() || out.is_null() {
        return 0;
    }
    let Some(pt) = panic_guard(
        || {
            crate::crypto::aead::decrypt(
                alg,
                slice::from_raw_parts(key, klen),
                slice::from_raw_parts(nonce, nlen),
                slice::from_raw_parts(ciphertext, clen),
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if pt.len() > out_cap {
        return 0;
    }
    slice::from_raw_parts_mut(out, pt.len()).copy_from_slice(&pt);
    pt.len()
}

/// base64 encode into `out` with `url_safe`/`padding` u8 flags.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_base64_encode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
    url_safe: u8,
    padding: u8,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    // Zero-alloc core (`Engine::encode_slice`) — no intermediate Vec. A
    // too-small buffer yields 0 (the JS wrappers size exactly, so a miss is a
    // caller bug / real error).
    crate::crypto::base64::base64_encode_into_slice(
        slice::from_raw_parts(data, len),
        slice::from_raw_parts_mut(out, out_cap),
        url_safe != 0,
        padding != 0,
    )
    .unwrap_or_default()
}

/// base64 decode into `out`; returns 0 on invalid input / too-small buffer.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_base64_decode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
    url_safe: u8,
    padding: u8,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    // Zero-alloc core (`Engine::decode_slice`) — no intermediate Vec.
    // Invalid input OR too-small buffer → 0 (napi parity).
    crate::crypto::base64::base64_decode_into_slice(
        slice::from_raw_parts(data, len),
        slice::from_raw_parts_mut(out, out_cap),
        url_safe != 0,
        padding != 0,
    )
    .unwrap_or_default()
}

/// Random hex token: `byte_len` random bytes → `byte_len*2` hex chars, returned
/// as a null-terminated C string into the per-thread reused buffer.
///
/// # Safety
/// `byte_len` must be ≤ 16 MiB (else `null`).
#[no_mangle]
pub unsafe extern "C" fn castrum_random_token(byte_len: u32) -> *const std::os::raw::c_char {
    const MAX: usize = 16 * 1024 * 1024;
    let len = byte_len as usize;
    let Some(out_len) = len.checked_mul(2) else {
        return std::ptr::null();
    };
    if len > MAX {
        return std::ptr::null();
    }
    let mut bytes = vec![0u8; len];
    if getrandom::fill(&mut bytes).is_err() {
        return std::ptr::null();
    }
    cstring_return(out_len, |out| {
        crate::util::bytes::hex_encode(&bytes, out);
        Some(out_len)
    })
}

/// Random hex token written directly into a caller buffer — the pooled sibling
/// of `castrum_random_token` (no cstring round-trip on the Bun side). Writes
/// `byte_len*2` hex chars for `byte_len` random bytes. Returns bytes written
/// (`byte_len*2`), the exact required size when `out_cap` is too small, or 0 on
/// a real error (over the 16 MiB cap or the random source failing).
///
/// # Safety
/// `out` must be valid for writes up to `out_cap` (and `out` non-null).
#[no_mangle]
pub unsafe extern "C" fn castrum_random_token_into(
    byte_len: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    const MAX: usize = 16 * 1024 * 1024;
    let len = byte_len as usize;
    let Some(out_len) = len.checked_mul(2) else {
        return 0;
    };
    if len > MAX || out.is_null() {
        return 0;
    }
    if out_cap < out_len {
        // Needed-size convention: report the exact required size.
        return out_len;
    }
    let mut bytes = vec![0u8; len];
    if getrandom::fill(&mut bytes).is_err() {
        return 0;
    }
    let o = slice::from_raw_parts_mut(out, out_len);
    crate::util::bytes::hex_encode(&bytes, o);
    out_len
}

// ── Session envelope (fused JSON + HMAC) ────────────────────────────

/// Seal a session envelope NATIVELY: build
/// `{"id":"…","data":<data_json>,"exp":exp}` and HMAC-sign it into the
/// `payload.<64-hex>` cookie token — ONE crossing replaces the JS
/// `signCookie(JSON.stringify(envelope))` pair. `null` = empty id/secret /
/// panic. `data_json` is embedded verbatim (caller passes valid JSON).
///
/// # Safety
/// All four args must be valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn castrum_session_seal(
    id: *const std::os::raw::c_char,
    data_json: *const std::os::raw::c_char,
    exp_secs: i64,
    secret: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if id.is_null() || data_json.is_null() || secret.is_null() {
        return std::ptr::null();
    }
    let id_b = std::ffi::CStr::from_ptr(id).to_bytes();
    let data_b = std::ffi::CStr::from_ptr(data_json).to_bytes();
    let sec_b = std::ffi::CStr::from_ptr(secret).to_bytes();
    let sealed = super::util::panic_guard(
        || crate::crypto::session::seal_core(id_b, data_b, exp_secs, sec_b),
        None,
    );
    let Some(tok) = sealed else {
        return std::ptr::null();
    };
    super::util::cstring_return(tok.len(), move |buf| {
        if buf.len() < tok.len() {
            return None;
        }
        buf[..tok.len()].copy_from_slice(&tok);
        Some(tok.len())
    })
}

/// Open a sealed session token: verify the HMAC and extract the envelope in
/// ONE crossing. Packed output: `[u8 ok=1][i64 exp][u32 idLen][id][u32
/// dataLen][dataJson]`. Needed-size convention (`w > out_cap` = exact size);
/// `0` = bad signature / malformed / too-small-with-error semantics per the
/// caller contract below.
///
/// # Safety
/// `token`/`secret` valid NUL-terminated C strings; `out` for writes up to
/// `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_session_open(
    token: *const std::os::raw::c_char,
    secret: *const std::os::raw::c_char,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if token.is_null() || secret.is_null() || out.is_null() {
        return 0;
    }
    let tok = std::ffi::CStr::from_ptr(token).to_bytes();
    let sec = std::ffi::CStr::from_ptr(secret).to_bytes();
    let opened = panic_guard(|| crate::crypto::session::open_core(tok, sec), None);
    let Some((exp, id, data)) = opened else {
        return 0;
    };
    // Layout size: 1 + 8 + 4+id + 4+data
    let need = 1 + 8 + 4 + id.len() + 4 + data.len();
    if need > out_cap {
        return need;
    }
    let o = slice::from_raw_parts_mut(out, need);
    o[0] = 1;
    o[1..9].copy_from_slice(&exp.to_le_bytes());
    let id_len = id.len() as u32;
    o[9..13].copy_from_slice(&id_len.to_le_bytes());
    let mut p = 13usize;
    o[p..p + id.len()].copy_from_slice(&id);
    p += id.len();
    let d_len = data.len() as u32;
    o[p..p + 4].copy_from_slice(&d_len.to_le_bytes());
    p += 4;
    o[p..p + data.len()].copy_from_slice(&data);
    need
}
