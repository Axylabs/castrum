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
use rustc_hash::FxHashMap;
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

// ── Diagnostic C-ABI probes (bench-only, NOT in the ffi.ts surface) ────────
//
// Used ONLY by bench/ffi-margin.ts to isolate the fixed per-call FFI cost into
// its components: the bare trampoline (noop), scalar-arg/return conversion
// (echo_usize, which can be bound with either `usize` or `u64_fast` to measure
// BigInt boxing in isolation), TypedArray-view→pointer resolution
// (echo_view), and `cstring`-ARG transcoding (echo_cstr — the engine encodes
// the JS string to a call-scoped NUL-terminated buffer; the callee borrows it
// via `CStr::from_ptr`, never dereferencing beyond NUL). They are trivial,
// non-fallible, allocate nothing, and are NOT part of the shipped
// `src/native/ffi.ts` dlopen map, so the bind-time self-test does not cover
// them. The `ffi_probe_*` prefix (NOT `castrum_*`) keeps them out of the
// shipped-symbol namespace so the source-level symbol-parity guard
// (test/unit/features/ffi-symbol-parity.test.ts) stays meaningful.

/// Bare C-ABI trampoline floor: does nothing, returns nothing.
#[no_mangle]
pub extern "C" fn ffi_probe_noop() {}

/// Scalar pass-through: returns `v` unchanged. Measures scalar-arg + return
/// conversion only (bind with `usize` vs `u64_fast` to isolate BigInt boxing).
#[no_mangle]
pub extern "C" fn ffi_probe_echo_usize(v: usize) -> usize {
    v
}

/// View pass-through: returns the byte length of the `(ptr, len)` pair.
/// Measures TypedArray-view→pointer resolution + (ptr,len) arg conversion.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes (the pointer is only used to
/// form a slice whose length we return — never dereferenced).
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_view(data: *const u8, len: usize) -> usize {
    if data.is_null() && len != 0 {
        return 0;
    }
    let _ = slice::from_raw_parts(data, len);
    len
}

/// `cstring`-ARG pass-through: returns the byte length of the NUL-terminated
/// C string the engine produced by transcoding a JS string arg. Measures the
/// engine-side JS-string→UTF-8 transcode + call-scoped buffer + callee
/// `CStr::from_ptr` borrow — the cost a `'cstring'` input arg adds compared
/// with a JS-side `encoder.encode` + `(ptr,len)` pair. The pointer is only
/// used to form a slice whose length we return — never dereferenced beyond
/// NUL.
///
/// # Safety
/// `data` must be a valid NUL-terminated C string for reads up to its terminator.
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_cstr(data: *const std::os::raw::c_char) -> usize {
    if data.is_null() {
        return 0;
    }
    std::ffi::CStr::from_ptr(data).to_bytes().len()
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

/// UTF-8 validity check over `data[0..len]`. Returns 1 if the bytes are valid
/// UTF-8, 0 otherwise. Used by the JS `urlDecode` wrapper to mirror the napi
/// fatal UTF-8 validation without a `TextDecoder` on the Bun path.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_utf8_valid(data: *const u8, len: usize) -> u8 {
    if data.is_null() {
        return 0;
    }
    let bytes = slice::from_raw_parts(data, len);
    u8::from(std::str::from_utf8(bytes).is_ok())
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
///
/// The input is a `bun:ffi` `cstring` ARG: the engine transcodes the JS string
/// to a call-scoped NUL-terminated UTF-8 buffer in-engine, so the JS side does
/// zero `encoder.encode` work and the callee borrows via `CStr::from_ptr` (no
/// copy). Only text inputs (never NUL-containing) are valid — see the
/// `cstring`-arg rule in docs/FFI_BUN_GUIDE.md.
macro_rules! validator_c_abi {
    ($name:ident, $core:path) => {
        #[doc = concat!("Validate input as a ", stringify!($name), " → 1/0.")]
        ///
        /// # Safety
        /// `data` must be a valid NUL-terminated C string.
        #[no_mangle]
        pub unsafe extern "C" fn $name(data: *const std::os::raw::c_char) -> u8 {
            if data.is_null() {
                return 0;
            }
            u8::from($core(std::ffi::CStr::from_ptr(data).to_bytes()))
        }
    };
}

validator_c_abi!(
    castrum_validate_email,
    crate::util::validation::validate_email_bytes
);
validator_c_abi!(
    castrum_validate_uuid,
    crate::util::validation::validate_uuid_bytes
);
validator_c_abi!(
    castrum_validate_ipv4,
    crate::util::validation::validate_ipv4_bytes
);
validator_c_abi!(
    castrum_validate_ipv6,
    crate::util::validation::validate_ipv6_bytes
);

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

// ── Fixed / bounded-size output writers ──────────────────────────

/// RFC 6455 Sec-WebSocket-Accept (28 bytes) returned as a null-terminated C
/// string into the per-thread reused buffer (`cstring` return).
///
/// `key` is a `bun:ffi` `cstring` ARG — the engine transcodes the JS base64 key
/// in-engine (JS does zero encode; the callee borrows via `CStr::from_ptr`).
/// The pooled `castrum_ws_accept_key_into` keeps the `(ptr,len)` byte form.
///
/// # Safety
/// `key` must be a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_accept_key(
    key: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if key.is_null() {
        return std::ptr::null();
    }
    cstring_return(28, |out| {
        crate::payload::websocket::ws_accept_key_into(std::ffi::CStr::from_ptr(key).to_bytes(), out)
            .ok()
    })
}

/// RFC 6455 Sec-WebSocket-Accept written directly into a caller buffer — the
/// pooled sibling of `castrum_ws_accept_key` (no cstring round-trip). Writes 28
/// bytes; returns bytes written, the exact required size when `out_cap` is too
/// small, or 0 on a malformed key.
///
/// # Safety
/// `key` must be valid for reads of `klen` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_accept_key_into(
    key: *const u8,
    klen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if key.is_null() || out.is_null() {
        return 0;
    }
    if out_cap < 28 {
        return 28;
    }
    match crate::payload::websocket::ws_accept_key_into(
        slice::from_raw_parts(key, klen),
        slice::from_raw_parts_mut(out, 28),
    ) {
        Ok(28) => 28,
        _ => 0,
    }
}

/// crc32-based ETag (10 strong / 12 weak) into `out`; `weak` is a u8 flag.
///
/// # Safety
/// ETag (`"<8-hex>"` or `W/"<8-hex>"`) returned as a null-terminated C string
/// into the per-thread reused buffer (`cstring` return — the engine clones it).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_etag(
    data: *const u8,
    len: usize,
    weak: u8,
) -> *const std::os::raw::c_char {
    if data.is_null() {
        return std::ptr::null();
    }
    let crc = crc32fast::hash(slice::from_raw_parts(data, len));
    let needed = if weak != 0 { 12 } else { 10 };
    cstring_return(needed, |out| {
        crate::http::etag::etag_from_crc32_into(crc, weak != 0, out).ok()
    })
}

/// crc32-based ETag written directly into a caller buffer — the pooled sibling
/// of `castrum_etag` (no cstring round-trip). Writes 10 strong / 12 weak bytes;
/// returns bytes written, the exact required size when `out_cap` is too small,
/// or 0 on invalid input.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_etag_into(
    data: *const u8,
    len: usize,
    weak: u8,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let needed = if weak != 0 { 12 } else { 10 };
    if out_cap < needed {
        return needed;
    }
    let crc = crc32fast::hash(slice::from_raw_parts(data, len));
    crate::http::etag::etag_from_crc32_into(
        crc,
        weak != 0,
        slice::from_raw_parts_mut(out, needed),
    )
    .unwrap_or_default()
}

/// Evaluate `ConditionalRequest::is_not_modified` against the precompiled state
/// via its opaque inner handle (from the napi `inner_ptr()`). `flags` bit0 =
/// If-None-Match present, bit1 = If-Modified-Since present (a present-but-empty
/// header is distinct from absent, matching the napi `Option` semantics).
/// Returns 1 → 304. A null handle (0) → 0, so a dropped instance can never
/// dereference freed state.
///
/// # Safety
/// `inner` must be a valid `ConditionalRequest` pointer obtained from
/// `inner_ptr()` and must stay alive for the call (the JS wrapper holds the
/// napi instance). `inm`/`ims` are `bun:ffi` `cstring` ARGs — NUL-terminated
/// C strings (the engine transcodes the JS header strings in-engine; zero JS
/// encode); presence is gated by `flags`, so their pointers are ignored when
/// the corresponding bit is 0.
#[no_mangle]
pub unsafe extern "C" fn castrum_conditional_is_not_modified(
    inner: usize,
    inm: *const std::os::raw::c_char,
    ims: *const std::os::raw::c_char,
    flags: u8,
) -> u8 {
    if inner == 0 {
        return 0;
    }
    let inm_opt = if flags & 1 != 0 {
        Some(std::ffi::CStr::from_ptr(inm).to_bytes())
    } else {
        None
    };
    let ims_opt = if flags & 2 != 0 {
        Some(std::ffi::CStr::from_ptr(ims).to_bytes())
    } else {
        None
    };
    panic_guard(
        || {
            u8::from(unsafe {
                crate::http::etag::conditional_is_not_modified(
                    inner as *const crate::http::etag::ConditionalRequest,
                    inm_opt,
                    ims_opt,
                )
            })
        },
        0,
    )
}

/// MediaTypeMatcher: wildcard match against the PRECOMPILED expected type via
/// its opaque inner handle. Returns 1 = match. A null handle (0) → 0.
///
/// # Safety
/// `inner` must be a valid `MediaTypeMatcher` pointer from `inner_ptr()`, alive
/// for the call (the JS wrapper holds the napi instance).
#[no_mangle]
pub unsafe extern "C" fn castrum_media_type_matcher_matches(
    inner: usize,
    actual: *const u8,
    actual_len: usize,
) -> u8 {
    if inner == 0 || actual.is_null() {
        return 0;
    }
    let a = slice::from_raw_parts(actual, actual_len);
    panic_guard(
        || {
            u8::from(unsafe {
                crate::http::media_type::media_type_matcher_matches_core(
                    inner as *const crate::http::media_type::MediaTypeMatcher,
                    a,
                )
            })
        },
        0,
    )
}

/// AcceptNegotiator: best supported encoding for `header` against the
/// PRECOMPILED supported list via its opaque inner handle → cstring (`null` =
/// identity, matching napi `Option<String>`).
///
/// # Safety
/// `inner` must be a valid `AcceptNegotiator` pointer from `inner_ptr()`, alive
/// for the call.
/// `header` is a `bun:ffi` `cstring` ARG — a NUL-terminated C string (the
/// engine transcodes the JS header string in-engine; zero JS encode), never
/// NUL-containing (see the `cstring`-arg rule in docs/FFI_BUN_GUIDE.md).
#[no_mangle]
pub unsafe extern "C" fn castrum_accept_negotiator_negotiate(
    inner: usize,
    header: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if inner == 0 || header.is_null() {
        return std::ptr::null();
    }
    let h = std::ffi::CStr::from_ptr(header).to_bytes();
    let Some(bytes) = panic_guard(
        || unsafe {
            crate::http::accept::accept_negotiator_negotiate_core(
                inner as *const crate::http::accept::AcceptNegotiator,
                h,
            )
        },
        None,
    ) else {
        return std::ptr::null();
    };
    cstring_return(bytes.len(), |out| {
        out[..bytes.len()].copy_from_slice(&bytes);
        Some(bytes.len())
    })
}

/// AcceptNegotiator: best supported encoding for `header` with SERVER-
/// preference tie-breaking (ignex `negotiateEncoding` semantics — q-only, the
/// supported list's order breaks ties, empty header → identity). Same opaque
/// handle + cstring contract as `castrum_accept_negotiator_negotiate`.
///
/// # Safety
/// `inner` must be a valid `AcceptNegotiator` pointer from `inner_ptr()`, alive
/// for the call. `header` is a `bun:ffi` `cstring` ARG — a NUL-terminated C
/// string (the engine transcodes the JS header string in-engine; zero JS
/// encode), never NUL-containing.
#[no_mangle]
pub unsafe extern "C" fn castrum_accept_negotiator_negotiate_server(
    inner: usize,
    header: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if inner == 0 || header.is_null() {
        return std::ptr::null();
    }
    let h = std::ffi::CStr::from_ptr(header).to_bytes();
    let Some(bytes) = panic_guard(
        || unsafe {
            crate::http::accept::accept_negotiator_negotiate_server_core(
                inner as *const crate::http::accept::AcceptNegotiator,
                h,
            )
        },
        None,
    ) else {
        return std::ptr::null();
    };
    cstring_return(bytes.len(), |out| {
        out[..bytes.len()].copy_from_slice(&bytes);
        Some(bytes.len())
    })
}

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

/// TemplateRenderer: render the compiled template with a pre-serialized JSON
/// context via its opaque inner handle. Needed-size convention; 0 = invalid
/// context / render error / null handle (real error).
///
/// # Safety
/// `inner` must be a valid `TemplateRenderer` pointer from `inner_ptr()`, alive
/// for the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_template_render(
    inner: usize,
    context: *const u8,
    context_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || context.is_null() || out.is_null() {
        return 0;
    }
    let c = slice::from_raw_parts(context, context_len);
    let Some(rendered) = panic_guard(
        || unsafe {
            crate::payload::template::template_render_core(
                inner as *const crate::payload::template::TemplateRenderer,
                c,
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if rendered.len() > out_cap {
        return rendered.len();
    }
    slice::from_raw_parts_mut(out, rendered.len()).copy_from_slice(&rendered);
    rendered.len()
}

/// SchemaValidator: validate a document against the COMPILED schema via its
/// opaque inner handle. Returns 1 = valid. A null handle (0) → 0.
///
/// # Safety
/// `inner` must be a valid `SchemaValidator` pointer from `inner_ptr()`, alive
/// for the call.
#[no_mangle]
pub unsafe extern "C" fn castrum_schema_validator_validate(
    inner: usize,
    doc: *const u8,
    doc_len: usize,
) -> u8 {
    if inner == 0 || doc.is_null() {
        return 0;
    }
    let d = slice::from_raw_parts(doc, doc_len);
    panic_guard(
        || {
            u8::from(unsafe {
                crate::json::json_schema::schema_validator_validate_core(
                    inner as *const crate::json::json_schema::SchemaValidator,
                    d,
                )
            })
        },
        0,
    )
}

/// RateLimiter: check a rate limit for a STRING key (hashed internally) at
/// `now_ms` via its opaque inner handle. Writes packed `[u8 allowed][u32
/// remaining LE][i64 reset_ms LE]` (13 bytes); needed-size convention; 0 =
/// null handle (real error).
///
/// `key` is a `bun:ffi` `cstring` ARG — the engine transcodes the JS rate-limit
/// key in-engine (JS does zero encode; the callee borrows via `CStr::from_ptr`).
/// Intended keys are IPs / route identifiers (text, no NUL); a key containing a
/// NUL would be truncated before hashing.
///
/// # Safety
/// `inner` must be a valid `RateLimiter` pointer from `inner_ptr()`, alive for
/// the call; `key` must be a valid NUL-terminated C string; `out` for writes up
/// to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_rate_limiter_check(
    inner: usize,
    key: *const std::os::raw::c_char,
    now_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || key.is_null() || out.is_null() {
        return 0;
    }
    let k = std::ffi::CStr::from_ptr(key).to_bytes();
    let hashed = crate::crypto::hashing::fast_hash_bytes(k);
    let (allowed, remaining, reset_ms) = panic_guard(
        || unsafe {
            crate::ingress::rate_limit::rate_limiter_check_core(
                inner as *const crate::ingress::rate_limit::RateLimiter,
                hashed,
                now_ms as u64,
            )
        },
        (false, 0, 0),
    );
    write_rate_check(allowed, remaining, reset_ms, out, out_cap)
}

/// RateLimiter: check a rate limit for a PRE-HASHED i64 key at `now_ms` via its
/// opaque inner handle (packed `[u8 allowed][u32 remaining LE][i64 reset_ms LE]`).
///
/// # Safety
/// `inner` must be a valid `RateLimiter` pointer from `inner_ptr()`, alive for
/// the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_rate_limiter_check_key(
    inner: usize,
    key: i64,
    now_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || out.is_null() {
        return 0;
    }
    let (allowed, remaining, reset_ms) = panic_guard(
        || unsafe {
            crate::ingress::rate_limit::rate_limiter_check_core(
                inner as *const crate::ingress::rate_limit::RateLimiter,
                key as u64,
                now_ms as u64,
            )
        },
        (false, 0, 0),
    );
    write_rate_check(allowed, remaining, reset_ms, out, out_cap)
}

/// Write the packed `[u8 allowed][u32 remaining LE][i64 reset_ms LE]` verdict;
/// returns bytes written or the exact required size (13) when `out_cap` is too
/// small. Never returns 0 on a valid call.
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
unsafe fn write_rate_check(
    allowed: bool,
    remaining: u32,
    reset_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if out_cap < 13 {
        return 13;
    }
    let o = slice::from_raw_parts_mut(out, 13);
    o[0] = u8::from(allowed);
    o[1..5].copy_from_slice(&remaining.to_le_bytes());
    o[5..13].copy_from_slice(&reset_ms.to_le_bytes());
    13
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
    crate::crypto::cookie_sign::sign_cookie_into(
        v,
        &key,
        slice::from_raw_parts_mut(out, out_cap),
    )
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
        let dot = s.iter().rposition(|&b| b == b'.').map_or(0, |i| i);
        if dot != 0 {
            return dot;
        }
        return slen;
    }
    crate::crypto::cookie_sign::verify_cookie_into(
        s,
        &key,
        slice::from_raw_parts_mut(out, out_cap),
    )
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
            crate::json::patch::apply_json_patch_bytes(
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

compress_to_out!(
    castrum_gzip_compress,
    crate::payload::compress::gzip_compress_into,
    u32
);
compress_to_out!(
    castrum_gzip_decompress,
    crate::payload::compress::gzip_decompress_into,
    usize
);
compress_to_out!(
    castrum_brotli_compress,
    crate::payload::compress::brotli_compress_into,
    u32
);
compress_to_out!(
    castrum_brotli_decompress,
    crate::payload::compress::brotli_decompress_into,
    usize
);

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
/// # Convention (needed-size)
/// The single-pass writer runs first; on a too-small buffer the exact-size pass
/// runs (rare) and returns the EXACT required size, so the JS wrapper allocates
/// ONCE and retries — no 9× pre-size, no re-run loop. `0` remains a REAL error
/// (malformed `%XX`).
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
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, out_cap);
    match crate::http::query_parser::query_parse_packed_into_slice(input, output) {
        Ok(w) => w,
        // Too-small OR malformed — the size pass disambiguates: it parses the
        // same input, so Ok(needed) ⇒ too-small, Err ⇒ malformed (real error).
        Err(_) => crate::http::query_parser::query_parse_packed_size(input).unwrap_or(0),
    }
}

/// Cookie header parse → packed output into `out`.
///
/// Same needed-size convention as `castrum_query_parse_packed`.
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
    let input = slice::from_raw_parts(data, len);
    let output = slice::from_raw_parts_mut(out, out_cap);
    match crate::http::cookie_parser::cookie_parse_packed_into_slice(input, output) {
        Ok(w) => w,
        Err(_) => crate::http::cookie_parser::cookie_parse_packed_size(input).unwrap_or(0),
    }
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

/// Write an HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`) into `out`. Returns
/// bytes written (29), or 0 on a too-small buffer / out-of-range year (use the
/// allocating `httpDate` napi path for that fallback). Fixed 32-byte stack
/// buffer core — the FFI sibling of the napi `httpDateInto` (kills the napi
/// crossing on the hot `httpDateInto` path).
///
/// # Safety
/// `out` must be valid for writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_http_date_into(
    secs: f64,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if out.is_null() {
        return 0;
    }
    let output = slice::from_raw_parts_mut(out, out_cap);
    crate::http::http_date::http_date_into_slice(secs as i64, output).unwrap_or(0)
}

/// Encode one SSE event into `out`. Optional fields use `flags` bits
/// (1 = event present, 2 = id present, 4 = retry present) so a present-but-empty
/// string is distinct from an absent one, matching the napi `Option<String>`.
/// Returns bytes written, or 0 on a too-small buffer / invalid UTF-8 in
/// event/id (JS sizes `data_len + 64` to guarantee success). FFI sibling of the
/// napi `sse_encode_event` — the wrapper decodes nothing (output is raw SSE
/// bytes), so this just removes the napi crossing.
///
/// # Safety
/// `event`/`id` must be valid for reads of `event_len`/`id_len` bytes when their
/// flag is set; `data` valid for `data_len` reads; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_sse_encode_into(
    event: *const u8,
    event_len: usize,
    data: *const u8,
    data_len: usize,
    id: *const u8,
    id_len: usize,
    flags: u8,
    retry: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    // A PRESENT but empty event/id is valid (emits the line) — only a null
    // pointer with its flag set is malformed (would be UB to slice).
    if (flags & 1 != 0 && event.is_null()) || (flags & 2 != 0 && id.is_null()) {
        return 0;
    }
    panic_guard(
        || -> Option<usize> {
            let data_bytes = slice::from_raw_parts(data, data_len);
            let output = slice::from_raw_parts_mut(out, out_cap);
            let event_opt = if flags & 1 != 0 {
                Some(std::str::from_utf8(slice::from_raw_parts(event, event_len)).ok()?)
            } else {
                None
            };
            let id_opt = if flags & 2 != 0 {
                Some(std::str::from_utf8(slice::from_raw_parts(id, id_len)).ok()?)
            } else {
                None
            };
            let retry_opt = if flags & 4 != 0 {
                Some(u64::from(retry))
            } else {
                None
            };
            match crate::payload::sse::encode_event_into_slice(
                event_opt,
                data_bytes,
                id_opt,
                retry_opt,
                output,
            ) {
                Ok(w) => Some(w),
                // Too-small buffer: return the exact required size so the JS
                // wrapper allocates ONCE and retries (needed-size convention);
                // 0 stays a real error (invalid UTF-8 in event/id above).
                Err(_) => Some(crate::payload::sse::encode_event_size(
                    event_opt,
                    data_bytes,
                    id_opt,
                    retry_opt,
                )),
            }
        },
        None,
    )
    .unwrap_or(0)
}

// ── cstring-returning writers (per-thread reused buffer) ─────────
// Bun's `cstring` FFI return type has the ENGINE clone the result string out
// of the returned pointer at the moment of the call (bun:ffi docs), so the JS
// side pays ZERO decode + ZERO allocation for these single-string outputs.
// The buffer is thread-local and reused across calls (same pattern as
// HMAC_KEY_CACHE above) — valid only until the next call on the same thread,
// which is all the engine needs (it clones synchronously at return).
thread_local! {
    static CSTR_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Write `write` into the per-thread buffer sized to `needed` (reused across
/// calls), null-terminate, and return the pointer. `null` = write error
/// (malformed input / crypto failure — the caller maps to a throw or sentinel).
fn cstring_return(
    needed: usize,
    write: impl FnOnce(&mut [u8]) -> Option<usize>,
) -> *const std::os::raw::c_char {
    CSTR_BUF.with(|cell| {
        let mut buf = cell.borrow_mut();
        if buf.len() < needed + 1 {
            buf.resize(needed + 1, 0);
        }
        let cap = buf.len() - 1;
        match write(&mut buf[..cap]) {
            Some(w) => {
                buf[w] = 0;
                buf.as_ptr() as *const std::os::raw::c_char
            }
            None => std::ptr::null(),
        }
    })
}

// ── Phase 3: remaining stateless scalar cores ─────────────────────
// C-ABI siblings of the last napi-only scalar fns so every Rust hot surface
// has a bun:ffi path. String results use the `cstring` return (the engine
// clones the NUL-terminated buffer at call time — zero JS decode); structured
// verdicts use the packed / needed-size convention (`0` = real error,
// `w > out_cap` = exact required size so the JS side allocates once and
// retries). Every fallible / allocating core routes through `panic_guard`.

// ── Packed JSON token stream (structural parse, no re-parse) ────────
// `castrum_json_parse_packed` parses ONCE with sonic-rs and emits a typed
// token stream with a DEDUPLICATED string table. The JS side assembles the
// value directly from the tokens — it never re-parses JSON text, and repeated
// keys/values are decoded exactly once (the old cstring path re-serialized the
// whole doc to text and `JSON.parse`d it again, measured 3.92x slower than
// Bun's JSON.parse on the 5k-row fixture).
//
// Layout: `[u32 strCount]{[u32 len][utf8 bytes]}... [u32 treeLen][tree]`
// The tree is a single value encoded as a start/end-marker token stream
// (little-endian; no counts — the sonic-rs SeqAccess/MapAccess expose no
// size_hint, and markers let JS decode iteratively with `push`/`pop`):
//   0 = null | 1 = false | 2 = true | 3 = number (f64 LE, 8 bytes)
//   4 = string (u32 index into the string table)
//   5 = array start | 6 = object start
//   7 = array end | 8 = object end
//   9 = object key (u32 index into the string table)
// Object body: `6, (9, keyIdx, value)*, 8`.

const JSON_PACKED_NULL: u8 = 0;
const JSON_PACKED_FALSE: u8 = 1;
const JSON_PACKED_TRUE: u8 = 2;
const JSON_PACKED_NUMBER: u8 = 3;
const JSON_PACKED_STRING: u8 = 4;
const JSON_PACKED_ARRAY_START: u8 = 5;
const JSON_PACKED_OBJECT_START: u8 = 6;
const JSON_PACKED_ARRAY_END: u8 = 7;
const JSON_PACKED_OBJECT_END: u8 = 8;
const JSON_PACKED_KEY: u8 = 9;

/// Single-pass emitter. sonic-rs's fast parser drives this via serde, writing
/// the packed token stream DIRECTLY — there is NO intermediate `sonic_rs::Value`
/// DOM (building it measured ~1.0ms for the 5k-row fixture). Strings (keys +
/// values) are interned into a deduplicated table keyed by OWNED bytes
/// (`Vec<u8>`) so escaped strings work uniformly; lookups borrow (`get(&[u8])`)
/// without allocating. `FxHashMap` (rustc-hash) is used because default SipHash
/// is slow on short keys (same choice fast_schema makes); a hash collision only
/// costs an extra byte compare, never a wrong index. Dedup keeps the JS-side
/// decode to ~1 decode per unique string (a per-occurrence blob was ~10x worse
/// on the JS side due to rope-slicing).
struct JsonPackedEmitter {
    strings: FxHashMap<Vec<u8>, u32>,
    table: Vec<u8>,
    tree: Vec<u8>,
}

impl JsonPackedEmitter {
    #[inline]
    fn intern(&mut self, bytes: &[u8]) -> u32 {
        if let Some(&idx) = self.strings.get(bytes) {
            return idx;
        }
        let idx = self.strings.len() as u32;
        self.strings.insert(bytes.to_vec(), idx);
        self.table.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        self.table.extend_from_slice(bytes);
        idx
    }

    #[inline]
    fn emit_u32(&mut self, v: u32) {
        self.tree.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    fn emit_string(&mut self, s: &str) {
        self.tree.push(JSON_PACKED_STRING);
        let idx = self.intern(s.as_bytes());
        self.emit_u32(idx);
    }

    #[inline]
    fn emit_key(&mut self, s: &str) {
        self.tree.push(JSON_PACKED_KEY);
        let idx = self.intern(s.as_bytes());
        self.emit_u32(idx);
    }

    #[inline]
    fn emit_number(&mut self, f: f64) {
        self.tree.push(JSON_PACKED_NUMBER);
        self.tree.extend_from_slice(&f.to_le_bytes());
    }
}

/// Seed that deserializes any nested value through the shared emitter.
struct JsonPackedSeed<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::DeserializeSeed<'de> for JsonPackedSeed<'_> {
    type Value = ();

    #[inline]
    fn deserialize<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_any(JsonPackedVisitor { out: self.out })
    }
}

/// Seed for object KEYS (always JSON strings).
struct JsonPackedKeySeed<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::DeserializeSeed<'de> for JsonPackedKeySeed<'_> {
    type Value = ();

    #[inline]
    fn deserialize<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_str(JsonPackedKeyVisitor { out: self.out })
    }
}

struct JsonPackedKeyVisitor<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::Visitor<'de> for JsonPackedKeyVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an object key")
    }

    #[inline]
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_key(v);
        Ok(())
    }

    #[inline]
    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_str(v)
    }

    #[inline]
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_str(v.as_str())
    }
}

struct JsonPackedVisitor<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::Visitor<'de> for JsonPackedVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("any JSON value")
    }

    #[inline]
    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out
            .tree
            .push(if v { JSON_PACKED_TRUE } else { JSON_PACKED_FALSE });
        Ok(())
    }

    #[inline]
    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        // f64 = JS number semantics (the napi serde_json::Value path rounds the
        // same way JSON.parse does).
        self.out.emit_number(v as f64);
        Ok(())
    }

    #[inline]
    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_number(v as f64);
        Ok(())
    }

    #[inline]
    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_number(v);
        Ok(())
    }

    #[inline]
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v);
        Ok(())
    }

    #[inline]
    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v);
        Ok(())
    }

    #[inline]
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v.as_str());
        Ok(())
    }

    #[inline]
    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.tree.push(JSON_PACKED_NULL);
        Ok(())
    }

    #[inline]
    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.tree.push(JSON_PACKED_NULL);
        Ok(())
    }

    #[inline]
    fn visit_some<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_any(self)
    }

    #[inline]
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        self.out.tree.push(JSON_PACKED_ARRAY_START);
        while let Some(()) = seq.next_element_seed(JsonPackedSeed { out: &mut *self.out })? {}
        self.out.tree.push(JSON_PACKED_ARRAY_END);
        Ok(())
    }

    #[inline]
    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        self.out.tree.push(JSON_PACKED_OBJECT_START);
        while let Some(()) = map.next_key_seed(JsonPackedKeySeed { out: &mut *self.out })? {
            map.next_value_seed(JsonPackedSeed { out: &mut *self.out })?;
        }
        self.out.tree.push(JSON_PACKED_OBJECT_END);
        Ok(())
    }
}

impl<'de> serde::Deserialize<'de> for JsonPackedEmitter {
    #[inline]
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        let mut out = JsonPackedEmitter {
            strings: FxHashMap::default(),
            table: Vec::new(),
            tree: Vec::new(),
        };
        d.deserialize_any(JsonPackedVisitor { out: &mut out })?;
        Ok(out)
    }
}

/// Parse JSON → packed token stream (see the layout above). Needed-size
/// convention: `0` = invalid JSON (real error → JS throws); `w > out_cap` =
/// exact required size (JS allocates once and retries); else bytes written.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_parse_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let Some(emitter) = panic_guard(|| sonic_rs::from_slice::<JsonPackedEmitter>(input).ok(), None)
    else {
        return 0;
    };
    // Write the packed [u32 stringsLen][table][u32 treeLen][tree] directly
    // into the caller's buffer — no intermediate Vec + second copy.
    let needed = 4 + emitter.table.len() + 4 + emitter.tree.len();
    if needed > out_cap {
        return needed;
    }
    let out = slice::from_raw_parts_mut(out, needed);
    let mut wp = 0usize;
    out[wp..wp + 4].copy_from_slice(&(emitter.strings.len() as u32).to_le_bytes());
    wp += 4;
    out[wp..wp + emitter.table.len()].copy_from_slice(&emitter.table);
    wp += emitter.table.len();
    out[wp..wp + 4].copy_from_slice(&(emitter.tree.len() as u32).to_le_bytes());
    wp += 4;
    out[wp..wp + emitter.tree.len()].copy_from_slice(&emitter.tree);
    wp += emitter.tree.len();
    wp
}

/// Parse a `Content-Type` header into a packed verdict:
/// `[u32 mediaTypeLen][mediaType][u32 charsetLen (0xFFFFFFFF = none)][charset]
/// [u32 boundaryLen (0xFFFFFFFF = none)][boundary][u32 paramCount]{[u32 keyLen]
/// [key][u32 valLen][val]}`. Needed-size convention: `0` = invalid media type
/// (real error → throw); `w > out_cap` = exact required size; else written.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_parse_media_type(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let Some(parsed) = panic_guard(
        || crate::http::media_type::parse_media_type_core(input).ok(),
        None,
    ) else {
        return 0;
    };
    // Borrowed charset/boundary lookups (no String clones) + direct write into
    // the caller's buffer — no `format!`, no intermediate Vec, no final copy.
    let charset = parsed
        .params
        .iter()
        .find(|(k, _)| k == "charset")
        .map(|(_, v)| v.as_bytes());
    let boundary = parsed
        .params
        .iter()
        .find(|(k, _)| k == "boundary")
        .map(|(_, v)| v.as_bytes());
    let mt_len = parsed.ty.len() + 1 + parsed.subtype.len();
    let mut needed = 4 + mt_len;
    needed += charset.map_or(4, |v| 4 + v.len());
    needed += boundary.map_or(4, |v| 4 + v.len());
    needed += 4; // paramCount
    for (k, v) in &parsed.params {
        needed += 4 + k.len() + 4 + v.len();
    }
    if needed > out_cap {
        return needed;
    }
    let out = slice::from_raw_parts_mut(out, needed);
    let mut wp = 0usize;
    out[wp..wp + 4].copy_from_slice(&(mt_len as u32).to_le_bytes());
    wp += 4;
    out[wp..wp + parsed.ty.len()].copy_from_slice(parsed.ty.as_bytes());
    wp += parsed.ty.len();
    out[wp] = b'/';
    wp += 1;
    out[wp..wp + parsed.subtype.len()].copy_from_slice(parsed.subtype.as_bytes());
    wp += parsed.subtype.len();
    // charset option slot ([u32 len][charset] or u32::MAX when absent)
    match charset {
        Some(v) => {
            out[wp..wp + 4].copy_from_slice(&(v.len() as u32).to_le_bytes());
            wp += 4;
            out[wp..wp + v.len()].copy_from_slice(v);
            wp += v.len();
        }
        None => {
            out[wp..wp + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            wp += 4;
        }
    }
    // boundary option slot
    match boundary {
        Some(v) => {
            out[wp..wp + 4].copy_from_slice(&(v.len() as u32).to_le_bytes());
            wp += 4;
            out[wp..wp + v.len()].copy_from_slice(v);
            wp += v.len();
        }
        None => {
            out[wp..wp + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            wp += 4;
        }
    }
    // params
    out[wp..wp + 4].copy_from_slice(&(parsed.params.len() as u32).to_le_bytes());
    wp += 4;
    for (k, v) in &parsed.params {
        out[wp..wp + 4].copy_from_slice(&(k.len() as u32).to_le_bytes());
        wp += 4;
        out[wp..wp + k.len()].copy_from_slice(k.as_bytes());
        wp += k.len();
        out[wp..wp + 4].copy_from_slice(&(v.len() as u32).to_le_bytes());
        wp += 4;
        out[wp..wp + v.len()].copy_from_slice(v.as_bytes());
        wp += v.len();
    }
    debug_assert_eq!(wp, needed);
    needed
}

/// Parse an IMF-fixdate back to unix seconds → packed `[u8 ok][i64 secs LE]`
/// (9 bytes; ok=0 → invalid). Mirrors the `castrum_json_sum_ids` ok-byte
/// convention so a legit epoch (`0`) is distinct from "invalid". Needed-size
/// convention: `0` = buffer too small (real error).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_parse_http_date(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let secs = panic_guard(|| crate::http::http_date::parse_http_date_secs(input), None);
    match secs {
        Some(secs) => {
            if out_cap < 9 {
                return 9;
            }
            let o = slice::from_raw_parts_mut(out, 9);
            o[0] = 1;
            o[1..9].copy_from_slice(&secs.to_le_bytes());
            9
        }
        None => {
            if out_cap < 1 {
                return 1;
            }
            slice::from_raw_parts_mut(out, 1)[0] = 0;
            1
        }
    }
}

/// Parse an Accept-Encoding header into a packed verdict:
/// `[u32 count]{[u32 encLen][enc][f32 q][u32 order]}` (empty header → count 0,
/// 4 bytes). Needed-size convention: `0` = buffer too small (real error);
/// `w > out_cap` = exact required size; else bytes written.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_parse_accept_encoding(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let Some(prefs) = panic_guard(|| Some(crate::http::accept::parse_accept_encoding_core(input)), None)
    else {
        return 0;
    };
    // Write the packed [u32 count]{[u32 encLen][enc][f32 q][u32 order]} verdict
    // directly into the caller's buffer — no intermediate Vec + copy.
    let mut needed = 4usize;
    for p in &prefs {
        needed += 4 + p.encoding.len() + 4 + 4;
    }
    if needed > out_cap {
        return needed;
    }
    let out = slice::from_raw_parts_mut(out, needed);
    let mut wp = 4usize;
    out[0..4].copy_from_slice(&(prefs.len() as u32).to_le_bytes());
    for p in &prefs {
        out[wp..wp + 4].copy_from_slice(&(p.encoding.len() as u32).to_le_bytes());
        wp += 4;
        out[wp..wp + p.encoding.len()].copy_from_slice(p.encoding.as_bytes());
        wp += p.encoding.len();
        out[wp..wp + 4].copy_from_slice(&p.q.to_le_bytes());
        wp += 4;
        out[wp..wp + 4].copy_from_slice(&p.order.to_le_bytes());
        wp += 4;
    }
    debug_assert_eq!(wp, needed);
    wp
}

/// Percent-encode a query string from a packed `[u32 count]{[u32 keyLen][key]
/// [u32 valLen][val]}` input (the JS `packPairs` layout) → cstring, keys
/// SORTED (matches the napi `BTreeMap` ordering). Returns `null` on malformed
/// packed input / non-UTF-8 (napi parity: throws).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_url_encode_query(
    data: *const u8,
    len: usize,
) -> *const std::os::raw::c_char {
    if data.is_null() {
        return std::ptr::null();
    }
    let input = slice::from_raw_parts(data, len);
    let Some(s) = panic_guard(
        || {
            if input.len() < 4 {
                return None;
            }
            let count =
                u32::from_le_bytes([input[0], input[1], input[2], input[3]]) as usize;
            let mut map = std::collections::BTreeMap::new();
            let mut off = 4usize;
            for _ in 0..count {
                if off + 4 > input.len() {
                    return None;
                }
                let klen = u32::from_le_bytes([
                    input[off],
                    input[off + 1],
                    input[off + 2],
                    input[off + 3],
                ]) as usize;
                off += 4;
                if off + klen > input.len() {
                    return None;
                }
                let key = std::str::from_utf8(&input[off..off + klen])
                    .ok()?
                    .to_string();
                off += klen;
                if off + 4 > input.len() {
                    return None;
                }
                let vlen = u32::from_le_bytes([
                    input[off],
                    input[off + 1],
                    input[off + 2],
                    input[off + 3],
                ]) as usize;
                off += 4;
                if off + vlen > input.len() {
                    return None;
                }
                let val = std::str::from_utf8(&input[off..off + vlen])
                    .ok()?
                    .to_string();
                off += vlen;
                map.insert(key, val);
            }
            let mut out = Vec::new();
            let mut scratch = Vec::new();
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(b'&');
                }
                crate::http::url_join::encode_query_component(k.as_bytes(), &mut scratch, &mut out)
                    .ok()?;
                out.push(b'=');
                crate::http::url_join::encode_query_component(v.as_bytes(), &mut scratch, &mut out)
                    .ok()?;
            }
            String::from_utf8(out).ok()
        },
        None,
    ) else {
        return std::ptr::null();
    };
    cstring_return(s.len(), |out| {
        out[..s.len()].copy_from_slice(s.as_bytes());
        Some(s.len())
    })
}

/// RFC 3986 URL resolution → cstring (base + reference). Returns `null` on
/// non-UTF-8 input (napi parity: throws). Mirrors the napi `url_resolve`.
///
/// # Safety
/// `base`/`reference` must be valid for reads of their lengths.
#[no_mangle]
pub unsafe extern "C" fn castrum_url_resolve(
    base: *const u8,
    blen: usize,
    reference: *const u8,
    rlen: usize,
) -> *const std::os::raw::c_char {
    if base.is_null() || reference.is_null() {
        return std::ptr::null();
    }
    let b = slice::from_raw_parts(base, blen);
    let r = slice::from_raw_parts(reference, rlen);
    let Some(s) = panic_guard(
        || {
            let bs = std::str::from_utf8(b).ok()?;
            let rs = std::str::from_utf8(r).ok()?;
            Some(crate::http::url_join::recompose(
                &crate::http::url_join::resolve_target(
                    &crate::http::url_join::parse_ref(bs),
                    &crate::http::url_join::parse_ref(rs),
                ),
            ))
        },
        None,
    ) else {
        return std::ptr::null();
    };
    cstring_return(s.len(), |out| {
        out[..s.len()].copy_from_slice(s.as_bytes());
        Some(s.len())
    })
}

/// Resolve a reference against a `UrlBuilder`'s PRECOMPILED base via its opaque
/// inner handle (from the napi `inner_ptr()`). Returns bytes written (0 = null
/// handle / non-UTF-8 reference / panic → real error); a result larger than
/// `out_cap` reports the exact needed size so the caller retries once
/// (growExact).
///
/// # Safety
/// `inner` must be a valid `UrlBuilder` pointer from `inner_ptr()` and must
/// stay alive for the call (the JS wrapper holds the napi instance).
/// `reference` must be valid for reads of `reference_len`; `out` for
/// `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_url_builder_resolve(
    inner: usize,
    reference: *const u8,
    reference_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || reference.is_null() || out.is_null() {
        return 0;
    }
    let r = slice::from_raw_parts(reference, reference_len);
    let Some(bytes) = panic_guard(
        || {
            crate::http::url_join::url_builder_resolve_core(
                inner as *const crate::http::url_join::UrlBuilder,
                r,
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if bytes.len() > out_cap {
        return bytes.len();
    }
    slice::from_raw_parts_mut(out, bytes.len()).copy_from_slice(&bytes);
    bytes.len()
}

/// Extension → MIME type → cstring (unknown → `application/octet-stream`).
/// Never fails (the core's fallback is infallible) — `null` only on a null
/// pointer or a panic (programmer error).
///
/// `ext` is a `bun:ffi` `cstring` ARG — the engine transcodes the JS extension
/// in-engine (JS does zero encode; the callee borrows via `CStr::from_ptr`).
///
/// # Safety
/// `ext` must be a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn castrum_mime_from_extension(
    ext: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if ext.is_null() {
        return std::ptr::null();
    }
    let input = std::ffi::CStr::from_ptr(ext).to_bytes();
    let mime = panic_guard(
        || crate::http::mime_lookup::mime_from_extension_bytes(input),
        b"application/octet-stream".to_vec(),
    );
    cstring_return(mime.len(), |out| {
        out[..mime.len()].copy_from_slice(&mime);
        Some(mime.len())
    })
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
    let Some(frame) = crate::payload::ws_frames::decode_frame(slice::from_raw_parts(data, len))
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
    let result = panic_guard(|| crate::crypto::ed25519::generate_keypair(), None);
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

/// Run the ingress pipeline from raw request components — the `bun:ffi`
/// cstring sibling of `castrum_ingress_handle_packed`.
///
/// `url` / `ip` are NUL-terminated UTF-8 cstrings (`bun:ffi` `cstring` ARGs —
/// the engine transcodes the JS strings to call-scoped buffers in-engine), so
/// the JS side skips the frame assembly + `Buffer.write` UTF-8 encode for the
/// URL/IP. `rid` / `headers` / `body` are `(ptr,len)` byte slices (headers =
/// the packed `[u16 count] {pairs}` block); `out` receives the packed decision.
/// Same wire format + semantics as the packed entry — the shared core is
/// `IngressInner::handle_components`.
///
/// Returns bytes written into `out` (0 = error / too-small buffer).
///
/// # Safety
/// `inner` must be the live `IngressInner` pointer from a live `Ingress`
/// instance; `url`/`ip` must be valid NUL-terminated buffers (the engine
/// guarantees this for `cstring` args); `rid`/`headers`/`body` valid for their
/// declared lengths (null/0 = no body); `out` valid for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_handle_components(
    inner: usize,
    method_kind: u8,
    url: *const std::os::raw::c_char,
    ip: *const std::os::raw::c_char,
    rid: *const u8,
    rid_len: usize,
    headers: *const u8,
    headers_len: usize,
    body: *const u8,
    body_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let inner = inner as *const crate::ingress::IngressInner;
    if inner.is_null()
        || url.is_null()
        || ip.is_null()
        || rid.is_null()
        || headers.is_null()
        || out.is_null()
    {
        return 0;
    }
    if out_cap < crate::ingress::output::OUT_DATA_START {
        return 0;
    }
    let url_bytes = std::ffi::CStr::from_ptr(url).to_bytes();
    let ip_bytes = std::ffi::CStr::from_ptr(ip).to_bytes();
    let rid_slice = slice::from_raw_parts(rid, rid_len);
    let headers_slice = slice::from_raw_parts(headers, headers_len);
    let body_slice: &[u8] = if body.is_null() || body_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(body, body_len)
    };
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    // Aliasing insurance (mirrors the packed entry): if any input aliases the
    // output, copy it first so the shared `&[u8]` and the `&mut [u8]` output
    // borrow never alias (aliased &/&mut is instant UB). The `url`/`ip`
    // cstrings are engine-scoped buffers and can never alias `out`.
    let owned_rid;
    let rid_ref: &[u8] = if crate::util::slices_overlap(rid_slice, out_slice) {
        owned_rid = rid_slice.to_vec();
        &owned_rid
    } else {
        rid_slice
    };
    let owned_headers;
    let headers_ref: &[u8] = if crate::util::slices_overlap(headers_slice, out_slice) {
        owned_headers = headers_slice.to_vec();
        &owned_headers
    } else {
        headers_slice
    };
    let owned_body;
    let body_ref: &[u8] = if crate::util::slices_overlap(body_slice, out_slice) {
        owned_body = body_slice.to_vec();
        &owned_body
    } else {
        body_slice
    };
    let mk = crate::http::method::MethodKind::from_u8(method_kind);
    // A panic must not unwind through the C ABI — catch it and report 0 (the
    // JS wrapper turns it into a 500), matching the packed entry.
    panic_guard(
        || {
            (&*inner)
                .handle_components(
                    mk,
                    url_bytes,
                    ip_bytes,
                    rid_ref,
                    headers_ref,
                    body_ref,
                    out_slice,
                )
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

// ── Per-route native stack (castrum_route_*) ────────────────────
// The live external wire consumed by `@ignex/native` (`createNativeRoute` →
// `route-wire.ts` v3): a route descriptor compiles ONCE into a pre-baked
// `NativeRoute` (rust/ingress/native_route.rs), then each request packs a tiny
// frame and gets a packed verdict in one call. The handle is an owned
// `Box<NativeRoute>` (opaque u64); `route_run` follows the needed-size
// convention (`0` = real error, `> out_cap` = exact required size) so the JS
// wrapper allocates once and retries at most once. All three are `panic_guard`ed
// — a panic must never unwind through the C ABI.

/// Compile a route descriptor into an opaque handle (`0` = failure / null
/// input / panic). The handle is an owned `Box<NativeRoute>`; release it with
/// {@link castrum_route_destroy}.
///
/// # Safety
/// `desc` must be valid for reads of `desc_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_compile(desc: *const u8, desc_len: usize) -> u64 {
    if desc.is_null() {
        return 0;
    }
    let bytes = slice::from_raw_parts(desc, desc_len);
    panic_guard(
        || match crate::ingress::NativeRoute::compile(bytes) {
            Ok(route) => Box::into_raw(Box::new(route)) as u64,
            Err(_) => 0,
        },
        0,
    )
}

/// Run a compiled route on one request frame, writing the packed verdict into
/// `out`. Returns bytes written (`0` = real error / malformed frame / panic;
/// `> out_cap` = the EXACT required size — allocate once and retry).
///
/// # Safety
/// `handle` must be a live handle from {@link castrum_route_compile} (not yet
/// destroyed); `frame` valid for `frame_len` reads; `out` valid for `out_cap`
/// writes. The route is immutable (`&self`, no interior mutability), so
/// concurrent calls from multiple worker threads are safe.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_run(
    handle: u64,
    frame: *const u8,
    frame_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if handle == 0 || frame.is_null() || out.is_null() {
        return 0;
    }
    let route: &crate::ingress::NativeRoute = &*(handle as *const crate::ingress::NativeRoute);
    let frame_slice = slice::from_raw_parts(frame, frame_len);
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    // Aliasing insurance (mirrors castrum_ingress_handle_packed): a pooled
    // frame that overlaps `out` must be copied before the shared &/&mut borrow
    // pair (aliased &/&mut is instant UB). The JS wrapper uses distinct pooled
    // buffers, so this is a rare defensive copy.
    let owned_frame;
    let frame_ref: &[u8] = if crate::util::slices_overlap(frame_slice, out_slice) {
        owned_frame = frame_slice.to_vec();
        &owned_frame
    } else {
        frame_slice
    };
    panic_guard(|| route.run(frame_ref, out_slice).unwrap_or(0), 0)
}

/// Destroy a compiled route handle (frees the `Box<NativeRoute>`). A null
/// handle is a no-op; double-destroy is UB and must not be called.
///
/// # Safety
/// `handle` must come from {@link castrum_route_compile} and be destroyed at
/// most once.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_destroy(handle: u64) {
    if handle != 0 {
        drop(Box::from_raw(handle as *mut crate::ingress::NativeRoute));
    }
}

/// Read the bytes of a `cstring`-returning FFI symbol's result. The engine
/// cloned the string at the call, so the per-thread buffer reuse is safe here.
/// Test-only: the sole production consumer was the removed task-group dispatch
/// (`run_one_task`); remaining callers are in the C-ABI unit tests below.
#[cfg(test)]
unsafe fn cstr_bytes(p: *const std::os::raw::c_char) -> Option<Vec<u8>> {
    if p.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(p).to_bytes().to_vec())
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

    // ── Per-route stack C-ABI (castrum_route_*) ────────────────────

    /// Minimal route descriptor wire (magic + version 3 + parseQuery +
    /// parseCookies stages).
    fn route_desc_parse_both() -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&crate::ingress::native_route::ROUTE_DESC_MAGIC.to_le_bytes());
        d.extend_from_slice(&crate::ingress::native_route::ROUTE_DESC_VERSION.to_le_bytes());
        d.extend_from_slice(&(2 * 1024 * 1024u32).to_le_bytes());
        d.extend_from_slice(&8192u32.to_le_bytes());
        d.extend_from_slice(&8192u32.to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&2u32.to_le_bytes()); // stageCount
        d.push(crate::ingress::native_route::STAGE_PARSE_QUERY);
        d.push(crate::ingress::native_route::STAGE_PARSE_COOKIES);
        d.extend_from_slice(&0u32.to_le_bytes()); // schemaCount
        d
    }

    /// Request frame: `[flags u32][qLen][query][cLen][cookie]`.
    fn route_frame(query: &[u8], cookie: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        f.extend_from_slice(&0u32.to_le_bytes());
        f.extend_from_slice(&(query.len() as u32).to_le_bytes());
        f.extend_from_slice(query);
        f.extend_from_slice(&(cookie.len() as u32).to_le_bytes());
        f.extend_from_slice(cookie);
        f
    }

    #[test]
    fn route_compile_run_destroy_c_abi() {
        let desc = route_desc_parse_both();
        let handle =
            unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
        assert_ne!(handle, 0, "route compile must produce a live handle");

        let f = route_frame(b"a=1&b=hello%20world", b"s=v");
        let mut out = vec![0u8; 256];
        let w = unsafe {
            castrum_route_run(
                handle,
                f.as_ptr(),
                f.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        // 8 header + query section [count 4 + (a=1: 4+1+4+1=10) + (b=hello world:
        // 4+1+4+11=20) = 34] + cookie section [count 4 + (s=v: 4+1+4+1=10) = 14].
        assert_eq!(w, 8 + 34 + 14, "exact result size (query+cookie sections)");

        let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
        assert_ne!(flags & crate::ingress::native_route::ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(
            flags & crate::ingress::native_route::ROUTE_RESULT_FLAG_QUERY_VALID,
            0
        );

        unsafe { castrum_route_destroy(handle) };
    }

    #[test]
    fn route_compile_rejects_bad_magic() {
        let mut desc = route_desc_parse_both();
        desc[0] = 0;
        let handle = unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
        assert_eq!(handle, 0, "bad magic must fail compilation");
    }

    #[test]
    fn route_run_needed_size_convention() {
        let desc = route_desc_parse_both();
        let handle = unsafe { castrum_route_compile(desc.as_ptr(), desc.len()) };
        assert_ne!(handle, 0);
        let f = route_frame(b"a=1&bb=22&ccc=333", b"");
        // A too-small buffer reports the EXACT required size without writing.
        let mut small = [0u8; 8];
        let needed = unsafe {
            castrum_route_run(handle, f.as_ptr(), f.len(), small.as_mut_ptr(), small.len())
        };
        assert!(needed > 8);
        let mut big = vec![0u8; needed];
        let w = unsafe {
            castrum_route_run(handle, f.as_ptr(), f.len(), big.as_mut_ptr(), big.len())
        };
        assert_eq!(w, needed);
        assert_eq!(&small[..], &[0u8; 8], "nothing written to the too-small buffer");
        unsafe { castrum_route_destroy(handle) };
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
        assert_eq!(
            l.err_schema_validation,
            output::ERR_CODE_SCHEMA_VALIDATION as u32
        );
        assert_eq!(l.err_bad_request, output::ERR_CODE_BAD_REQUEST as u32);
        assert_eq!(
            l.err_request_too_large,
            output::ERR_CODE_REQUEST_TOO_LARGE as u32
        );
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
    fn utf8_valid_c_abi() {
        assert_eq!(unsafe { castrum_utf8_valid(b"hello".as_ptr(), 5) }, 1);
        assert_eq!(unsafe { castrum_utf8_valid("héllo 🚀".as_bytes().as_ptr(), "héllo 🚀".len()) }, 1);
        assert_eq!(unsafe { castrum_utf8_valid(b"\xff\xfe".as_ptr(), 2) }, 0);
        // A lone 0xC3 (incomplete 2-byte sequence) is invalid.
        assert_eq!(unsafe { castrum_utf8_valid(b"\xc3".as_ptr(), 1) }, 0);
        // Null pointer / zero-length → 0 / empty is valid.
        assert_eq!(unsafe { castrum_utf8_valid(std::ptr::null(), 0) }, 0);
        assert_eq!(unsafe { castrum_utf8_valid(b"".as_ptr(), 0) }, 1);
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
        let written =
            unsafe { castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(written, 10);
        assert_eq!(&out[..10], b"68656c6c6f");
    }

    #[test]
    fn hex_encode_c_abi_undersized_returns_zero() {
        let input = b"hello";
        let mut out = [0u8; 4];
        let written =
            unsafe { castrum_hex_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(written, 0);
    }

    #[test]
    fn hex_decode_c_abi_roundtrip() {
        let input = b"68656c6c6f";
        let mut out = [0u8; 8];
        let written =
            unsafe { castrum_hex_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(written, 5);
        assert_eq!(&out[..5], b"hello");
    }

    #[test]
    fn hex_decode_c_abi_rejects_invalid() {
        let bad = b"6x";
        let mut out = [0u8; 4];
        let written =
            unsafe { castrum_hex_decode(bad.as_ptr(), bad.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(written, 0);
    }

    #[test]
    fn url_encode_c_abi() {
        let input = b"a b/c";
        let mut out = [0u8; 16];
        let written =
            unsafe { castrum_url_encode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(&out[..written], b"a%20b%2Fc");
    }

    #[test]
    fn url_decode_c_abi() {
        let input = b"a%20b%2Fc";
        let mut out = [0u8; 8];
        let written =
            unsafe { castrum_url_decode(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(&out[..written], b"a b/c");
    }

    #[test]
    fn validators_c_abi() {
        // Values mirror the core `#[cfg(test)]` vectors in rust/util/validation.rs.
        assert_eq!(unsafe { castrum_validate_email(c"a@b.com".as_ptr()) }, 1);
        assert_eq!(unsafe { castrum_validate_email(c"not-an-email".as_ptr()) }, 0);
        assert_eq!(
            unsafe { castrum_validate_uuid(c"550e8400-e29b-41d4-a716-446655440000".as_ptr()) },
            1
        );
        assert_eq!(unsafe { castrum_validate_uuid(c"not-a-uuid".as_ptr()) }, 0);
        assert_eq!(unsafe { castrum_validate_ipv4(c"192.168.0.1".as_ptr()) }, 1);
        assert_eq!(unsafe { castrum_validate_ipv4(c"999.1.1.1".as_ptr()) }, 0);
        assert_eq!(unsafe { castrum_validate_ipv6(c"2001:db8::1".as_ptr()) }, 1);
        assert_eq!(unsafe { castrum_validate_ipv6(c"2001:::1".as_ptr()) }, 0);
    }

    #[test]
    fn json_sum_ids_c_abi_packed_output() {
        let doc = b"[{\"id\":1},{\"id\":2},{\"id\":3}]";
        let mut out = [0u8; 9];
        let w =
            unsafe { castrum_json_sum_ids(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 9);
        assert_eq!(out[0], 1);
        assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 6);

        // A legit zero-sum array is still "ok" (the old scalar i64 conflated
        // this with invalid input).
        let zero = b"[{\"id\":0},{\"id\":0}]";
        let w =
            unsafe { castrum_json_sum_ids(zero.as_ptr(), zero.len(), out.as_mut_ptr(), out.len()) };
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

    /// Test-side decoder for the packed token stream → `serde_json::Value`,
    /// so the C-ABI layout is verified end-to-end without the JS side.
    fn decode_packed(bytes: &[u8]) -> serde_json::Value {
        fn read_u32(p: &mut usize, b: &[u8]) -> u32 {
            let v = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
            *p += 4;
            v
        }
        fn value(p: &mut usize, b: &[u8], strings: &[&str]) -> serde_json::Value {
            let tag = b[*p];
            *p += 1;
            match tag {
                0 => serde_json::Value::Null,
                1 => serde_json::Value::Bool(false),
                2 => serde_json::Value::Bool(true),
                3 => {
                    let f = f64::from_le_bytes(b[*p..*p + 8].try_into().unwrap());
                    *p += 8;
                    serde_json::Value::from(f)
                }
                4 => serde_json::Value::String(strings[read_u32(p, b) as usize].to_string()),
                5 => {
                    // array start … array end (7)
                    let mut arr = Vec::new();
                    while b[*p] != 7 {
                        arr.push(value(p, b, strings));
                    }
                    *p += 1;
                    serde_json::Value::Array(arr)
                }
                6 => {
                    // object start: (9, keyIdx, value)* … object end (8)
                    let mut obj = serde_json::Map::new();
                    while b[*p] != 8 {
                        assert_eq!(b[*p], 9, "expected object key tag");
                        *p += 1;
                        let k = strings[read_u32(p, b) as usize];
                        obj.insert(k.to_string(), value(p, b, strings));
                    }
                    *p += 1;
                    serde_json::Value::Object(obj)
                }
                _ => panic!("bad packed tag {tag}"),
            }
        }
        let mut p = 0usize;
        let str_count = read_u32(&mut p, bytes) as usize;
        let mut strings = Vec::with_capacity(str_count);
        for _ in 0..str_count {
            let n = read_u32(&mut p, bytes) as usize;
            strings.push(std::str::from_utf8(&bytes[p..p + n]).unwrap());
            p += n;
        }
        let tree_len = read_u32(&mut p, bytes) as usize;
        let end = p + tree_len;
        let top = value(&mut p, bytes, &strings);
        assert_eq!(p, end, "tree length must consume exactly the tree");
        assert_eq!(end, bytes.len(), "stream must end at the tree");
        top
    }

    /// Normalize every JSON number to f64 so int/float representations compare
    /// equal — JS numbers are all doubles (`1 === 1.0`), and serde_json's
    /// `Number` deliberately distinguishes them.
    fn json_f64_normalize(v: serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Number(n) => {
                serde_json::Value::from(n.as_f64().unwrap_or(0.0))
            }
            serde_json::Value::Array(a) => serde_json::Value::Array(
                a.into_iter().map(json_f64_normalize).collect(),
            ),
            serde_json::Value::Object(m) => serde_json::Value::Object(
                m.into_iter().map(|(k, v)| (k, json_f64_normalize(v))).collect(),
            ),
            other => other,
        }
    }

    #[test]
    fn json_parse_packed_c_abi() {
        // Valid JSON → packed token stream that round-trips exactly.
        let doc = br#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#;
        let mut out = [0u8; 512];
        let w = unsafe {
            castrum_json_parse_packed(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());
        let parsed = json_f64_normalize(decode_packed(&out[..w]));
        let expected: serde_json::Value =
            serde_json::from_str(r#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#).unwrap();
        assert_eq!(parsed, json_f64_normalize(expected));

        // Too-small output → exact required size, no write past cap.
        let mut tiny = [0u8; 4];
        let w2 = unsafe {
            castrum_json_parse_packed(doc.as_ptr(), doc.len(), tiny.as_mut_ptr(), tiny.len())
        };
        assert!(w2 > 4);

        // Invalid JSON → 0 (real error, JS growExact throws).
        let w3 = unsafe {
            castrum_json_parse_packed(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w3, 0);
        // Null pointers → 0, never UB.
        let w4 = unsafe {
            castrum_json_parse_packed(std::ptr::null(), 0, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w4, 0);
    }

    #[test]
    fn json_parse_packed_dedup_strings() {
        // Repeated keys/values must be interned ONCE into the string table so
        // the JS side decodes each unique string a single time.
        let doc = br#"[{"k":"v","n":"v"},{"k":"w","n":"v"}]"#;
        let mut out = [0u8; 512];
        let w = unsafe {
            castrum_json_parse_packed(doc.as_ptr(), doc.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());
        // keys k,n + values v,w = 4 unique strings (not 10 raw occurrences).
        let str_count = u32::from_le_bytes(out[..4].try_into().unwrap());
        assert_eq!(str_count, 4);
        let parsed = decode_packed(&out[..w]);
        let expected: serde_json::Value =
            serde_json::from_str(r#"[{"k":"v","n":"v"},{"k":"w","n":"v"}]"#).unwrap();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn parse_media_type_c_abi_packed() {
        let ct = b"application/json; charset=utf-8; foo=bar";
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_parse_media_type(ct.as_ptr(), ct.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());

        let mut off = 0usize;
        let mt_len = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
        off += 4;
        assert_eq!(
            String::from_utf8(out[off..off + mt_len].to_vec()).unwrap(),
            "application/json"
        );
        off += mt_len;

        // charset present.
        let cs_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
        assert_ne!(cs_len, u32::MAX as usize);
        off += 4;
        assert_eq!(
            String::from_utf8(out[off..off + cs_len].to_vec()).unwrap(),
            "utf-8"
        );
        off += cs_len;

        // boundary absent → u32::MAX.
        let b_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap());
        assert_eq!(b_len, u32::MAX);
        off += 4;

        // params = charset + foo (2).
        let count = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
        assert_eq!(count, 2);
        off += 4;
        for _ in 0..count {
            let klen = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
            off += 4;
            off += klen;
            let vlen = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
            off += 4;
            off += vlen;
        }
        assert_eq!(off, w);

        // Invalid media type → 0 (real error → JS throws).
        let w = unsafe {
            castrum_parse_media_type(b"not-a-type".as_ptr(), 10, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);

        // Too-small output → exact required size.
        let small_cap = 1usize;
        let w = unsafe {
            castrum_parse_media_type(ct.as_ptr(), ct.len(), out.as_mut_ptr(), small_cap)
        };
        assert!(w > small_cap);
    }

    #[test]
    fn parse_http_date_c_abi_packed() {
        let date = b"Sun, 06 Nov 1994 08:49:37 GMT";
        let mut out = [0u8; 9];
        let w = unsafe { castrum_parse_http_date(date.as_ptr(), date.len(), out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 9);
        assert_eq!(out[0], 1);
        assert_eq!(i64::from_le_bytes(out[1..9].try_into().unwrap()), 784_111_777);

        // Malformed → ok=0, 1 byte.
        let w = unsafe { castrum_parse_http_date(b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 1);
        assert_eq!(out[0], 0);

        // Too-small output → exact required size (9 / 1).
        let w = unsafe { castrum_parse_http_date(date.as_ptr(), date.len(), out.as_mut_ptr(), 0) };
        assert_eq!(w, 9);
    }

    #[test]
    fn parse_accept_encoding_c_abi_packed() {
        let header = b"gzip, deflate;q=0.5, identity;q=0.2";
        let mut out = [0u8; 256];
        let w = unsafe {
            castrum_parse_accept_encoding(header.as_ptr(), header.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());

        let count = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
        assert_eq!(count, 3);
        let mut off = 4usize;
        let enc_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        assert_eq!(
            String::from_utf8(out[off..off + enc_len].to_vec()).unwrap(),
            "gzip"
        );
        off += enc_len;
        let q = f32::from_le_bytes(out[off..off + 4].try_into().unwrap());
        assert_eq!(q, 1.0);
        off += 4;
        let order = u32::from_le_bytes(out[off..off + 4].try_into().unwrap());
        assert_eq!(order, 0);

        // Empty header → count 0 (4 bytes), never an error.
        let w = unsafe {
            castrum_parse_accept_encoding(b"".as_ptr(), 0, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 4);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0);
    }

    #[test]
    fn url_encode_query_c_abi() {
        // Packed [u32 count]{[u32 keyLen][key][u32 valLen][val]} — unsorted.
        let mut packed: Vec<u8> = Vec::new();
        packed.extend_from_slice(&2u32.to_le_bytes());
        for (k, v) in [("b", "2"), ("a", "1")] {
            packed.extend_from_slice(&(k.len() as u32).to_le_bytes());
            packed.extend_from_slice(k.as_bytes());
            packed.extend_from_slice(&(v.len() as u32).to_le_bytes());
            packed.extend_from_slice(v.as_bytes());
        }
        let s = unsafe { castrum_url_encode_query(packed.as_ptr(), packed.len()) };
        assert!(!s.is_null());
        assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"a=1&b=2");

        // Malformed packed input (truncated) → null.
        let malformed = [1u8, 0, 0, 0];
        let s = unsafe { castrum_url_encode_query(malformed.as_ptr(), malformed.len()) };
        assert!(s.is_null());
    }

    #[test]
    fn url_resolve_c_abi() {
        // RFC 3986 §5.4.1: base "http://a/b/c/d;p?q" + "g" → "http://a/b/c/g".
        let base = b"http://a/b/c/d;p?q";
        let s = unsafe { castrum_url_resolve(base.as_ptr(), base.len(), b"g".as_ptr(), 1) };
        assert!(!s.is_null());
        assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"http://a/b/c/g");

        // Non-UTF-8 → null (napi parity: throws).
        let bad = [0xffu8, 0xfe, 0xfd];
        let s = unsafe { castrum_url_resolve(base.as_ptr(), base.len(), bad.as_ptr(), bad.len()) };
        assert!(s.is_null());
    }

    #[test]
    fn url_builder_resolve_c_abi() {
        use napi::bindgen_prelude::Uint8Array;
        let b = crate::http::url_join::UrlBuilder::new(Uint8Array::new(
            b"http://a/b/c/d;p?q".to_vec(),
        ))
        .unwrap();
        let inner = b.inner_ptr() as usize;
        let mut out = [0u8; 256];
        // Precompiled base + "g" → "http://a/b/c/g" (RFC 3986 §5.4.1).
        let w = unsafe {
            castrum_url_builder_resolve(inner, b"g".as_ptr(), 1, out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());
        assert_eq!(&out[..w], b"http://a/b/c/g");
        // Null handle → 0 (never dereferences freed state).
        let w = unsafe {
            castrum_url_builder_resolve(0, b"g".as_ptr(), 1, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
        // Non-UTF-8 reference → 0 (napi parity: throws).
        let bad = [0xffu8, 0xfe];
        let w = unsafe {
            castrum_url_builder_resolve(inner, bad.as_ptr(), bad.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
        // Too-small buffer → exact needed size.
        let w = unsafe {
            castrum_url_builder_resolve(inner, b"g".as_ptr(), 1, out.as_mut_ptr(), 1)
        };
        assert!(w > 1);
    }

    #[test]
    fn media_type_matcher_matches_c_abi() {
        use napi::bindgen_prelude::Uint8Array;
        let m = crate::http::media_type::MediaTypeMatcher::new(Uint8Array::new(
            b"application/*".to_vec(),
        ))
        .unwrap();
        let inner = m.inner_ptr() as usize;
        let f = |a: &[u8]| unsafe { castrum_media_type_matcher_matches(inner, a.as_ptr(), a.len()) };
        assert_eq!(f(b"application/json"), 1);
        assert_eq!(f(b"Application/JSON"), 1); // case-insensitive
        assert_eq!(f(b"text/html"), 0);
        assert_eq!(
            unsafe { castrum_media_type_matcher_matches(0, b"a".as_ptr(), 1) },
            0
        ); // null handle
    }

    #[test]
    fn accept_negotiator_negotiate_c_abi() {
        let n = crate::http::accept::AcceptNegotiator::new(vec!["gzip".to_string()]);
        let inner = n.inner_ptr() as usize;
        let f = |h: &std::ffi::CStr| -> Option<Vec<u8>> {
            let s = unsafe { castrum_accept_negotiator_negotiate(inner, h.as_ptr()) };
            if s.is_null() {
                None
            } else {
                unsafe { cstr_bytes(s) }
            }
        };
        assert_eq!(f(c"gzip, deflate;q=0.5"), Some(b"gzip".to_vec()));
        assert_eq!(f(c"identity;q=0.9"), None); // no supported match → identity
        assert!(unsafe { castrum_accept_negotiator_negotiate(0, c"gzip".as_ptr()) }.is_null());
    }

    #[test]
    fn accept_negotiator_negotiate_server_c_abi() {
        use crate::http::accept::AcceptNegotiator;
        let n = AcceptNegotiator::new(vec!["br".to_string(), "gzip".to_string()]);
        let inner = n.inner_ptr() as usize;
        let f = |h: &std::ffi::CStr| -> Option<Vec<u8>> {
            let s = unsafe { castrum_accept_negotiator_negotiate_server(inner, h.as_ptr()) };
            if s.is_null() {
                None
            } else {
                unsafe { cstr_bytes(s) }
            }
        };
        // Server-preference: tie → first supported (br), NOT client order.
        assert_eq!(f(c"gzip, br"), Some(b"br".to_vec()));
        assert_eq!(f(c"br;q=0.8, gzip;q=0.9"), Some(b"gzip".to_vec()));
        assert_eq!(f(c"*"), Some(b"br".to_vec()));
        assert_eq!(f(c"gzip;q=0"), None); // q=0 excluded, no wildcard
        assert_eq!(f(c""), None); // empty → identity (server-pref differs from client-order)
        assert!(
            unsafe { castrum_accept_negotiator_negotiate_server(0, c"gzip".as_ptr()) }.is_null()
        );
    }

    #[test]
    fn jwt_signer_sign_verify_c_abi() {
        use napi::bindgen_prelude::Uint8Array;
        let s = crate::crypto::jwt::JwtSigner::new(Uint8Array::new(b"my-secret".to_vec()), Some(0));
        let inner = s.inner_ptr() as usize;
        let claims = b"{\"sub\":\"user-1\"}";
        let mut out = [0u8; 512];
        let mut vout = [0u8; 512];
        let w = unsafe {
            castrum_jwt_signer_sign(inner, claims.as_ptr(), claims.len(), 0, out.as_mut_ptr(), out.len())
        };
        assert!(w > 0 && w <= out.len());
        let token = &out[..w];
        assert_eq!(token.iter().filter(|&&b| b == b'.').count(), 2);
        // Verify round-trip → claims JSON.
        let vw = unsafe {
            castrum_jwt_signer_verify(inner, token.as_ptr(), token.len(), 0, vout.as_mut_ptr(), vout.len())
        };
        assert!(vw > 0);
        assert!(String::from_utf8(vout[..vw].to_vec()).unwrap().contains("\"sub\":\"user-1\""));
        // Tampered → 0 (invalid).
        let mut bad = token.to_vec();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        let bw = unsafe {
            castrum_jwt_signer_verify(inner, bad.as_ptr(), bad.len(), 0, vout.as_mut_ptr(), vout.len())
        };
        assert_eq!(bw, 0);
        // Invalid claims JSON → 0; null handle → 0.
        let w = unsafe {
            castrum_jwt_signer_sign(inner, b"nope".as_ptr(), 4, 0, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
        let w = unsafe {
            castrum_jwt_signer_sign(0, claims.as_ptr(), claims.len(), 0, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
    }

    #[test]
    fn template_render_c_abi() {
        let t = crate::payload::template::TemplateRenderer::new("Hello {{ name }}!".to_string())
            .unwrap();
        let inner = t.inner_ptr() as usize;
        let ctx = b"{\"name\":\"world\"}";
        let mut out = [0u8; 128];
        let w = unsafe {
            castrum_template_render(inner, ctx.as_ptr(), ctx.len(), out.as_mut_ptr(), out.len())
        };
        assert!(w > 0);
        assert_eq!(&out[..w], b"Hello world!");
        // Invalid context JSON → 0; null handle → 0.
        let w = unsafe {
            castrum_template_render(inner, b"nope".as_ptr(), 4, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
        let w = unsafe {
            castrum_template_render(0, ctx.as_ptr(), ctx.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 0);
    }

    #[test]
    fn schema_validator_validate_c_abi() {
        use napi::bindgen_prelude::Uint8Array;
        let schema = b"{\"type\":\"object\",\"required\":[\"a\"],\"properties\":{\"a\":{\"type\":\"number\"}}}";
        let v = crate::json::json_schema::SchemaValidator::new(Uint8Array::new(schema.to_vec()))
            .unwrap();
        let inner = v.inner_ptr() as usize;
        let f = |d: &[u8]| unsafe { castrum_schema_validator_validate(inner, d.as_ptr(), d.len()) };
        assert_eq!(f(b"{\"a\":1}"), 1);
        assert_eq!(f(b"{}"), 0); // missing required "a"
        assert_eq!(f(b"not-json"), 0);
        assert_eq!(
            unsafe { castrum_schema_validator_validate(0, b"{}".as_ptr(), 2) },
            0
        );
    }

    #[test]
    fn rate_limiter_check_c_abi() {
        let r = crate::ingress::rate_limit::RateLimiter::new(2, 60_000, Some(1024));
        let inner = r.inner_ptr() as usize;
        let now = 1_700_000_000_000i64;
        let key = c"user-42";
        let mut out = [0u8; 13];
        let w = unsafe {
            castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 13);
        assert_eq!(out[0], 1); // allowed (1/2)
        unsafe { castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len()) };
        let w = unsafe {
            castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 13);
        assert_eq!(out[0], 0); // blocked (3/2)
        // Pre-hashed check_key shares the SAME budget.
        let hashed = crate::crypto::hashing::fast_hash_bytes(key.to_bytes());
        let w = unsafe {
            castrum_rate_limiter_check_key(inner, hashed as i64, now, out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 13);
        assert_eq!(out[0], 0);
        // Null handle → 0; too-small → exact needed size.
        let w = unsafe { castrum_rate_limiter_check(0, key.as_ptr(), now, out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 0);
        let w = unsafe { castrum_rate_limiter_check(inner, key.as_ptr(), now, out.as_mut_ptr(), 1) };
        assert_eq!(w, 13);
    }

    #[test]
    fn mime_from_extension_c_abi() {
        let s = unsafe { castrum_mime_from_extension(c".js".as_ptr()) };
        assert!(!s.is_null());
        assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"text/javascript");

        // Unknown extension → application/octet-stream (never null).
        let s = unsafe { castrum_mime_from_extension(c"nope".as_ptr()) };
        assert!(!s.is_null());
        assert_eq!(unsafe { cstr_bytes(s) }.unwrap(), b"application/octet-stream");
    }

    #[test]
    fn conditional_is_not_modified_c_abi() {
        use napi::bindgen_prelude::Uint8Array;
        let c = crate::http::etag::ConditionalRequest::new(
            Uint8Array::new(b"\"abc123\"".to_vec()),
            Some(784_111_777f64),
        );
        let inner = c.inner_ptr() as usize;
        let f = |flags: u8, inm: Option<&std::ffi::CStr>, ims: Option<&std::ffi::CStr>| -> u8 {
            let ip = inm.map_or(std::ptr::null(), |c| c.as_ptr());
            let sp = ims.map_or(std::ptr::null(), |c| c.as_ptr());
            unsafe { castrum_conditional_is_not_modified(inner, ip, sp, flags) }
        };
        // If-None-Match "*" → 304.
        assert_eq!(f(1, Some(c"*"), None), 1);
        // Exact etag → 304; weak compare W/"abc123" → 304.
        assert_eq!(f(1, Some(c"\"abc123\""), None), 1);
        assert_eq!(f(1, Some(c"W/\"abc123\""), None), 1);
        // Non-matching list → not 304.
        assert_eq!(f(1, Some(c"\"xyz\", \"other\""), None), 0);
        // If-Modified-Since == lastModified → 304; 1s before → not 304.
        assert_eq!(f(2, None, Some(c"Sun, 06 Nov 1994 08:49:37 GMT")), 1);
        assert_eq!(f(2, None, Some(c"Sun, 06 Nov 1994 08:49:36 GMT")), 0);
        // Absent flags → not 304 (nothing to match).
        assert_eq!(f(0, None, None), 0);
        // Null handle → 0 (never dereferences freed state).
        assert_eq!(
            unsafe {
                castrum_conditional_is_not_modified(0, std::ptr::null(), std::ptr::null(), 0)
            },
            0
        );
    }

    #[test]
    fn ws_accept_key_c_abi_rfc6455() {
        // RFC 6455 Sec-WebSocket-Accept test vector.
        let key = c"dGhlIHNhbXBsZSBub25jZQ==";
        let accept = unsafe { castrum_ws_accept_key(key.as_ptr()) };
        assert!(!accept.is_null());
        let bytes = unsafe { cstr_bytes(accept) }.unwrap();
        assert_eq!(bytes, b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn etag_c_abi() {
        let data = b"hello";
        let strong = unsafe { castrum_etag(data.as_ptr(), data.len(), 0) };
        assert!(!strong.is_null());
        let strong_bytes = unsafe { cstr_bytes(strong) }.unwrap();
        let crc = crc32fast::hash(b"hello");
        let expected = format!("\"{crc:08x}\"");
        assert_eq!(strong_bytes, expected.as_bytes());

        let weak = unsafe { castrum_etag(data.as_ptr(), data.len(), 1) };
        assert!(!weak.is_null());
        let weak_bytes = unsafe { cstr_bytes(weak) }.unwrap();
        assert_eq!(&weak_bytes[..2], b"W/");
    }

    #[test]
    fn random_token_c_abi() {
        let t = unsafe { castrum_random_token(16) };
        assert!(!t.is_null());
        let bytes = unsafe { cstr_bytes(t) }.unwrap();
        assert_eq!(bytes.len(), 32);
        assert!(bytes.iter().all(u8::is_ascii_hexdigit));
        // byte_len 0 → valid empty string, not null.
        assert!(!unsafe { castrum_random_token(0) }.is_null());
        // Huge len → null (real error).
        assert!(unsafe { castrum_random_token(u32::MAX) }.is_null());
    }

    #[test]
    fn random_token_into_c_abi() {
        let mut out = [0u8; 64];
        let w = unsafe { castrum_random_token_into(16, out.as_mut_ptr(), out.len()) };
        assert_eq!(w, 32);
        assert!(out[..32].iter().all(u8::is_ascii_hexdigit));
        // Too-small buffer → exact needed size (not a partial write).
        let mut small = [0u8; 16];
        let w2 = unsafe { castrum_random_token_into(16, small.as_mut_ptr(), small.len()) };
        assert_eq!(w2, 32);
        assert_eq!(&small[..], &[0u8; 16]);
        // byte_len 0 → writes 0 bytes.
        let mut zero = [0u8; 4];
        let w3 = unsafe { castrum_random_token_into(0, zero.as_mut_ptr(), zero.len()) };
        assert_eq!(w3, 0);
        // Huge len → 0 (real error); null out → 0.
        assert_eq!(unsafe { castrum_random_token_into(u32::MAX, out.as_mut_ptr(), out.len()) }, 0);
        assert_eq!(unsafe { castrum_random_token_into(16, std::ptr::null_mut(), 0) }, 0);
    }

    #[test]
    fn cstring_into_variants_match_cstring() {
        // ws_accept_key: into == cstring bytes. The `_into` sibling keeps the
        // `(ptr,len)` byte form; the cstring variant takes a NUL-terminated arg.
        let key = b"dGhlIHNhbXBsZSBub25jZQ==";
        let key_c = c"dGhlIHNhbXBsZSBub25jZQ==";
        let mut out = [0u8; 28];
        let w = unsafe {
            castrum_ws_accept_key_into(key.as_ptr(), key.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(w, 28);
        let cstr_result =
            unsafe { cstr_bytes(castrum_ws_accept_key(key_c.as_ptr())) }.unwrap();
        assert_eq!(&out[..], &cstr_result[..]);
        // Too-small → 28.
        let mut small = [0u8; 8];
        assert_eq!(
            unsafe { castrum_ws_accept_key_into(key.as_ptr(), key.len(), small.as_mut_ptr(), small.len()) },
            28
        );

        // etag strong/weak.
        let data = b"hello";
        for weak in [0u8, 1u8] {
            let mut eout = [0u8; 16];
            let ew = unsafe {
                castrum_etag_into(data.as_ptr(), data.len(), weak, eout.as_mut_ptr(), eout.len())
            };
            let expect = if weak != 0 { 12 } else { 10 };
            assert_eq!(ew, expect);
            let ecstr_result = unsafe { cstr_bytes(castrum_etag(data.as_ptr(), data.len(), weak)) }.unwrap();
            assert_eq!(&eout[..ew], &ecstr_result[..]);
        }

        // sign/verify cookie round-trip via into.
        let value = b"session=abc123";
        let secret = b"secret-key";
        let mut sout = [0u8; 256];
        let sw = unsafe {
            castrum_sign_cookie_into(
                value.as_ptr(), value.len(), secret.as_ptr(), secret.len(),
                sout.as_mut_ptr(), sout.len(),
            )
        };
        assert_eq!(sw, value.len() + 65);
        let signed = &sout[..sw];
        // Cross-check against the cstring path.
        let scstr_result = unsafe {
            cstr_bytes(castrum_sign_cookie(value.as_ptr(), value.len(), secret.as_ptr(), secret.len()))
        }.unwrap();
        assert_eq!(signed, &scstr_result[..]);
        // Verify via into.
        let mut vout = [0u8; 256];
        let vw = unsafe {
            castrum_verify_cookie_into(
                signed.as_ptr(), signed.len(), secret.as_ptr(), secret.len(),
                vout.as_mut_ptr(), vout.len(),
            )
        };
        assert_eq!(vw, value.len());
        assert_eq!(&vout[..vw], value);
        // Tampered → 0.
        let mut tampered = signed.to_vec();
        tampered[0] ^= 1;
        let vw0 = unsafe {
            castrum_verify_cookie_into(
                tampered.as_ptr(), tampered.len(), secret.as_ptr(), secret.len(),
                vout.as_mut_ptr(), vout.len(),
            )
        };
        assert_eq!(vw0, 0);

        // csrf_token into: 129 bytes, hex.hex.
        let mut cout = [0u8; 129];
        let cw = unsafe {
            castrum_csrf_token_into(secret.as_ptr(), secret.len(), cout.as_mut_ptr(), cout.len())
        };
        assert_eq!(cw, 129);
        assert_eq!(cout[64], b'.');
        assert!(cout[..64].iter().all(u8::is_ascii_hexdigit));
        assert!(cout[65..].iter().all(u8::is_ascii_hexdigit));
        // Too-small → 129.
        let mut csmall = [0u8; 8];
        assert_eq!(
            unsafe { castrum_csrf_token_into(secret.as_ptr(), secret.len(), csmall.as_mut_ptr(), csmall.len()) },
            129
        );

        // jwt_sign_bytes into == cstring.
        let claims = b"{\"sub\":\"user-1\"}";
        let mut jout = [0u8; 512];
        let jw = unsafe {
            castrum_jwt_sign_bytes_into(
                claims.as_ptr(), claims.len(), secret.as_ptr(), secret.len(),
                0, 0, jout.as_mut_ptr(), jout.len(),
            )
        };
        assert!(jw > 0);
        let jcstr = unsafe {
            cstr_bytes(castrum_jwt_sign_bytes(claims.as_ptr(), claims.len(), secret.as_ptr(), secret.len(), 0, 0))
        }.unwrap();
        assert_eq!(&jout[..jw], &jcstr[..]);
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
        let d =
            unsafe { castrum_base64_decode(enc.as_ptr(), w, dec.as_mut_ptr(), dec.len(), 0, 1) };
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
            castrum_hmac_sha256(
                key.as_ptr(),
                key.len(),
                data.as_ptr(),
                data.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(w, 64);
        assert_eq!(
            &out[..],
            b"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        let ok = unsafe {
            castrum_hmac_sha256_verify(
                key.as_ptr(),
                key.len(),
                data.as_ptr(),
                data.len(),
                out.as_ptr(),
                out.len(),
            )
        };
        assert_eq!(ok, 1);
        out[0] ^= 1;
        let bad = unsafe {
            castrum_hmac_sha256_verify(
                key.as_ptr(),
                key.len(),
                data.as_ptr(),
                data.len(),
                out.as_ptr(),
                out.len(),
            )
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn sign_verify_cookie_c_abi() {
        let value = b"session=abc";
        let secret = b"secret-key";
        let signed = unsafe {
            castrum_sign_cookie(value.as_ptr(), value.len(), secret.as_ptr(), secret.len())
        };
        assert!(!signed.is_null());
        let signed_bytes = unsafe { cstr_bytes(signed) }.unwrap();
        assert!(signed_bytes.len() > value.len());

        let verified = unsafe {
            castrum_verify_cookie(
                signed_bytes.as_ptr(),
                signed_bytes.len(),
                secret.as_ptr(),
                secret.len(),
            )
        };
        assert!(!verified.is_null());
        let out = unsafe { cstr_bytes(verified) }.unwrap();
        assert_eq!(out, value);

        // Tampered signature → null.
        let mut tampered = signed_bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        let bad = unsafe {
            castrum_verify_cookie(
                tampered.as_ptr(),
                tampered.len(),
                secret.as_ptr(),
                secret.len(),
            )
        };
        assert!(bad.is_null());
    }

    #[test]
    fn csrf_c_abi() {
        let secret = b"csrf-secret";
        let token = unsafe { castrum_csrf_token(secret.as_ptr(), secret.len()) };
        assert!(!token.is_null());
        let token_bytes = unsafe { cstr_bytes(token) }.unwrap();
        assert_eq!(token_bytes.len(), 129);
        assert_eq!(token_bytes[64], b'.');
        let ok = unsafe {
            castrum_csrf_verify(
                token_bytes.as_ptr(),
                token_bytes.len(),
                secret.as_ptr(),
                secret.len(),
            )
        };
        assert_eq!(ok, 1);
        // Wrong secret → 0.
        let bad = unsafe {
            castrum_csrf_verify(
                token_bytes.as_ptr(),
                token_bytes.len(),
                b"other".as_ptr(),
                5,
            )
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn password_hash_verify_c_abi() {
        let pw = b"hunter2";
        let salt = b"saltsalt";
        let mut phc = [0u8; 512];
        let w = unsafe {
            castrum_password_hash(
                pw.as_ptr(),
                pw.len(),
                salt.as_ptr(),
                salt.len(),
                19_456,
                2,
                1,
                32,
                phc.as_mut_ptr(),
                phc.len(),
            )
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
        let w = unsafe {
            castrum_password_hash_bcrypt(pw.as_ptr(), pw.len(), 4, phc.as_mut_ptr(), phc.len())
        };
        assert!(w > 0);
        assert_eq!(&phc[..4], b"$2b$");
        // The hash crosses as a NUL-terminated C string (like the engine's
        // `cstring` arg transcode) — CString::new makes that explicit.
        let phc_c = std::ffi::CString::new(&phc[..w]).unwrap();
        let ok = unsafe { castrum_password_verify_bcrypt(pw.as_ptr(), pw.len(), phc_c.as_ptr()) };
        assert_eq!(ok, 1);
    }

    #[test]
    fn pbkdf2_c_abi_matches_napi() {
        let pw = b"password";
        let salt = b"salt";
        let mut out = [0u8; 32];
        let w = unsafe {
            castrum_pbkdf2_sha256(
                pw.as_ptr(),
                pw.len(),
                salt.as_ptr(),
                salt.len(),
                1,
                32,
                out.as_mut_ptr(),
                out.len(),
            )
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
                castrum_pbkdf2_sha256(
                    pw.as_ptr(),
                    pw.len(),
                    salt.as_ptr(),
                    salt.len(),
                    1,
                    32,
                    tiny.as_mut_ptr(),
                    tiny.len(),
                )
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
            castrum_aead_encrypt(
                key.as_ptr(),
                key.len(),
                nonce.as_ptr(),
                nonce.len(),
                plaintext.as_ptr(),
                plaintext.len(),
                0,
                ct.as_mut_ptr(),
                ct.len(),
            )
        };
        assert_eq!(w, plaintext.len() + 16);
        let mut pt = [0u8; 128];
        let d = unsafe {
            castrum_aead_decrypt(
                key.as_ptr(),
                key.len(),
                nonce.as_ptr(),
                nonce.len(),
                ct.as_ptr(),
                w,
                0,
                pt.as_mut_ptr(),
                pt.len(),
            )
        };
        assert_eq!(&pt[..d], plaintext);
        // Tampered ciphertext → auth failure → 0.
        ct[0] ^= 1;
        let bad = unsafe {
            castrum_aead_decrypt(
                key.as_ptr(),
                key.len(),
                nonce.as_ptr(),
                nonce.len(),
                ct.as_ptr(),
                w,
                0,
                pt.as_mut_ptr(),
                pt.len(),
            )
        };
        assert_eq!(bad, 0);
    }

    #[test]
    fn ws_frame_encode_c_abi() {
        let payload = b"hello";
        let mut out = [0u8; 32];
        let w = unsafe {
            castrum_ws_frame_encode(
                1,
                payload.as_ptr(),
                payload.len(),
                1,
                1,
                out.as_mut_ptr(),
                out.len(),
            )
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
            castrum_json_patch(
                doc.as_ptr(),
                doc.len(),
                patch.as_ptr(),
                patch.len(),
                out.as_mut_ptr(),
                out.len(),
            )
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
            castrum_gzip_decompress(
                comp.as_ptr(),
                cw,
                1024 * 1024,
                decomp.as_mut_ptr(),
                decomp.len(),
            )
        };
        assert_eq!(&decomp[..dw], data);

        let mut bcomp = [0u8; 2048];
        let bw = unsafe {
            castrum_brotli_compress(
                data.as_ptr(),
                data.len(),
                5,
                bcomp.as_mut_ptr(),
                bcomp.len(),
            )
        };
        assert!(bw > 0);
        let mut bdecomp = [0u8; 1024];
        let bdw = unsafe {
            castrum_brotli_decompress(
                bcomp.as_ptr(),
                bw,
                1024 * 1024,
                bdecomp.as_mut_ptr(),
                bdecomp.len(),
            )
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
        assert_eq!(
            unsafe { castrum_gzip_isize(b"hello world, this is not gzip at all".as_ptr(), 40) },
            0
        );
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
            castrum_gzip_compress(
                data.as_ptr(),
                data.len(),
                6,
                exact.as_mut_ptr(),
                exact.len(),
            )
        };
        assert_eq!(w, needed);
        // Invalid input → 0 (a REAL error, not "too small").
        let mut out = [0u8; 256];
        let err = unsafe {
            castrum_gzip_decompress(
                b"not-a-gzip-stream".as_ptr(),
                17,
                1024 * 1024,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(err, 0);

        // jsonPatch: too-small returns the exact needed size.
        let doc = br#"{"a":1,"b":2,"c":3}"#;
        let patch = br#"[{"op":"add","path":"/d","value":4}]"#;
        let mut ptiny = [0u8; 4];
        let pneed = unsafe {
            castrum_json_patch(
                doc.as_ptr(),
                doc.len(),
                patch.as_ptr(),
                patch.len(),
                ptiny.as_mut_ptr(),
                ptiny.len(),
            )
        };
        assert!(pneed > ptiny.len());
        let mut pexact = vec![0u8; pneed];
        let pw = unsafe {
            castrum_json_patch(
                doc.as_ptr(),
                doc.len(),
                patch.as_ptr(),
                patch.len(),
                pexact.as_mut_ptr(),
                pexact.len(),
            )
        };
        assert_eq!(pw, pneed);

        // jwtSignBytes: cstring return — the engine clones the token string.
        let claims = br#"{"sub":"user-1"}"#;
        let secret = b"my-secret";
        let jp = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                60,
                1_700_000_000,
            )
        };
        assert!(!jp.is_null());
        let jtoken = unsafe { cstr_bytes(jp) }.unwrap();
        assert!(!jtoken.is_empty());
        assert_eq!(jtoken.iter().filter(|&&b| b == b'.').count(), 2);

        // passwordHash (argon2) too-small returns the exact PHC length.
        let pw = b"hunter2";
        let salt = b"saltsalt";
        let mut tiny = [0u8; 8];
        let hneed = unsafe {
            castrum_password_hash(
                pw.as_ptr(),
                pw.len(),
                salt.as_ptr(),
                salt.len(),
                19_456,
                2,
                1,
                32,
                tiny.as_mut_ptr(),
                tiny.len(),
            )
        };
        assert!(hneed > tiny.len());
        let mut hexact = vec![0u8; hneed];
        let hw = unsafe {
            castrum_password_hash(
                pw.as_ptr(),
                pw.len(),
                salt.as_ptr(),
                salt.len(),
                19_456,
                2,
                1,
                32,
                hexact.as_mut_ptr(),
                hexact.len(),
            )
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
            castrum_cookie_parse_packed(
                cookie.as_ptr(),
                cookie.len(),
                cout.as_mut_ptr(),
                cout.len(),
            )
        };
        assert!(cw > 0);
    }

    #[test]
    fn packed_parsers_needed_size_c_abi() {
        // The packed pair writers + JSON-text writers report the EXACT needed
        // size on a too-small buffer (growExact), and 0 stays a real error
        // (malformed %XX). This removes the JS 9×/8× pre-size AND the re-run
        // loop — a miss allocates once and retries.
        let too_small = [0u8; 8];

        // query → packed pairs (strict writer; malformed %XX is a real error).
        let q = b"a=1&b=hello%20world&c=2";
        let qneed = unsafe {
            castrum_query_parse_packed(
                q.as_ptr(),
                q.len(),
                too_small.as_ptr() as *mut u8,
                too_small.len(),
            )
        };
        assert!(qneed > too_small.len());
        let mut qexact = vec![0u8; qneed];
        let qw = unsafe {
            castrum_query_parse_packed(q.as_ptr(), q.len(), qexact.as_mut_ptr(), qexact.len())
        };
        assert_eq!(qw, qneed);

        // cookie → packed pairs.
        let c = b"sid=abc123; theme=dark";
        let cneed = unsafe {
            castrum_cookie_parse_packed(
                c.as_ptr(),
                c.len(),
                too_small.as_ptr() as *mut u8,
                too_small.len(),
            )
        };
        assert!(cneed > too_small.len());
        let mut cexact = vec![0u8; cneed];
        let cw = unsafe {
            castrum_cookie_parse_packed(c.as_ptr(), c.len(), cexact.as_mut_ptr(), cexact.len())
        };
        assert_eq!(cw, cneed);
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
        let signed = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                60,
                1_700_000_000,
            )
        };
        assert!(!signed.is_null());
        let token = unsafe { cstr_bytes(signed) }.unwrap();
        // Compact JWT: header.payload.sig → exactly two dots.
        assert_eq!(token.iter().filter(|&&b| b == b'.').count(), 2);
        assert!(crate::crypto::jwt::verify_signature_with_key(
            &token,
            &hmac_key(secret)
        ));

        // ttl <= 0 → no iat/exp injection (still signs).
        let s0 = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                0,
                1_700_000_000,
            )
        };
        assert!(!s0.is_null());
        // Invalid claims JSON → null.
        let bad = unsafe {
            castrum_jwt_sign_bytes(
                b"not-json".as_ptr(),
                8,
                secret.as_ptr(),
                secret.len(),
                60,
                1,
            )
        };
        assert!(bad.is_null());
    }

    #[test]
    fn jwt_verify_c_abi() {
        let claims = br#"{"sub":"user-1"}"#;
        let secret = b"my-secret";
        let signed = unsafe {
            castrum_jwt_sign_bytes(
                claims.as_ptr(),
                claims.len(),
                secret.as_ptr(),
                secret.len(),
                60,
                1_700_000_000,
            )
        };
        assert!(!signed.is_null());
        let token = unsafe { cstr_bytes(signed) }.unwrap();

        // Valid within TTL → claims JSON.
        let verified = unsafe {
            castrum_jwt_verify(
                token.as_ptr(),
                token.len(),
                secret.as_ptr(),
                secret.len(),
                1_700_000_030,
            )
        };
        assert!(!verified.is_null());
        let claims_json = unsafe { cstr_bytes(verified) }.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&claims_json).unwrap();
        assert_eq!(parsed["sub"], "user-1");

        // Expired (now beyond exp) → null.
        let expired = unsafe {
            castrum_jwt_verify(
                token.as_ptr(),
                token.len(),
                secret.as_ptr(),
                secret.len(),
                1_700_000_100,
            )
        };
        assert!(expired.is_null());

        // Wrong secret → null.
        let wrong = unsafe {
            castrum_jwt_verify(
                token.as_ptr(),
                token.len(),
                b"other".as_ptr(),
                5,
                1_700_000_030,
            )
        };
        assert!(wrong.is_null());
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
        for section in [
            b"/api/users".as_slice(),
            b"127.0.0.1".as_slice(),
            b"rid-1".as_slice(),
        ] {
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
    fn ingress_handle_components_c_abi() {
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
        let ptr = &inner as *const crate::ingress::IngressInner as usize;
        // Empty packed header block: [u16 count = 0].
        let empty_headers = [0u8, 0];
        let rid = b"rid-1";
        let mut out = [0u8; 512];
        let w = unsafe {
            castrum_ingress_handle_components(
                ptr,
                0, // GET
                c"/api/users".as_ptr(),
                c"127.0.0.1".as_ptr(),
                rid.as_ptr(),
                rid.len(),
                empty_headers.as_ptr(),
                empty_headers.len(),
                std::ptr::null(),
                0,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert!(w > 0);
        // OUT_VERDICT == 0 (ok) at the first output byte — same as the packed
        // path for the same request components.
        assert_eq!(out[0], 0);

        // Null inner pointer → 0.
        let bad = unsafe {
            castrum_ingress_handle_components(
                0,
                0,
                c"/api/users".as_ptr(),
                c"127.0.0.1".as_ptr(),
                rid.as_ptr(),
                rid.len(),
                empty_headers.as_ptr(),
                empty_headers.len(),
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
        for section in [
            b"/api/users".as_slice(),
            b"127.0.0.1".as_slice(),
            b"rid-1".as_slice(),
        ] {
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
        assert_eq!(
            unsafe { *out_ptr },
            0,
            "verdict (ok) must land at out start"
        );
    }
}
