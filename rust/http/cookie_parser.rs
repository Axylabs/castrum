// rust/http/cookie_parser.rs — Unified zero-alloc cookie parser
// Eliminated the _vec variant; all callers use the single _into_slice path.
// Upper-bound pre-allocation for callers that need a Vec.

use crate::util::bytes::cookie_pairs;
use crate::util::{write_bytes, write_u32_le};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse cookies into a caller-provided slice (zero-alloc).
/// Output format: [u32 count] repeated { [u32 name_len] [name] [u32 value_len] [value] }
#[inline]
pub fn cookie_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for (name, value) in cookie_pairs(input) {
        write_u32_le(out, &mut pos, name.len() as u32)?;
        write_bytes(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Compute the EXACT packed output size for `input` WITHOUT writing — the
/// "needed-size" pass for the C-ABI convention. Mirrors
/// [`cookie_parse_packed_into_slice`] (trim + DQUOTE-unwrap, no decode), so the
/// reported size is byte-exact.
#[inline]
pub fn cookie_parse_packed_size(input: &[u8]) -> Result<usize> {
    let mut size = 4usize; // count prefix
    for (name, value) in crate::util::bytes::cookie_pairs(input) {
        size += 4 + name.len();
        size += 4 + value.len();
    }
    Ok(size)
}

/// Allocate and parse cookies. Uses conservative upper bound to avoid a pre-scan.
#[inline]
pub fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    let written = cookie_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

#[napi]
pub fn cookie_parse_packed(input: Uint8Array) -> Result<Buffer> {
    cookie_parse_packed_vec(input.as_ref()).map(Buffer::from)
}

#[napi]
pub fn cookie_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, cookie_parse_packed_into_slice)
}

#[cfg(test)]
mod tests {
    use super::cookie_parse_packed_vec;
    use crate::test_support::decode_packed_pairs;

    #[test]
    fn cookie_parse_basic() {
        let packed = cookie_parse_packed_vec(b"a=1; b=2").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
        assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
    }

    #[test]
    fn cookie_parse_trims_whitespace() {
        let packed = cookie_parse_packed_vec(b" a = 1 ; b = hello world ").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
        assert_eq!(pairs[1], (b"b".to_vec(), b"hello world".to_vec()));
    }

    #[test]
    fn cookie_parse_skips_empty_name() {
        let packed = cookie_parse_packed_vec(b"=1; =2; ok=3").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"ok".to_vec(), b"3".to_vec()));
    }

    #[test]
    fn cookie_parse_empty_value() {
        let packed = cookie_parse_packed_vec(b"session=").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"session".to_vec(), b"".to_vec()));
    }

    #[test]
    fn cookie_parse_equals_in_value() {
        // Only the first `=` separates name from value.
        let packed = cookie_parse_packed_vec(b"a=b=c").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"a".to_vec(), b"b=c".to_vec()));
    }

    #[test]
    fn cookie_parse_expires_value_with_commas() {
        let packed =
            cookie_parse_packed_vec(b"session=abc; expires=Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(
            pairs[1],
            (
                b"expires".to_vec(),
                b"Wed, 21 Oct 2015 07:28:00 GMT".to_vec()
            )
        );
    }

    #[test]
    fn cookie_parse_quotes_are_not_special() {
        // Cookies split on `;` unconditionally — quotes are ordinary data, and a
        // token without `=` becomes a pair with an empty value.
        let packed = cookie_parse_packed_vec(b"a=\"x;y\"").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (b"a".to_vec(), b"\"x".to_vec()));
        assert_eq!(pairs[1], (b"y\"".to_vec(), b"".to_vec()));
    }
}
