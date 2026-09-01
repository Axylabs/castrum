// rust/ffi/http.rs — HTTP wire-format C-ABI exports.
//
// Cache semantics (etag / conditional / http-date), media-type + accept-encoding
// negotiation, MIME lookup, URL resolve/encode, and the packed parsers
// (http request / query / cookie / form / multipart).

use std::slice;

use super::util::{cstring_return, panic_guard};

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
    crate::http::etag::etag_from_crc32_into(crc, weak != 0, slice::from_raw_parts_mut(out, needed))
        .unwrap_or_default()
}

/// Evaluate `ConditionalRequest::is_not_modified` against the precompiled state
/// via its opaque inner handle (from the napi `inner_ptr()`). `flags` bit0 =
/// If-None-Match present, bit1 = If-Modified-Since present (a present-but-empty
/// header is distinct from absent, matching the napi `Option` semantics).
/// Returns 1 → 304. A null handle (0) → 0, so a dropped instance can never
/// dereference freed state.
///
/// `inm`/`ims` cross as `(ptr, len)` byte slices — the same convention as every
/// other instance op (`castrum_media_type_matcher_matches`, `castrum_jwt_signer_*`,
/// `castrum_template_render`, `castrum_schema_validator_validate`) — so the JS
/// side passes arbitrary header bytes with no NUL-termination requirement.
/// Presence is gated by `flags`, so the pointers are ignored when the
/// corresponding bit is 0.
///
/// # Safety
/// `inner` must be a valid `ConditionalRequest` pointer obtained from
/// `inner_ptr()` and must stay alive for the call (the JS wrapper holds the
/// napi instance). `inm`/`ims` must be valid for `inm_len`/`ims_len` bytes when
/// the corresponding `flags` bit is set.
#[no_mangle]
pub unsafe extern "C" fn castrum_conditional_is_not_modified(
    inner: usize,
    inm: *const u8,
    inm_len: usize,
    ims: *const u8,
    ims_len: usize,
    flags: u8,
) -> u8 {
    if inner == 0 {
        return 0;
    }
    let inm_opt = if flags & 1 != 0 && !inm.is_null() {
        Some(std::slice::from_raw_parts(inm, inm_len))
    } else {
        None
    };
    let ims_opt = if flags & 2 != 0 && !ims.is_null() {
        Some(std::slice::from_raw_parts(ims, ims_len))
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
/// `header` crosses as a `(ptr, len)` byte slice — the same convention as
/// `castrum_media_type_matcher_matches` — so the JS side passes arbitrary
/// header bytes with no NUL-termination requirement.
///
/// # Safety
/// `inner` must be a valid `AcceptNegotiator` pointer from `inner_ptr()`, alive
/// for the call; `header` must be valid for `header_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_accept_negotiator_negotiate(
    inner: usize,
    header: *const u8,
    header_len: usize,
) -> *const std::os::raw::c_char {
    if inner == 0 || header.is_null() {
        return std::ptr::null();
    }
    let h = slice::from_raw_parts(header, header_len);
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

/// Write an HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`) into `out`. Returns
/// bytes written (29), or 0 on a too-small buffer / out-of-range year (use the
/// allocating `httpDate` napi path for that fallback). Fixed 32-byte stack
/// buffer core — the FFI sibling of the napi `httpDateInto` (kills the napi
/// crossing on the hot `httpDateInto` path).
///
/// # Safety
/// `out` must be valid for writes of up to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_http_date_into(secs: f64, out: *mut u8, out_cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    let output = slice::from_raw_parts_mut(out, out_cap);
    crate::http::http_date::http_date_into_slice(secs as i64, output).unwrap_or(0)
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
    let Some(prefs) = panic_guard(
        || Some(crate::http::accept::parse_accept_encoding_core(input)),
        None,
    ) else {
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
            let count = u32::from_le_bytes([input[0], input[1], input[2], input[3]]) as usize;
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
