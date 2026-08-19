// rust/ffi/hashing.rs — hashing + scalar codec C-ABI exports.
//
// crc32 / fnv1a64 / xxh3 checksums, JSON/UTF-8 validity, hex + percent-encode/
// decode, and the `id`-sum aggregation. All stateless `&[u8]` → scalar / write
// into a caller buffer.

use std::ptr;
use std::slice;

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
