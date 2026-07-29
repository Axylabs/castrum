// rust/core/query_parser.rs — Query string parser
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;
use crate::core::util::{ensure_capacity, hex_val, write_bytes, write_u32_le};

/// Parse application/x-www-form-urlencoded into packed pairs.
/// Output: [u32 count] repeated { [u32 dec_name_len] [decoded_name] [u32 dec_val_len] [decoded_val] }
#[inline]
pub fn query_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> CoreResult<usize> {
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

/// Write a single URL-decoded form component into the output slice.
#[inline]
fn write_decoded_form_component(src: &[u8], out: &mut [u8], pos: &mut usize) -> CoreResult<()> {
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
                    if i + 2 >= src.len() {
                        return Err(malformed_data("invalid %-encoding: missing bytes", i));
                    }
                    let hi = hex_val(src[i + 1])
                        .ok_or_else(|| malformed_data("invalid %-encoding: bad hi nibble", i))?;
                    let lo = hex_val(src[i + 2])
                        .ok_or_else(|| malformed_data("invalid %-encoding: bad lo nibble", i))?;
                    ensure_capacity(out, *pos, 1)?;
                    out[*pos] = (hi << 4) | lo;
                    *pos += 1;
                    i += 3;
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

/// Allocating parser — conservative upper bound, no pre-scan.
#[inline]
pub fn query_parse_packed_vec(input: &[u8]) -> Vec<u8> {
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    match query_parse_packed_into_slice(input, &mut out) {
        Ok(written) => {
            out.truncate(written);
            out
        }
        Err(_) => {
            vec![0u8; 4] // empty result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_parse_empty() {
        let result = query_parse_packed_vec(b"");
        assert_eq!(&result[..4], &[0u8, 0, 0, 0]);
    }

    #[test]
    fn test_query_parse_simple() {
        let result = query_parse_packed_vec(b"foo=bar");
        let count = u32::from_le_bytes([result[0], result[1], result[2], result[3]]);
        assert_eq!(count, 1);
    }
}