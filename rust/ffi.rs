// rust/ffi.rs — C-ABI (`extern "C"`) exports for `bun:ffi` (Bun's JIT-compiled
// FFI, ~10-20ns crossing vs ~100-300ns for N-API). The same cdylib serves BOTH
// runtimes: Node loads it through napi-rs (napi_register_module_v1), Bun can
// additionally `dlopen` it via `bun:ffi` and call these functions directly.
//
// The stateless `&[u8] -> scalar` / `&[u8] -> write-into-buffer` hot functions
// (where the N-API crossing dominates the sub-µs cost) are the bulk of the
// surface. The stateful ingress pipeline is ALSO exposed via
// `castrum_ingress_handle_packed`, which takes the opaque inner handle from
// `Ingress.ingressInnerPtr()` (valid only while the instance is alive — see
// the function's safety note). Buffer-taking fns use raw `(ptr, len)` pairs;
// output-buffer fns use `(out, out_cap)` and return bytes written (0 = error /
// too small).
//
// # Safety
// Every function is `unsafe` in the Rust sense (raw pointers) but keeps the
// read/write within the caller-declared lengths. Callers (bun:ffi bindings in
// `src/native/ffi.ts`) must pass pointers into live buffers of at least the
// declared length, and for `castrum_ingress_handle_packed` a live handle from a
// live `Ingress` instance.

use aws_lc_rs::aead::{AES_256_GCM, CHACHA20_POLY1305};
use aws_lc_rs::hmac;
use lru::LruCache;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use std::cell::RefCell;
use std::num::NonZeroUsize;
use std::ptr;
use std::slice;

/// Build the HMAC-SHA256 key used by the scalar HMAC/cookie/CSRF cores (the
/// same per-call construction the napi scalar fns use). Test-only reference
/// helper: the hot C-ABI fns go through `hmac_key_cached` below.
#[cfg(test)]
#[inline]
fn hmac_key(secret: &[u8]) -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, secret)
}

/// Capacity of the per-thread compiled-key LRU.
const HMAC_KEY_CACHE_CAP: usize = 16;

// Per-thread LRU of compiled HMAC-SHA256 keys, keyed by the secret bytes.
//
// `hmac::Key::new` recomputes the HMAC key schedule (a SHA-256 pass over the
// secret) on EVERY call. That is the C-ABI equivalent of what the napi
// `HmacSigner` instance avoids by compiling its key once at construction — but
// the raw `castrum_*` fns are stateless, so without a cache a server signing
// cookies / CSRF tokens / HMACs with the SAME secret on every request would
// re-derive the key each time. `hmac::Key` is `Clone` (a copy of the
// precomputed schedule — far cheaper than re-deriving it), so a cache hit
// returns an OWNED key and no handle can dangle across the call. Thread-local
// = zero lock contention across Bun Worker threads.
thread_local! {
    static HMAC_KEY_CACHE: RefCell<LruCache<Vec<u8>, hmac::Key>> = RefCell::new(
        LruCache::new(NonZeroUsize::new(HMAC_KEY_CACHE_CAP).expect("cap is nonzero")),
    );
}

// Test-only hit counter proving the cache actually reuses compiled keys.
#[cfg(test)]
thread_local! {
    static HMAC_CACHE_HITS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Return a compiled HMAC-SHA256 key for `secret`, reusing a cached copy when
/// the same secret was used recently (per-thread LRU, cap 16).
#[inline]
fn hmac_key_cached(secret: &[u8]) -> hmac::Key {
    HMAC_KEY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(key) = cache.get(secret) {
            #[cfg(test)]
            HMAC_CACHE_HITS.with(|h| h.set(h.get() + 1));
            return key.clone();
        }
        let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
        cache.put(secret.to_vec(), key.clone());
        key
    })
}

/// Map an algorithm selector byte to the AEAD `Algorithm` (0 = AES-256-GCM,
/// 1 = ChaCha20-Poly1305) — mirrors `crate::crypto::aead::resolve_algorithm`.
#[inline]
fn aead_alg(alg: u8) -> Option<&'static aws_lc_rs::aead::Algorithm> {
    match alg {
        0 => Some(&AES_256_GCM),
        1 => Some(&CHACHA20_POLY1305),
        _ => None,
    }
}

/// Run a fallible native core under `catch_unwind`, returning `fallback` on a
/// panic.
///
/// The napi path relies on napi-rs wrapping every call in `catch_unwind` (a
/// panic becomes a JS exception/500). The raw C ABI (`bun:ffi`) has no such
/// guard, so a panic unwinding through an `extern "C"` frame is UB and kills
/// the whole Bun process (this is what happened under burst load in
/// `11-concurrent-burst`). Every `castrum_*` export that runs a fallible /
/// allocating core routes through this helper for parity: a panic becomes the
/// caller's error sentinel (`0` / `None`), never a process crash.
/// `AssertUnwindSafe` is required because the closures capture `&mut [u8]`
/// output slices.
#[inline]
fn panic_guard<T>(f: impl FnOnce() -> T, fallback: T) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(fallback)
}

/// CRC32 over `data[0..len]`. Returns the CRC-32 checksum.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_crc32(data: *const u8, len: usize) -> u32 {
    if data.is_null() && len != 0 {
        return 0;
    }
    let bytes = slice::from_raw_parts(data, len);
    crate::crypto::hashing::crc32_bytes(bytes)
}

/// FNV-1a 64 over `data[0..len]`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_fnv1a64(data: *const u8, len: usize) -> u64 {
    if data.is_null() && len != 0 {
        return 0;
    }
    let bytes = slice::from_raw_parts(data, len);
    crate::crypto::hashing::fnv1a64_bytes(bytes)
}

/// XXH3-64 over `data[0..len]`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_xxh3(data: *const u8, len: usize) -> u64 {
    if data.is_null() && len != 0 {
        return 0;
    }
    let bytes = slice::from_raw_parts(data, len);
    crate::crypto::hashing::fast_hash_bytes(bytes)
}

/// JSON-validity check over `data[0..len]`. Returns 1 if the bytes are
/// well-formed JSON, 0 otherwise.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_valid(data: *const u8, len: usize) -> u8 {
    if data.is_null() {
        return 0;
    }
    let bytes = slice::from_raw_parts(data, len);
    u8::from(crate::json::json_ops::json_valid_bytes(bytes))
}

/// Lowercase-hex encode `data[0..len]` into `out[0..out_cap]`. Returns bytes
/// written (`len * 2`), or 0 if `out_cap < len * 2`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` must be valid for
/// writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_hex_encode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() || len.checked_mul(2).is_none_or(|n| n > out_cap) {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, len * 2);
    crate::crypto::base64::hex_encode_into_slice(input, output).unwrap_or(0)
}

/// RFC 3986 percent-encode `data[0..len]` into `out[0..out_cap]`. Returns
/// bytes written, or 0 if the output buffer is too small (callers can size
/// `len * 3` to guarantee success).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` must be valid for
/// writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_url_encode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, out_cap);
    crate::http::url_codec::url_encode_into_slice(input, output).unwrap_or_default()
}

/// Hex-decode `data[0..len]` into `out[0..out_cap]`. Returns bytes written
/// (`len / 2`), or 0 on odd length / invalid hex digit / too-small buffer.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` must be valid for
/// writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_hex_decode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, out_cap);
    crate::crypto::base64::hex_decode_into_slice(input, output).unwrap_or_default()
}

/// Percent-decode `data[0..len]` into `out[0..out_cap]`. Returns bytes
/// written, or 0 on malformed `%XX` / too-small buffer.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` must be valid for
/// writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_url_decode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, out_cap);
    crate::http::url_codec::url_decode_into_slice(input, output).unwrap_or_default()
}

// ── Validators (value-returning) ─────────────────────────────────

/// Email / UUID / IPv4 / IPv6 validators → 1/0.
macro_rules! validator_c_abi {
    ($name:ident, $core:path) => {
        #[doc = concat!("Validate input as a ", stringify!($name), " → 1/0.")]
        ///
        /// # Safety
        /// `data` must be valid for reads of `len` bytes.
        #[no_mangle]
        pub unsafe extern "C" fn $name(data: *const u8, len: usize) -> u8 {
            if data.is_null() {
                return 0;
            }
            u8::from($core(slice::from_raw_parts(data, len)))
        }
    };
}

validator_c_abi!(castrum_validate_email, crate::util::validation::validate_email_bytes);
validator_c_abi!(castrum_validate_uuid, crate::util::validation::validate_uuid_bytes);
validator_c_abi!(castrum_validate_ipv4, crate::util::validation::validate_ipv4_bytes);
validator_c_abi!(castrum_validate_ipv6, crate::util::validation::validate_ipv6_bytes);

/// Sum of `id` fields across a JSON array (sonic-rs zero-DOM) → packed
/// `[u8 ok][i64 sum LE]` output (9 B: 1 = valid array — the sum may be 0 —,
/// 0 = invalid; return 9/1/0 bytes). The ok byte removes the old scalar-i64
/// ambiguity (0 for both a legit zero-sum and invalid input) that forced the
/// JS builder to re-dispatch to napi on every 0n.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` must be valid for
/// writes of `out_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_sum_ids(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    match crate::json::json_ops::json_sum_ids_bytes(slice::from_raw_parts(data, len)) {
        Ok(sum) if out_len >= 9 => {
            *out = 1;
            ptr::copy_nonoverlapping(sum.to_le_bytes().as_ptr(), out.add(1), 8);
            9
        }
        Ok(_) => 9, // too-small buffer → exact required size (growExact)
        Err(_) if out_len >= 1 => {
            *out = 0;
            1
        }
        Err(_) => 1, // too-small buffer → exact required size
    }
}

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
/// # Safety
/// `password`/`hash` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_password_verify_bcrypt(
    password: *const u8,
    plen: usize,
    hash: *const u8,
    hlen: usize,
) -> u8 {
    if password.is_null() || hash.is_null() {
        return 0;
    }
    let Ok(h) = std::str::from_utf8(slice::from_raw_parts(hash, hlen)) else {
        return 0;
    };
    u8::from(bcrypt::verify(slice::from_raw_parts(password, plen), h).unwrap_or(false))
}

// ── Fixed / bounded-size output writers ──────────────────────────

/// RFC 6455 Sec-WebSocket-Accept (28 bytes) into `out`.
///
/// # Safety
/// `key` must be valid for reads of `klen` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_accept_key(
    key: *const u8,
    klen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if key.is_null() || out.is_null() || out_cap < 28 {
        return 0;
    }
    crate::payload::websocket::ws_accept_key_into(
        slice::from_raw_parts(key, klen),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// crc32-based ETag (10 strong / 12 weak) into `out`; `weak` is a u8 flag.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_etag(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
    weak: u8,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let crc = crc32fast::hash(slice::from_raw_parts(data, len));
    let need = if weak != 0 { 12 } else { 10 };
    if out_cap < need {
        return 0;
    }
    crate::http::etag::etag_from_crc32_into(crc, weak != 0, slice::from_raw_parts_mut(out, out_cap))
        .unwrap_or(0)
}

/// Random hex token: `byte_len` random bytes → `byte_len*2` hex chars into `out`.
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_random_token(byte_len: u32, out: *mut u8, out_cap: usize) -> usize {
    const MAX: usize = 16 * 1024 * 1024;
    let len = byte_len as usize;
    let Some(out_len) = len.checked_mul(2) else {
        return 0;
    };
    if len > MAX || out.is_null() || out_cap < out_len {
        return 0;
    }
    let mut bytes = vec![0u8; len];
    if getrandom::fill(&mut bytes).is_err() {
        return 0;
    }
    crate::util::bytes::hex_encode(&bytes, slice::from_raw_parts_mut(out, out_len));
    out_len
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

/// Sign a cookie `value` as `value.<64-hex sig>` into `out`.
///
/// # Safety
/// `value`/`secret` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_sign_cookie(
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
    crate::crypto::cookie_sign::sign_cookie_into(
        slice::from_raw_parts(value, vlen),
        &hmac_key_cached(slice::from_raw_parts(secret, slen)),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// Verify a signed cookie into `out` (the value without its signature); returns
/// 0 on invalid signature / malformed input.
///
/// # Safety
/// `signed`/`secret` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_verify_cookie(
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
    crate::crypto::cookie_sign::verify_cookie_into(
        slice::from_raw_parts(signed, slen),
        &hmac_key_cached(slice::from_raw_parts(secret, klen)),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// CSRF token (129 bytes: 64 rnd-hex + '.' + 64 sig-hex) into `out`.
///
/// # Safety
/// `secret` must be valid for reads of `slen` bytes; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_csrf_token(
    secret: *const u8,
    slen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if secret.is_null() || out.is_null() || out_cap < 129 {
        return 0;
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
    o[65..].copy_from_slice(&sig_hex);
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
    let dk_len = dk_len.clamp(crate::crypto::pbkdf2::PBKDF2_MIN_LEN, crate::crypto::pbkdf2::PBKDF2_MAX_LEN)
        as usize;
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

/// WebSocket frame encode into `out` (opcode 1/2/8/9/10, `mask`/`fin` flags).
///
/// # Safety
/// `payload` must be valid for reads of `plen` bytes; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_frame_encode(
    opcode: u8,
    payload: *const u8,
    plen: usize,
    mask: u8,
    fin: u8,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if payload.is_null() || out.is_null() {
        return 0;
    }
    crate::payload::ws_frames::encode_frame_into(
        opcode,
        slice::from_raw_parts(payload, plen),
        mask != 0,
        fin != 0,
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// RFC 6902 JSON patch → patched doc into `out` (0 on invalid/inapplicable).
///
/// # Safety
/// `doc`/`patch` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_patch(
    doc: *const u8,
    dlen: usize,
    patch: *const u8,
    plen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if doc.is_null() || patch.is_null() || out.is_null() {
        return 0;
    }
    // Wrap in panic_guard: a panic in the patch engine must not unwind through
    // the C ABI (process crash) — it becomes 0 (invalid input) instead.
    let Some(patched) = panic_guard(
        || {
            crate::json::json_patch_ops::apply_json_patch_bytes(
                slice::from_raw_parts(doc, dlen),
                slice::from_raw_parts(patch, plen),
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if patched.len() > out_cap {
        // Needed-size convention (see compress_to_out!): exact retry, no re-run.
        return patched.len();
    }
    slice::from_raw_parts_mut(out, patched.len()).copy_from_slice(&patched);
    patched.len()
}

// ── Compression (gzip / brotli) ──────────────────────────────────

macro_rules! compress_to_out {
    ($name:ident, $core:path, $extra:ty) => {
        #[doc = concat!("Run `", stringify!($core), "` and write the result into `out`.")]
        ///
        /// # Convention
        /// Returns the exact total bytes the result requires (the written count
        /// on success, or the needed size when `out_cap` is too small). The JS
        /// wrapper compares against `out_cap` to distinguish success from
        /// too-small, so a miss allocates EXACTLY once and retries — it never
        /// re-runs the whole (de)compression in a grow loop. `0` is reserved
        /// for a REAL error (invalid stream / decompression-cap exceeded).
        ///
        /// # Safety
        /// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            data: *const u8,
            len: usize,
            extra: $extra,
            out: *mut u8,
            out_cap: usize,
        ) -> usize {
            if data.is_null() || out.is_null() {
                return 0;
            }
            let input = slice::from_raw_parts(data, len);
            let output = slice::from_raw_parts_mut(out, out_cap);
            panic_guard(
                || match $core(input, extra, output) {
                    Ok(w) => w,
                    // Needed-size convention: report the EXACT required size so the
                    // JS wrapper allocates once and retries (never a re-run loop).
                    Err(crate::payload::compress::StreamError::TooSmall { needed }) => needed,
                    // Real error (invalid stream / decompression cap exceeded) → 0.
                    Err(_) => 0,
                },
                0,
            )
        }
    };
}

compress_to_out!(castrum_gzip_compress, crate::payload::compress::gzip_compress_into, u32);
compress_to_out!(castrum_gzip_decompress, crate::payload::compress::gzip_decompress_into, usize);
compress_to_out!(castrum_brotli_compress, crate::payload::compress::brotli_compress_into, u32);
compress_to_out!(castrum_brotli_decompress, crate::payload::compress::brotli_decompress_into, usize);

/// Read the original (uncompressed) size from a gzip stream's ISIZE trailer
/// (last 4 bytes, little-endian, original size mod 2^32). Returns the EXACT
/// output size for a single-member standard gzip stream, or 0 when the input
/// isn't a usable standard gzip stream (too short / not gzip magic). Lets the
/// JS wrapper pre-size the decompress buffer exactly so the happy path is a
/// single pass (no grow-retry re-run).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_gzip_isize(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len < 18 {
        return 0;
    }
    let s = slice::from_raw_parts(data, len);
    if s[0] != 0x1f || s[1] != 0x8b {
        return 0;
    }
    u32::from_le_bytes([s[len - 4], s[len - 3], s[len - 2], s[len - 1]])
}

// ── Packed parsers (input → packed output buffer) ────────────────

/// HTTP request parse → packed output into `out`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_http_parse_request_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    crate::http::http_parser::http_parse_request_packed_into_slice(
        slice::from_raw_parts(data, len),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// Query string parse → packed output into `out`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_query_parse_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    crate::http::query_parser::query_parse_packed_into_slice(
        slice::from_raw_parts(data, len),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// Cookie header parse → packed output into `out`.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_cookie_parse_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    crate::http::cookie_parser::cookie_parse_packed_into_slice(
        slice::from_raw_parts(data, len),
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// Parse an `application/x-www-form-urlencoded` body into packed pairs — the
/// x-www-form-urlencoded wire format is identical to the query parser's core
/// (`query_parse_packed_into_slice`), so this is a thin alias.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_form_parse_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    castrum_query_parse_packed(data, len, out, out_cap)
}

/// Parse a `multipart/form-data` body into the packed parts layout (the same
/// `[u32 count]{[u32 name_len][name][...]}` wire format as the batch API).
/// Returns bytes written (0 on malformed input); a result larger than `out_cap`
/// reports the exact needed size so the caller can retry once (see
/// `compress_to_out!` for the convention).
///
/// # Safety
/// `body`/`boundary` must be valid for reads of their lengths; `out` for
/// writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_multipart_parse_packed(
    body: *const u8,
    blen: usize,
    boundary: *const u8,
    boundary_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if body.is_null() || boundary.is_null() || out.is_null() {
        return 0;
    }
    // Wrap in panic_guard: the parser allocates internally — a panic must not
    // unwind through the C ABI (process crash); it becomes 0 instead.
    let packed = panic_guard(
        || {
            let parts = crate::http::multipart::parse_multipart_limited(
                slice::from_raw_parts(body, blen),
                slice::from_raw_parts(boundary, boundary_len),
                &Default::default(),
            );
            let mut buf = Vec::new();
            crate::http::multipart::parts_to_packed(&parts, &mut buf);
            buf
        },
        Vec::new(),
    );
    if packed.len() > out_cap {
        // Needed-size convention (see compress_to_out!): exact retry, no re-run.
        return packed.len();
    }
    slice::from_raw_parts_mut(out, packed.len()).copy_from_slice(&packed);
    packed.len()
}

/// Decode a WebSocket frame into a packed `[u8 flags][u8 opcode][u32 payload_len]
/// [payload]` layout (flags bit0 = FIN). Returns bytes written, 0 on malformed
/// input. JS decodes the small header into the `WsFrame` shape.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_frame_decode_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let Some(frame) =
        crate::payload::ws_frames::decode_frame(slice::from_raw_parts(data, len))
    else {
        return 0;
    };
    let Some(need) = 6usize.checked_add(frame.payload.len()) else {
        return 0;
    };
    if need > out_cap {
        return 0;
    }
    let o = slice::from_raw_parts_mut(out, need);
    o[0] = u8::from(frame.fin);
    o[1] = frame.opcode;
    o[2..6].copy_from_slice(&(frame.payload.len() as u32).to_le_bytes());
    o[6..].copy_from_slice(&frame.payload);
    need
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
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if claims.is_null() || secret.is_null() || out.is_null() {
        return 0;
    }
    // Wrap in panic_guard: serde parse + token build allocate — a panic must
    // not unwind through the C ABI (process crash); it becomes 0 instead.
    let Some(token) = panic_guard(
        || {
            let Ok(mut value) = serde_json::from_slice(slice::from_raw_parts(claims, clen)) else {
                return None;
            };
            let Ok(payload_b64) = crate::crypto::jwt::inject_and_payload_b64(
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
    ) else {
        return 0;
    };
    if token.len() > out_cap {
        // Needed-size convention (see compress_to_out!): exact retry, no re-run.
        return token.len();
    }
    slice::from_raw_parts_mut(out, token.len()).copy_from_slice(&token);
    token.len()
}

// ── Ingress pipeline (opaque-handle fast path) ─────────────────

/// Run the ingress pipeline on a packed request frame. `inner` is the opaque
/// pointer (as an integer) from `Ingress.ingressInnerPtr()` — valid ONLY while
/// the `Ingress` instance is alive (see the method's safety note). This is the
/// hot path: it runs the ENTIRE pipeline (parsing, trust/proxy, schema, CORS,
/// rate limit, response) in one C-ABI call, cutting the N-API crossing +
/// marshaling that a per-request `handleRequestPacked` call would pay.
///
/// Returns bytes written into `out` (0 = error / too-small buffer).
///
/// # Safety
/// `inner` must be the live `IngressInner` pointer from a live `Ingress`
/// instance; `input` valid for `input_len` reads; `body` valid for `body_len`
/// reads (null/0 = no body); `out` valid for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_handle_packed(
    inner: usize,
    input: *const u8,
    input_len: usize,
    body: *const u8,
    body_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let inner = inner as *const crate::ingress::IngressInner;
    if inner.is_null() || input.is_null() || out.is_null() {
        return 0;
    }
    let inp = slice::from_raw_parts(input, input_len);
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    let body_slice: &[u8] = if body.is_null() || body_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(body, body_len)
    };
    // Mirror the napi entry (`util::run_packed_into`): when the input OR the
    // body aliases `out`, copy it first so the shared `&[u8]` and the `&mut
    // [u8]` output borrow never alias (aliased &/&mut is instant UB).
    let owned_input;
    let input_ref: &[u8] = if crate::util::slices_overlap(inp, out_slice) {
        owned_input = inp.to_vec();
        &owned_input
    } else {
        inp
    };
    let owned_body;
    let body_ref: &[u8] = if crate::util::slices_overlap(body_slice, out_slice) {
        owned_body = body_slice.to_vec();
        &owned_body
    } else {
        body_slice
    };
    // A panic must not unwind through the C ABI (that would kill the whole Bun
    // process — the `11-concurrent-burst` crash). Catch it and report 0 (error)
    // so the JS wrapper turns it into a 500, matching the napi path's
    // catch_unwind. `handle_packed` borrows `&self` with no interior mutability
    // on the hot path, so the instance stays consistent after an unwind.
    panic_guard(
        || {
            (&*inner)
                .handle_packed(input_ref, body_ref, out_slice)
                .unwrap_or(0)
        },
        0,
    )
}

// ── Ingress binary-layout constants (C ABI) ──────────────────────
// The napi projection (`ingress_constants.rs`) exposes these to JS by name;
// this C-ABI variant lets Bun read the SAME values via `bun:ffi` WITHOUT
// loading the napi addon, so `import castrum` is FFI-only under Bun. Values
// are read directly from `output.rs` (the single numeric source). Field ORDER
// is the wire contract — pinned by `ingress_layout_c_abi_matches_output_source`
// below and by the bun:ffi bind-time self-test (which falls back to napi if the
// pinned values don't line up).

/// `#[repr(C)]` projection of the ingress layout constants for the FFI path.
/// `castrum_ingress_layout` memcpys this struct into the caller's buffer; the
/// JS side reads it as 38 × u32 little-endian at the same slot order.
#[repr(C)]
pub struct IngressLayout {
    // Output buffer layout (u32)
    pub out_verdict: u32,
    pub out_error_code: u32,
    pub out_status: u32,
    pub out_flags: u32,
    pub out_rate_limit: u32,
    pub out_rate_remaining: u32,
    pub out_rate_reset: u32,
    pub out_retry_after: u32,
    pub out_cookies_json_len: u32,
    pub out_query_json_len: u32,
    pub out_header_variant: u32,
    pub out_body_json_len: u32,
    pub out_data_start: u32,
    // Flags
    pub flag_has_cookies: u32,
    pub flag_has_query: u32,
    pub flag_body_valid_json: u32,
    pub flag_schema_valid: u32,
    pub flag_cors_allowed: u32,
    pub flag_is_preflight: u32,
    pub flag_rate_limited: u32,
    pub flag_https: u32,
    pub flag_trusted_proxy: u32,
    pub flag_body_truncated: u32,
    // Header variant bits
    pub hv_json: u32,
    pub hv_cors_simple: u32,
    pub hv_cors_preflight: u32,
    pub hv_rate_active: u32,
    pub hv_rate_limited: u32,
    pub hv_count: u32,
    // Error codes
    pub err_none: u32,
    pub err_cors_preflight: u32,
    pub err_rate_limited: u32,
    pub err_body_too_large: u32,
    pub err_invalid_json: u32,
    pub err_schema_validation: u32,
    pub err_bad_request: u32,
    pub err_request_too_large: u32,
    pub err_internal: u32,
}

impl IngressLayout {
    /// Build the layout from `output.rs` (the single numeric source).
    const fn from_output() -> Self {
        use crate::ingress::output as o;
        Self {
            out_verdict: o::OUT_VERDICT as u32,
            out_error_code: o::OUT_ERROR_CODE as u32,
            out_status: o::OUT_STATUS as u32,
            out_flags: o::OUT_FLAGS as u32,
            out_rate_limit: o::OUT_RATE_LIMIT as u32,
            out_rate_remaining: o::OUT_RATE_REMAINING as u32,
            out_rate_reset: o::OUT_RATE_RESET as u32,
            out_retry_after: o::OUT_RETRY_AFTER as u32,
            out_cookies_json_len: o::OUT_COOKIES_JSON_LEN as u32,
            out_query_json_len: o::OUT_QUERY_JSON_LEN as u32,
            out_header_variant: o::OUT_HEADER_VARIANT as u32,
            out_body_json_len: o::OUT_BODY_JSON_LEN as u32,
            out_data_start: o::OUT_DATA_START as u32,
            flag_has_cookies: o::FLAG_HAS_COOKIES,
            flag_has_query: o::FLAG_HAS_QUERY,
            flag_body_valid_json: o::FLAG_BODY_VALID_JSON,
            flag_schema_valid: o::FLAG_SCHEMA_VALID,
            flag_cors_allowed: o::FLAG_CORS_ALLOWED,
            flag_is_preflight: o::FLAG_IS_PREFLIGHT,
            flag_rate_limited: o::FLAG_RATE_LIMITED,
            flag_https: o::FLAG_HTTPS,
            flag_trusted_proxy: o::FLAG_TRUSTED_PROXY,
            flag_body_truncated: o::FLAG_BODY_TRUNCATED,
            hv_json: o::HV_JSON as u32,
            hv_cors_simple: o::HV_CORS_SIMPLE as u32,
            hv_cors_preflight: o::HV_CORS_PREFLIGHT as u32,
            hv_rate_active: o::HV_RATE_ACTIVE as u32,
            hv_rate_limited: o::HV_RATE_LIMITED as u32,
            hv_count: o::HV_COUNT as u32,
            err_none: o::ERR_CODE_NONE as u32,
            err_cors_preflight: o::ERR_CODE_CORS_PREFLIGHT as u32,
            err_rate_limited: o::ERR_CODE_RATE_LIMITED as u32,
            err_body_too_large: o::ERR_CODE_BODY_TOO_LARGE as u32,
            err_invalid_json: o::ERR_CODE_INVALID_JSON as u32,
            err_schema_validation: o::ERR_CODE_SCHEMA_VALIDATION as u32,
            err_bad_request: o::ERR_CODE_BAD_REQUEST as u32,
            err_request_too_large: o::ERR_CODE_REQUEST_TOO_LARGE as u32,
            err_internal: o::ERR_CODE_INTERNAL as u32,
        }
    }
}

/// Write the `IngressLayout` blob (38 × u32 LE) into `out`; returns bytes
/// written (0 when `out` is too small or null).
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_layout(out: *mut u8, out_cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    const LAYOUT: IngressLayout = IngressLayout::from_output();
    let n = core::mem::size_of::<IngressLayout>();
    if out_cap < n {
        return 0;
    }
    core::ptr::copy_nonoverlapping(&LAYOUT as *const IngressLayout as *const u8, out, n);
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_c_abi_matches_core() {
        let bytes = b"123456789";
        let out = unsafe { castrum_crc32(bytes.as_ptr(), bytes.len()) };
        assert_eq!(out, crate::crypto::hashing::crc32_bytes(b"123456789"));
    }

    /// The C-ABI ingress layout blob must never drift from the single numeric
    /// source (`output.rs`). If a layout constant changes in `output.rs` (or the
    /// struct field order here) without updating this test, it fails.
    #[test]
    fn ingress_layout_c_abi_matches_output_source() {
        use crate::ingress::output;
        let mut buf = [0u8; core::mem::size_of::<IngressLayout>()];
        let written = unsafe { castrum_ingress_layout(buf.as_mut_ptr(), buf.len()) };
        assert_eq!(written, buf.len(), "layout blob must fill the full struct");
        let ptr = buf.as_ptr() as *const IngressLayout;
        let l = unsafe { &*ptr };
        assert_eq!(l.out_verdict, output::OUT_VERDICT as u32);
        assert_eq!(l.out_error_code, output::OUT_ERROR_CODE as u32);
        assert_eq!(l.out_status, output::OUT_STATUS as u32);
        assert_eq!(l.out_flags, output::OUT_FLAGS as u32);
        assert_eq!(l.out_rate_limit, output::OUT_RATE_LIMIT as u32);
        assert_eq!(l.out_rate_remaining, output::OUT_RATE_REMAINING as u32);
        assert_eq!(l.out_rate_reset, output::OUT_RATE_RESET as u32);
        assert_eq!(l.out_retry_after, output::OUT_RETRY_AFTER as u32);
        assert_eq!(l.out_cookies_json_len, output::OUT_COOKIES_JSON_LEN as u32);
        assert_eq!(l.out_query_json_len, output::OUT_QUERY_JSON_LEN as u32);
        assert_eq!(l.out_header_variant, output::OUT_HEADER_VARIANT as u32);
        assert_eq!(l.out_body_json_len, output::OUT_BODY_JSON_LEN as u32);
        assert_eq!(l.out_data_start, output::OUT_DATA_START as u32);
        assert_eq!(l.flag_has_cookies, output::FLAG_HAS_COOKIES);
        assert_eq!(l.flag_has_query, output::FLAG_HAS_QUERY);
        assert_eq!(l.flag_body_valid_json, output::FLAG_BODY_VALID_JSON);
        assert_eq!(l.flag_schema_valid, output::FLAG_SCHEMA_VALID);
        assert_eq!(l.flag_cors_allowed, output::FLAG_CORS_ALLOWED);
        assert_eq!(l.flag_is_preflight, output::FLAG_IS_PREFLIGHT);
        assert_eq!(l.flag_rate_limited, output::FLAG_RATE_LIMITED);
        assert_eq!(l.flag_https, output::FLAG_HTTPS);
        assert_eq!(l.flag_trusted_proxy, output::FLAG_TRUSTED_PROXY);
        assert_eq!(l.flag_body_truncated, output::FLAG_BODY_TRUNCATED);
        assert_eq!(l.hv_json, output::HV_JSON as u32);
        assert_eq!(l.hv_cors_simple, output::HV_CORS_SIMPLE as u32);
        assert_eq!(l.hv_cors_preflight, output::HV_CORS_PREFLIGHT as u32);
        assert_eq!(l.hv_rate_active, output::HV_RATE_ACTIVE as u32);
        assert_eq!(l.hv_rate_limited, output::HV_RATE_LIMITED as u32);
        assert_eq!(l.hv_count, output::HV_COUNT as u32);
        assert_eq!(l.err_none, output::ERR_CODE_NONE as u32);
        assert_eq!(l.err_cors_preflight, output::ERR_CODE_CORS_PREFLIGHT as u32);
        assert_eq!(l.err_rate_limited, output::ERR_CODE_RATE_LIMITED as u32);
        assert_eq!(l.err_body_too_large, output::ERR_CODE_BODY_TOO_LARGE as u32);
        assert_eq!(l.err_invalid_json, output::ERR_CODE_INVALID_JSON as u32);
        assert_eq!(l.err_schema_validation, output::ERR_CODE_SCHEMA_VALIDATION as u32);
        assert_eq!(l.err_bad_request, output::ERR_CODE_BAD_REQUEST as u32);
        assert_eq!(l.err_request_too_large, output::ERR_CODE_REQUEST_TOO_LARGE as u32);
        assert_eq!(l.err_internal, output::ERR_CODE_INTERNAL as u32);
    }

    #[test]
    fn fnv_c_abi_matches_core() {
        let bytes = b"foobar";
        let out = unsafe { castrum_fnv1a64(bytes.as_ptr(), bytes.len()) };
        assert_eq!(out, crate::crypto::hashing::fnv1a64_bytes(b"foobar"));
    }

    #[test]
    fn json_valid_c_abi() {
        let good = b"{\"a\":1}";
        assert_eq!(unsafe { castrum_json_valid(good.as_ptr(), good.len()) }, 1);
        let bad = b"{not json";
        assert_eq!(unsafe { castrum_json_valid(bad.as_ptr(), bad.len()) }, 0);
    }

    #[test]
    fn hmac_key_cache_reuses_compiled_key() {
        // Same-secret calls must hit the cache (the whole point of the LRU):
        // repeated calls reuse the precomputed key schedule instead of
        // re-deriving it via `hmac::Key::new`.
        HMAC_KEY_CACHE.with(|c| c.borrow_mut().clear());
        HMAC_CACHE_HITS.with(|h| h.set(0));
        let secret = b"same-secret";
        let _ = hmac_key_cached(secret);
        let _ = hmac_key_cached(secret);
        let _ = hmac_key_cached(secret);
        let hits = HMAC_CACHE_HITS.with(|h| h.get());
        assert!(
            hits >= 2,
            "same-secret calls must reuse the cached key (hits={hits})"
        );
    }

    #[test]
    fn hmac_key_cache_matches_fresh_key() {
        // The cached key must be byte-identical in behavior to a freshly
        // derived key for every secret.
        for secret in [b"a".as_slice(), b"secret-key", b"x".repeat(300).as_slice()] {
            let cached = hmac_key_cached(secret);
            let fresh = hmac_key(secret);
            let data = b"hello world";
            let a = hmac::sign(&cached, data);
            let b = hmac::sign(&fresh, data);
            assert_eq!(a.as_ref(), b.as_ref(), "cached key differs from fresh key");
        }
    }

    #[test]
    fn hmac_key_cache_survives_eviction_thrash() {
        // Exceed the LRU capacity with distinct secrets: eviction must not
        // corrupt the surviving entries (every secret still verifies).
        for i in 0..(HMAC_KEY_CACHE_CAP * 4) {
            let secret = format!("secret-{i}").into_bytes();
            let key = hmac_key_cached(&secret);
            let data = b"payload";
            let tag = hmac::sign(&key, data);
            assert!(
                hmac::verify(&key, data, tag.as_ref()).is_ok(),
                "secret-{i} failed after cache eviction"
            );
        }
    }

    #[test]
    fn hex_encode_c_abi_roundtrip() {
        let input = b"hello";
        let mut out = [0u8; 16];
        let written = unsafe {
            castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(written, 10);
        assert_eq!(&out[..10], b"68656c6c6f");
    }

    #[test]
    fn hex_encode_c_abi_undersized_returns_zero() {
        let input = b"hello";
        let mut out = [0u8; 4];
        let written = unsafe {
            castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(written, 0);
    }

    #[test]
    fn hex_decode_c_abi_roundtrip() {
        let input = b"68656c6c6f";
        let mut out = [0u8; 8];
        let written = unsafe {
            castrum_hex_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(written, 5);
        assert_eq!(&out[..5], b"hello");
    }

    #[test]
    fn hex_decode_c_abi_rejects_invalid() {
        let bad = b"6x";
        let mut out = [0u8; 4];
        let written = unsafe {
            castrum_hex_decode(bad.as_ptr(), bad.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(written, 0);
    }

    #[test]
    fn url_encode_c_abi() {
        let input = b"a b/c";
        let mut out = [0u8; 16];
        let written = unsafe {
            castrum_url_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(&out[..written], b"a%20b%2Fc");
    }

    #[test]
    fn url_decode_c_abi() {
        let input = b"a%20b%2Fc";
        let mut out = [0u8; 8];
        let written = unsafe {
            castrum_url_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(&out[..written], b"a b/c");
    }

    #[test]
    fn validators_c_abi() {
        // Values mirror the core `#[cfg(test)]` vectors in rust/util/validation.rs.
        let email = b"a@b.com";
        assert_eq!(unsafe { castrum_validate_email(email.as_ptr(), email.len()) }, 1);
        assert_eq!(unsafe { castrum_validate_email(b"not-an-email".as_ptr(), 12) }, 0);
        let uuid = b"550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(unsafe { castrum_validate_uuid(uuid.as_ptr(), uuid.len()) }, 1);
        assert_eq!(unsafe { castrum_validate_uuid(b"not-a-uuid".as_ptr(), 10) }, 0);
        let v4 = b"192.168.0.1";
        assert_eq!(unsafe { castrum_validate_ipv4(v4.as_ptr(), v4.len()) }, 1);
        assert_eq!(unsafe { castrum_validate_ipv4(b"999.1.1.1".as_ptr(), 9) }, 0);
        let v6 = b"2001:db8::1";
        assert_eq!(unsafe { castrum_validate_ipv6(v6.as_ptr(), v6.len()) }, 1);
        let bad_v6 = b"2001:::1";
        assert_eq!(unsafe { castrum_validate_ipv6(bad_v6.as_ptr(), bad_v6.len()) }, 0);
    }

    #[test]
    fn json_sum_ids_c_abi_packed_output() {
        let doc = b"[{\"id\":1},{\"id\":2},{\"id\":3}]";
        let mut out = [0u8; 9];
        let w = unsafe {
            castrum_json_sum_ids(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 9);
        assert_eq!(out[0], 1);
        assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 6);

        // A legit zero-sum array is still "ok" (the old scalar i64 conflated
        // this with invalid input).
        let zero = b"[{\"id\":0},{\"id\":0}]";
        let w = unsafe {
            castrum_json_sum_ids(zero.as_ptr(), zero.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 9);
        assert_eq!(out[0], 1);
        assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 0);

        // Invalid (non-array) input → ok=0, 1 byte.
        let w = unsafe { castrum_json_sum_ids(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 1);
        assert_eq!(out[0], 0);

        // Too-small output → exact required size (9/1), no write past cap.
        let w = unsafe { castrum_json_sum_ids(doc.as_ptr(), doc.len(), out.as_mut_ptr(), 1) };
        assert_eq!(w, 9);
        let w = unsafe { castrum_json_sum_ids(b"nope".as_ptr(), 4, out.as_mut_ptr(), 0) };
        assert_eq!(w, 1);
    }

    #[test]
    fn ws_accept_key_c_abi_rfc6455() {
        // RFC 6455 Sec-WebSocket-Accept test vector.
        let key = b"dGhlIHNhbXBsZSBub25jZQ==";
        let mut out = [0u8; 28];
        let written = unsafe {
            castrum_ws_accept_key(key.as_ptr(), key.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(written, 28);
        assert_eq!(&out[..], b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn etag_c_abi() {
        let data = b"hello";
        let mut strong = [0u8; 12];
        let w = unsafe {
            castrum_etag(data.as_ptr(), data.len(), strong.as_mut_ptr(), strong.len(), 0)
        };
        assert_eq!(w, 10);
        let crc = crc32fast::hash(b"hello");
        let expected = format!("\"{crc:08x}\"");
        assert_eq!(&strong[..10], expected.as_bytes());

        let mut weak = [0u8; 12];
        let w = unsafe {
            castrum_etag(data.as_ptr(), data.len(), weak.as_mut_ptr(), weak.len(), 1)
        };
        assert_eq!(w, 12);
        assert_eq!(&weak[..2], b"W/");
    }

    #[test]
    fn random_token_c_abi() {
        let mut out = [0u8; 32];
        let w = unsafe { castrum_random_token(16, out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 32);
        assert!(out.iter().all(u8::is_ascii_hexdigit));
        // Too-small buffer → 0.
        let mut tiny = [0u8; 4];
        assert_eq!(unsafe { castrum_random_token(16, tiny.as_mut_ptr(), tiny.len()) }, 0);
    }

    #[test]
    fn base64_c_abi_roundtrip() {
        let data = b"hello world";
        let mut enc = [0u8; 32];
        let w = unsafe {
            castrum_base64_encode(data.as_ptr(), data.len(), enc.as_mut_ptr(), enc.len(), 0, 1)
        };
        assert_eq!(&enc[..w], b"aGVsbG8gd29ybGQ=");
        let mut dec = [0u8; 32];
        let d = unsafe {
            castrum_base64_decode(enc.as_ptr(), w, dec.as_mut_ptr(), dec.len(), 0, 1)
        };
        assert_eq!(&dec[..d], data);
        // Invalid input → 0.
        assert_eq!(
            unsafe { castrum_base64_decode(b"!!!".as_ptr(), 3, dec.as_mut_ptr(), dec.len(), 0, 1) },
            0
        );
    }

    #[test]
    fn hmac_c_abi() {
        let key = b"key";
        let data = b"The quick brown fox jumps over the lazy dog";
        let mut out = [0u8; 64];
        let w = unsafe {
            castrum_hmac_sha256(key.as_ptr(), key.len(), data.as_ptr(), data.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 64);
        assert_eq!(
            &out[..],
            b"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        let ok = unsafe {
            castrum_hmac_sha256_verify(key.as_ptr(), key.len(), data.as_ptr(), data.len(), out.as_ptr(), out.len())
        };
        assert_eq!(ok, 1);
        out[0] ^= 1;
        let bad = unsafe {
            castrum_hmac_sha256_verify(key.as_ptr(), key.len(), data.as_ptr(), data.len(), out.as_ptr(), out.len())
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn sign_verify_cookie_c_abi() {
        let value = b"session=abc";
        let secret = b"secret-key";
        let mut signed = [0u8; 128];
        let w = unsafe {
            castrum_sign_cookie(value.as_ptr(), value.len(), secret.as_ptr(), secret.len(), signed.as_mut_ptr(), signed.len())
        };
        assert!(w > value.len());
        let mut out = [0u8; 128];
        let v = unsafe {
            castrum_verify_cookie(signed.as_ptr(), w, secret.as_ptr(), secret.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(&out[..v], value);
        // Tampered signature → 0.
        let last = w - 1;
        signed[last] ^= 1;
        let bad = unsafe {
            castrum_verify_cookie(signed.as_ptr(), w, secret.as_ptr(), secret.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn csrf_c_abi() {
        let secret = b"csrf-secret";
        let mut token = [0u8; 129];
        let w = unsafe { castrum_csrf_token(secret.as_ptr(), secret.len(), token.as_mut_ptr(), token.len()) };
        assert_eq!(w, 129);
        assert_eq!(token[64], b'.');
        let ok = unsafe {
            castrum_csrf_verify(token.as_ptr(), token.len(), secret.as_ptr(), secret.len())
        };
        assert_eq!(ok, 1);
        // Wrong secret → 0.
        let bad = unsafe { castrum_csrf_verify(token.as_ptr(), token.len(), b"other".as_ptr(), 5) };
        assert_eq!(bad, 0);
    }

    #[test]
    fn password_hash_verify_c_abi() {
        let pw = b"hunter2";
        let salt = b"saltsalt";
        let mut phc = [0u8; 512];
        let w = unsafe {
            castrum_password_hash(pw.as_ptr(), pw.len(), salt.as_ptr(), salt.len(), 19_456, 2, 1, 32, phc.as_mut_ptr(), phc.len())
        };
        assert!(w > 0);
        let ok = unsafe { castrum_password_verify(pw.as_ptr(), pw.len(), phc.as_ptr(), w) };
        assert_eq!(ok, 1);
        let bad = unsafe { castrum_password_verify(b"wrong".as_ptr(), 5, phc.as_ptr(), w) };
        assert_eq!(bad, 0);
    }

    #[test]
    fn bcrypt_c_abi() {
        let pw = b"hunter2";
        let mut phc = [0u8; 128];
        let w = unsafe { castrum_password_hash_bcrypt(pw.as_ptr(), pw.len(), 4, phc.as_mut_ptr(), phc.len()) };
        assert!(w > 0);
        assert_eq!(&phc[..4], b"$2b$");
        let ok = unsafe { castrum_password_verify_bcrypt(pw.as_ptr(), pw.len(), phc.as_ptr(), w) };
        assert_eq!(ok, 1);
    }

    #[test]
    fn pbkdf2_c_abi_matches_napi() {
        let pw = b"password";
        let salt = b"salt";
        let mut out = [0u8; 32];
        let w = unsafe {
            castrum_pbkdf2_sha256(pw.as_ptr(), pw.len(), salt.as_ptr(), salt.len(), 1, 32, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 32);
        // Cross-check against the napi fn (which pins the RFC 7914 vector).
        let napi = crate::crypto::pbkdf2::pbkdf2_sha256(
            napi::bindgen_prelude::Uint8Array::new(pw.to_vec()),
            napi::bindgen_prelude::Uint8Array::new(salt.to_vec()),
            1,
            32,
        )
        .unwrap();
        assert_eq!(&out[..], napi.as_ref());
        // Too-small buffer → 0.
        let mut tiny = [0u8; 4];
        assert_eq!(
            unsafe {
                castrum_pbkdf2_sha256(pw.as_ptr(), pw.len(), salt.as_ptr(), salt.len(), 1, 32, tiny.as_mut_ptr(), tiny.len())
            },
            0
        );
    }

    #[test]
    fn aead_c_abi_roundtrip() {
        let key = b"0123456789abcdef0123456789abcdef"; // 32 bytes
        let nonce = b"123456789012"; // 12 bytes
        let plaintext = b"sensitive payload";
        let mut ct = [0u8; 128];
        let w = unsafe {
            castrum_aead_encrypt(key.as_ptr(), key.len(), nonce.as_ptr(), nonce.len(), plaintext.as_ptr(), plaintext.len(), 0, ct.as_mut_ptr(), ct.len())
        };
        assert_eq!(w, plaintext.len() + 16);
        let mut pt = [0u8; 128];
        let d = unsafe {
            castrum_aead_decrypt(key.as_ptr(), key.len(), nonce.as_ptr(), nonce.len(), ct.as_ptr(), w, 0, pt.as_mut_ptr(), pt.len())
        };
        assert_eq!(&pt[..d], plaintext);
        // Tampered ciphertext → auth failure → 0.
        ct[0] ^= 1;
        let bad = unsafe {
            castrum_aead_decrypt(key.as_ptr(), key.len(), nonce.as_ptr(), nonce.len(), ct.as_ptr(), w, 0, pt.as_mut_ptr(), pt.len())
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn ws_frame_encode_c_abi() {
        let payload = b"hello";
        let mut out = [0u8; 32];
        let w = unsafe {
            castrum_ws_frame_encode(1, payload.as_ptr(), payload.len(), 1, 1, out.as_mut_ptr(), out.len())
        };
        // masked text frame, fin: 0x81, len 5 | 0x80, 4-byte mask + payload.
        assert_eq!(w, 2 + 4 + payload.len());
        assert_eq!(out[0], 0x81);
        assert_eq!(out[1], 0x80 | payload.len() as u8);
    }

    #[test]
    fn json_patch_c_abi() {
        let doc = br#"{"a":1}"#;
        let patch = br#"[{"op":"add","path":"/b","value":2}]"#;
        let mut out = [0u8; 64];
        let w = unsafe {
            castrum_json_patch(doc.as_ptr(), doc.len(), patch.as_ptr(), patch.len(), out.as_mut_ptr(), out.len())
        };
        let patched: serde_json::Value = serde_json::from_slice(&out[..w]).unwrap();
        assert_eq!(patched["b"], 2);
    }

    #[test]
    fn gzip_brotli_c_abi_roundtrip() {
        let data = b"the quick brown fox jumps over the lazy dog ".repeat(10);
        let mut comp = [0u8; 1024];
        let cw = unsafe {
            castrum_gzip_compress(data.as_ptr(), data.len(), 6, comp.as_mut_ptr(), comp.len())
        };
        assert!(cw > 0 && cw < data.len());
        let mut decomp = [0u8; 1024];
        let dw = unsafe {
            castrum_gzip_decompress(comp.as_ptr(), cw, 1024 * 1024, decomp.as_mut_ptr(), decomp.len())
        };
        assert_eq!(&decomp[..dw], data);

        let mut bcomp = [0u8; 2048];
        let bw = unsafe {
            castrum_brotli_compress(data.as_ptr(), data.len(), 5, bcomp.as_mut_ptr(), bcomp.len())
        };
        assert!(bw > 0);
        let mut bdecomp = [0u8; 1024];
        let bdw = unsafe {
            castrum_brotli_decompress(bcomp.as_ptr(), bw, 1024 * 1024, bdecomp.as_mut_ptr(), bdecomp.len())
        };
        assert_eq!(&bdecomp[..bdw], data);
    }

    #[test]
    fn gzip_isize_c_abi() {
        // ISIZE trailer of a standard gzip stream → exact uncompressed size.
        let data = b"the quick brown fox jumps over the lazy dog ".repeat(4);
        let mut comp = [0u8; 512];
        let cw = unsafe {
            castrum_gzip_compress(data.as_ptr(), data.len(), 6, comp.as_mut_ptr(), comp.len())
        };
        assert!(cw > 0);
        let isize = unsafe { castrum_gzip_isize(comp.as_ptr(), cw) };
        assert_eq!(isize as usize, data.len());
        // Not gzip magic → 0.
        assert_eq!(unsafe { castrum_gzip_isize(b"hello world, this is not gzip at all".as_ptr(), 40) }, 0);
        // Too short → 0.
        assert_eq!(unsafe { castrum_gzip_isize(b"\x1f\x8b".as_ptr(), 2) }, 0);
    }

    #[test]
    fn needed_size_convention_c_abi() {
        // gzip compress into a too-small buffer returns the EXACT needed size
        // (> out_cap), NOT 0 — so the JS wrapper allocates once and retries
        // instead of re-running the whole compression in a grow loop.
        let data = b"compress me to prove the needed-size convention works".repeat(20);
        let mut tiny = [0u8; 4];
        let needed = unsafe {
            castrum_gzip_compress(data.as_ptr(), data.len(), 6, tiny.as_mut_ptr(), tiny.len())
        };
        assert!(needed > tiny.len());
        // Allocating exactly `needed` succeeds in one retry.
        let mut exact = vec![0u8; needed];
        let w = unsafe {
            castrum_gzip_compress(data.as_ptr(), data.len(), 6, exact.as_mut_ptr(), exact.len())
        };
        assert_eq!(w, needed);
        // Invalid input → 0 (a REAL error, not "too small").
        let mut out = [0u8; 256];
        let err = unsafe {
            castrum_gzip_decompress(b"not-a-gzip-stream".as_ptr(), 17, 1024 * 1024, out.as_mut_ptr(), out.len())
        };
        assert_eq!(err, 0);

        // jsonPatch: too-small returns the exact needed size.
        let doc = br#"{"a":1,"b":2,"c":3}"#;
        let patch = br#"[{"op":"add","path":"/d","value":4}]"#;
        let mut ptiny = [0u8; 4];
        let pneed = unsafe {
            castrum_json_patch(doc.as_ptr(), doc.len(), patch.as_ptr(), patch.len(), ptiny.as_mut_ptr(), ptiny.len())
        };
        assert!(pneed > ptiny.len());
        let mut pexact = vec![0u8; pneed];
        let pw = unsafe {
            castrum_json_patch(doc.as_ptr(), doc.len(), patch.as_ptr(), patch.len(), pexact.as_mut_ptr(), pexact.len())
        };
        assert_eq!(pw, pneed);

        // jwtSignBytes: too-small returns the exact needed size.
        let claims = br#"{"sub":"user-1"}"#;
        let secret = b"my-secret";
        let mut jtiny = [0u8; 4];
        let jneed = unsafe {
            castrum_jwt_sign_bytes(claims.as_ptr(), claims.len(), secret.as_ptr(), secret.len(), 60, 1_700_000_000, jtiny.as_mut_ptr(), jtiny.len())
        };
        assert!(jneed > jtiny.len());
        let mut jexact = vec![0u8; jneed];
        let jw = unsafe {
            castrum_jwt_sign_bytes(claims.as_ptr(), claims.len(), secret.as_ptr(), secret.len(), 60, 1_700_000_000, jexact.as_mut_ptr(), jexact.len())
        };
        assert_eq!(jw, jneed);

        // passwordHash (argon2) too-small returns the exact PHC length.
        let pw = b"hunter2";
        let salt = b"saltsalt";
        let mut tiny = [0u8; 8];
        let hneed = unsafe {
            castrum_password_hash(pw.as_ptr(), pw.len(), salt.as_ptr(), salt.len(), 19_456, 2, 1, 32, tiny.as_mut_ptr(), tiny.len())
        };
        assert!(hneed > tiny.len());
        let mut hexact = vec![0u8; hneed];
        let hw = unsafe {
            castrum_password_hash(pw.as_ptr(), pw.len(), salt.as_ptr(), salt.len(), 19_456, 2, 1, 32, hexact.as_mut_ptr(), hexact.len())
        };
        assert_eq!(hw, hneed);
    }

    #[test]
    fn packed_parsers_c_abi() {
        // HTTP request line + headers → packed output.
        let req = b"GET /api/users?page=1 HTTP/1.1\r\nhost: example.com\r\n\r\n";
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_http_parse_request_packed(req.as_ptr(), req.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0);

        let query = b"a=1&b=hello%20world";
        let mut qout = [0u8; 256];
        let qw = unsafe {
            castrum_query_parse_packed(query.as_ptr(), query.len(), qout.as_mut_ptr(), qout.len())
        };
        assert!(qw > 0);

        let cookie = b"sid=abc123; theme=dark";
        let mut cout = [0u8; 256];
        let cw = unsafe {
            castrum_cookie_parse_packed(cookie.as_ptr(), cookie.len(), cout.as_mut_ptr(), cout.len())
        };
        assert!(cw > 0);
    }

    #[test]
    fn form_parse_packed_c_abi_matches_query() {
        let input = b"a=1&b=hello%20world";
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_form_parse_packed(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0);
        // Two pairs, matching the query core.
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 2);
    }

    #[test]
    fn multipart_parse_packed_c_abi() {
        let boundary = b"----boundary";
        let bstr = std::str::from_utf8(boundary).unwrap();
        let body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nvalue\r\n--{b}--",
            b = bstr
        );
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_multipart_parse_packed(
                body.as_ptr(),
                body.len(),
                boundary.as_ptr(),
                boundary.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w > 0);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 1);
        // Malformed (wrong boundary) → empty parts → 4-byte count only.
        let w2 = unsafe {
            castrum_multipart_parse_packed(
                body.as_ptr(),
                body.len(),
                b"----nope".as_ptr(),
                9,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w2 >= 4);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0);
    }

    #[test]
    fn ws_frame_decode_packed_c_abi() {
        let payload = b"hello";
        let mut frame = [0u8; 32];
        let fw = unsafe {
            castrum_ws_frame_encode(
                1,
                payload.as_ptr(),
                payload.len(),
                1,
                1,
                frame.as_mut_ptr(),
                frame.len(),
            )
        };
        let mut out = [0u8; 64];
        let w = unsafe {
            castrum_ws_frame_decode_packed(frame.as_ptr(), fw, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 6 + payload.len());
        assert_eq!(out[0], 1); // fin
        assert_eq!(out[1], 1); // opcode text
        assert_eq!(u32::from_le_bytes(out[2..6].try_into().unwrap()), 5);
        assert_eq!(&out[6..w], payload);
        // Truncated frame → 0.
        let bad = unsafe {
            castrum_ws_frame_decode_packed(b"\x80".as_ptr(), 1, out.as_mut_ptr(), out.len())
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn jwt_sign_bytes_c_abi() {
        let claims = br#"{"sub":"user-1"}"#;
        let secret = b"my-secret";
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                60,
                1_700_000_000,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w > 0);
        let token = &out[..w];
        // Compact JWT: header.payload.sig → exactly two dots.
        assert_eq!(token.iter().filter(|&&b| b == b'.').count(), 2);
        assert!(crate::crypto::jwt::verify_signature_with_key(token, &hmac_key(secret)));

        // ttl <= 0 → no iat/exp injection (still signs).
        let w0 = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                0,
                1_700_000_000,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w0 > 0);
        // Invalid claims JSON → 0.
        let bad = unsafe {
            castrum_jwt_sign_bytes(
                b"not-json".as_ptr(),
                8,
                secret.as_ptr(),
                secret.len(),
                60,
                1,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn ingress_handle_packed_c_abi() {
        use crate::ingress::cors::CorsEngine;
        use crate::ingress::options::Limits;
        use crate::ingress::rate_limit::RateLimiterState;

        let inner = crate::ingress::IngressInner {
            https_fixed: None,
            max_body_bytes: 1_048_576,
            proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
            parse_cookies: false,
            parse_query: false,
            require_json_body: false,
            guard_enabled: true,
            emit_metadata_json: false,
            cors_enabled: false,
            cors: CorsEngine::disabled(),
            rate: RateLimiterState::Disabled,
            schema: None,
            limits: Limits::default(),
        };
        // Packed frame: [method 0 = GET][url][ip][rid] sections + empty headers.
        let mut input = Vec::new();
        input.push(0);
        for section in [b"/api/users".as_slice(), b"127.0.0.1".as_slice(), b"rid-1".as_slice()] {
            input.extend_from_slice(&(section.len() as u32).to_le_bytes());
            input.extend_from_slice(section);
        }
        input.extend_from_slice(&0u32.to_le_bytes());

        let mut out = [0u8; 512];
        let ptr = &inner as *const crate::ingress::IngressInner as usize;
        let w = unsafe {
            castrum_ingress_handle_packed(
                ptr,
                input.as_ptr(),
                input.len(),
                std::ptr::null(),
                0,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w > 0);
        // OUT_VERDICT == 0 (ok) at the first output byte.
        assert_eq!(out[0], 0);
        // Invalid inner pointer → 0.
        let bad = unsafe {
            castrum_ingress_handle_packed(
                0,
                input.as_ptr(),
                input.len(),
                std::ptr::null(),
                0,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn panic_guard_returns_fallback_on_panic() {
        // Happy path: no panic, the closure's value comes through.
        assert_eq!(panic_guard(|| 42usize, 0), 42);
        // A panic is caught and replaced by the fallback (the FFI crash path:
        // without catch_unwind this would unwind through the C ABI and kill the
        // host process).
        assert_eq!(panic_guard(|| panic!("boom"), 0usize), 0);
        // Panic AFTER partial work is also contained.
        let mut seen = 0;
        assert_eq!(
            panic_guard(
                || {
                    seen = 1;
                    panic!("boom2");
                },
                7usize,
            ),
            7
        );
        assert_eq!(seen, 1);
    }

    #[test]
    fn ingress_handle_packed_input_overlap_c_abi() {
        use crate::ingress::cors::CorsEngine;
        use crate::ingress::options::Limits;
        use crate::ingress::rate_limit::RateLimiterState;

        let inner = crate::ingress::IngressInner {
            https_fixed: None,
            max_body_bytes: 1_048_576,
            proxy_trust: crate::ingress::ip_trust::ProxyTrustMode::None,
            parse_cookies: false,
            parse_query: false,
            require_json_body: false,
            guard_enabled: true,
            emit_metadata_json: false,
            cors_enabled: false,
            cors: CorsEngine::disabled(),
            rate: RateLimiterState::Disabled,
            schema: None,
            limits: Limits::default(),
        };
        let mut input = Vec::new();
        input.push(0);
        for section in [b"/api/users".as_slice(), b"127.0.0.1".as_slice(), b"rid-1".as_slice()] {
            input.extend_from_slice(&(section.len() as u32).to_le_bytes());
            input.extend_from_slice(section);
        }
        input.extend_from_slice(&0u32.to_le_bytes());

        // Shared buffer: the packed input occupies the front and `out` points
        // INTO THE SAME BUFFER overlapping the input (offset 4) — the aliasing
        // case the FFI entry must handle by copying the input before writing
        // (aliased &[u8]/&mut [u8] would otherwise be instant UB).
        let mut buf = vec![0u8; input.len() + 256];
        buf[..input.len()].copy_from_slice(&input);
        let ptr = &inner as *const crate::ingress::IngressInner as usize;
        let input_ptr = buf.as_ptr();
        let out_ptr = unsafe { buf.as_mut_ptr().add(4) };
        let out_cap = buf.len() - 4;
        assert!(4 < input.len(), "test setup: out region must overlap input");

        let w = unsafe {
            castrum_ingress_handle_packed(
                ptr,
                input_ptr,
                input.len(),
                std::ptr::null(),
                0,
                out_ptr,
                out_cap,
            )
        };
        assert!(w > 0, "pipeline should succeed despite input/out overlap");
        assert_eq!(unsafe { *out_ptr }, 0, "verdict (ok) must land at out start");
    }
}
