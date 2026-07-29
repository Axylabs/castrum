// rust/core/url_codec.rs — URL encoding/decoding
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;
use crate::core::util::{ensure_capacity, hex_val};

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

#[inline(always)]
fn is_unreserved(b: u8) -> bool {
    matches!(b,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
        | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | 0x27 | b'(' | b')'
    )
}

/// URL-encode bytes.
pub fn url_encode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + input.len() / 4 + 8);
    let mut start = 0usize;

    for (i, &b) in input.iter().enumerate() {
        if !is_unreserved(b) {
            out.extend_from_slice(&input[start..i]);
            let mut encoded = [b'%', 0, 0];
            encoded[1] = HEX_UPPER[(b >> 4) as usize];
            encoded[2] = HEX_UPPER[(b & 0x0f) as usize];
            out.extend_from_slice(&encoded);
            start = i + 1;
        }
    }

    out.extend_from_slice(&input[start..]);
    out
}

/// URL-decode percent-encoded bytes.
pub fn url_decode(input: &[u8]) -> CoreResult<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0usize;

    while let Some(rel) = memchr::memchr(b'%', &input[pos..]) {
        let i = pos + rel;
        out.extend_from_slice(&input[pos..i]);

        if i + 2 >= input.len() {
            return Err(malformed_data("invalid %-encoding: missing bytes", i));
        }
        let hi = hex_val(input[i + 1])
            .ok_or_else(|| malformed_data("invalid %-encoding: bad hi nibble", i))?;
        let lo = hex_val(input[i + 2])
            .ok_or_else(|| malformed_data("invalid %-encoding: bad lo nibble", i))?;

        out.push((hi << 4) | lo);
        pos = i + 3;
    }

    out.extend_from_slice(&input[pos..]);
    Ok(out)
}

/// URL-encode into a caller-provided slice.
pub fn url_encode_into_slice(input: &[u8], out: &mut [u8]) -> CoreResult<usize> {
    let mut pos = 0usize;
    let mut start = 0usize;

    for (i, &b) in input.iter().enumerate() {
        if !is_unreserved(b) {
            crate::core::util::write_bytes(out, &mut pos, &input[start..i])?;
            ensure_capacity(out, pos, 3)?;
            out[pos] = b'%';
            out[pos + 1] = HEX_UPPER[(b >> 4) as usize];
            out[pos + 2] = HEX_UPPER[(b & 0x0f) as usize];
            pos += 3;
            start = i + 1;
        }
    }

    crate::core::util::write_bytes(out, &mut pos, &input[start..])?;
    Ok(pos)
}

/// URL-decode into a caller-provided slice.
pub fn url_decode_into_slice(input: &[u8], out: &mut [u8]) -> CoreResult<usize> {
    let mut pos = 0usize;
    let mut src_pos = 0usize;

    while let Some(rel) = memchr::memchr(b'%', &input[src_pos..]) {
        let i = src_pos + rel;
        crate::core::util::write_bytes(out, &mut pos, &input[src_pos..i])?;

        if i + 2 >= input.len() {
            return Err(malformed_data("invalid %-encoding: missing bytes", i));
        }
        let hi = hex_val(input[i + 1])
            .ok_or_else(|| malformed_data("invalid %-encoding: bad hi nibble", i))?;
        let lo = hex_val(input[i + 2])
            .ok_or_else(|| malformed_data("invalid %-encoding: bad lo nibble", i))?;

        ensure_capacity(out, pos, 1)?;
        out[pos] = (hi << 4) | lo;
        pos += 1;
        src_pos = i + 3;
    }

    crate::core::util::write_bytes(out, &mut pos, &input[src_pos..])?;
    Ok(pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_encode_basic() {
        assert_eq!(
            url_encode(b"hello world"),
            b"hello%20world"
        );
    }

    #[test]
    fn test_url_decode_basic() {
        assert_eq!(
            url_decode(b"hello%20world").unwrap(),
            b"hello world"
        );
    }
}