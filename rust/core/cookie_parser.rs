// rust/core/cookie_parser.rs — Unified zero-alloc cookie parser
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;
use crate::core::util::{trim_ascii_whitespace, write_bytes, write_u32_le};

/// Parse cookies into a caller-provided slice (zero-alloc).
/// Output format: [u32 count] repeated { [u32 name_len] [name] [u32 value_len] [value] }
#[inline]
pub fn cookie_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> CoreResult<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() { continue; }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() { continue; }

        write_u32_le(out, &mut pos, name.len() as u32)?;
        write_bytes(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Allocate and parse cookies. Uses conservative upper bound to avoid a pre-scan.
#[inline]
pub fn cookie_parse_packed_vec(input: &[u8]) -> Vec<u8> {
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    match cookie_parse_packed_into_slice(input, &mut out) {
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
    fn test_cookie_parse_empty() {
        let result = cookie_parse_packed_vec(b"");
        assert_eq!(&result[..4], &[0u8, 0, 0, 0]); // count = 0
    }

    #[test]
    fn test_cookie_parse_single() {
        let result = cookie_parse_packed_vec(b"session=abc123");
        let count = u32::from_le_bytes([result[0], result[1], result[2], result[3]]);
        assert_eq!(count, 1);
    }
}