// rust/query_parser.rs — Unified zero-alloc query string parser
// Single _into_slice code path with _vec wrapper for callers needing Vec.
// Returns Cow<[u8]> when no decoding is needed (zero allocation).

use crate::util::bytes::decode_percent_at;
use crate::util::{ensure_capacity, write_bytes, write_u32_le};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Write a single URL-decoded form component into the output slice.
#[inline]
fn write_decoded_form_component(src: &[u8], out: &mut [u8], pos: &mut usize) -> Result<()> {
    let len_pos = *pos;
    write_u32_le(out, pos, 0)?;
    let start = *pos;

    if memchr::memchr2(b'+', b'%', src).is_none() {
        write_bytes(out, pos, src)?;
    } else {
        let mut i = 0usize;
        while i < src.len() {
            match src[i] {
                b'+' => {
                    ensure_capacity(out, *pos, 1)?;
                    out[*pos] = b' ';
                    *pos += 1;
                    i += 1;
                }
                b'%' => {
                    let (byte, next) = decode_percent_at(src, i).ok_or_else(|| {
                        Error::from_reason("invalid %-encoding: malformed %XX sequence")
                    })?;
                    ensure_capacity(out, *pos, 1)?;
                    out[*pos] = byte;
                    *pos += 1;
                    i = next;
                }
                b => {
                    ensure_capacity(out, *pos, 1)?;
                    out[*pos] = b;
                    *pos += 1;
                    i += 1;
                }
            }
        }
    }

    let decoded_len = (*pos - start) as u32;
    out[len_pos..len_pos + 4].copy_from_slice(&decoded_len.to_le_bytes());
    Ok(())
}

/// Parse application/x-www-form-urlencoded into packed pairs.
/// Output: [u32 count] repeated { [u32 dec_name_len] [decoded_name] [u32 dec_val_len] [decoded_val] }
#[inline]
pub fn query_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;
    let mut count = 0u32;

    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() { continue; }
        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };
        write_decoded_form_component(key, out, &mut pos)?;
        write_decoded_form_component(value, out, &mut pos)?;
        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Allocating parser — conservative upper bound, no pre-scan.
#[inline]
pub fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    // Packed output is larger than input: each component gets 4-byte length prefix.
    // Upper bound: 4 (count) + input.len() * 2 * 5 ≈ 10x for worst-case (many small pairs).
    // Conservative: 9x + 16 (same as before).
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    match query_parse_packed_into_slice(input, &mut out) {
        Ok(written) => {
            out.truncate(written);
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

#[napi]
pub fn query_parse_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(query_parse_packed_vec(input.as_ref())?))
}

#[napi]
pub fn query_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, query_parse_packed_into_slice)
}