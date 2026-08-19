// rust/http/query_parser.rs — Unified zero-alloc query string parser
// Single _into_slice code path with _vec wrapper for callers needing Vec.
// Returns Cow<[u8]> when no decoding is needed (zero allocation).

use crate::util::write_u32_le;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Write a single URL-decoded form component into the output slice.
#[inline]
fn write_decoded_form_component(src: &[u8], out: &mut [u8], pos: &mut usize) -> Result<()> {
    let len_pos = *pos;
    write_u32_le(out, pos, 0)?;
    // The decoded length never exceeds `src.len()`; the shared decoder checks
    // the remaining buffer against the ACTUAL decoded length (so a `%XX`-heavy
    // component only needs room for its decoded form, matching the pre-refactor
    // behavior where a buffer sized to the decoded length succeeds).
    let written = crate::util::bytes::decode_form_component_into(src, &mut out[*pos..]).map_err(
        |e| match e {
            crate::util::bytes::FormDecodeError::Malformed => {
                Error::from_reason("invalid %-encoding: malformed %XX sequence")
            }
            crate::util::bytes::FormDecodeError::BufferTooSmall => {
                Error::from_reason("packed output: buffer too small")
            }
        },
    )?;
    *pos += written;
    let decoded_len = written as u32;
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
        if pair.is_empty() {
            continue;
        }
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

/// Compute the EXACT packed output size for `input` WITHOUT writing — the
/// "needed-size" pass for the C-ABI convention. Mirrors
/// [`query_parse_packed_into_slice`]'s structure exactly (split on `&`, skip
/// empty pairs, split at `=`), so the reported size is byte-exact and a
/// malformed `%XX` still surfaces as `Err` (caller → `0`).
#[inline]
pub fn query_parse_packed_size(input: &[u8]) -> Result<usize> {
    let mut size = 4usize; // count prefix
    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };
        size += 4 + crate::util::bytes::decode_form_component_len(key)
            .map_err(|_| Error::from_reason("invalid %-encoding: malformed %XX sequence"))?;
        size += 4 + crate::util::bytes::decode_form_component_len(value)
            .map_err(|_| Error::from_reason("invalid %-encoding: malformed %XX sequence"))?;
    }
    Ok(size)
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

#[cfg(test)]
mod tests {
    use super::query_parse_packed_vec;
    use crate::test_support::decode_packed_pairs;

    #[test]
    fn query_parse_basic_pairs() {
        let packed = query_parse_packed_vec(b"a=1&b=2").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (b"a".to_vec(), b"1".to_vec()));
        assert_eq!(pairs[1], (b"b".to_vec(), b"2".to_vec()));
    }

    #[test]
    fn query_parse_percent_and_plus_decoding() {
        let packed = query_parse_packed_vec(b"name=John%20Doe&q=a+b").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (b"name".to_vec(), b"John Doe".to_vec()));
        assert_eq!(pairs[1], (b"q".to_vec(), b"a b".to_vec()));
    }

    #[test]
    fn query_parse_empty_value() {
        let packed = query_parse_packed_vec(b"flag").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"flag".to_vec(), b"".to_vec()));
    }

    #[test]
    fn query_parse_invalid_percent_rejected() {
        assert!(query_parse_packed_vec(b"a=%ZZ").is_err());
    }

    #[test]
    fn query_parse_empty_input() {
        let packed = query_parse_packed_vec(b"").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert!(pairs.is_empty());
    }

    #[test]
    fn query_parse_null_byte_preserved() {
        // `%00` decodes to a NUL byte inside the value (byte-oriented parser).
        let packed = query_parse_packed_vec(b"a=%00b").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"a".to_vec(), b"\x00b".to_vec()));
    }

    #[test]
    fn query_parse_semicolon_is_data() {
        // In a query string `&` separates pairs; `;` is ordinary data.
        let packed = query_parse_packed_vec(b"a=1;b=2").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"a".to_vec(), b"1;b=2".to_vec()));
    }

    #[test]
    fn query_parse_non_utf8_byte_passthrough() {
        // `%FF` decodes to a raw 0xFF byte; the parser does not require valid
        // UTF-8 in query values (callers must handle it when they do).
        let packed = query_parse_packed_vec(b"a=%FF").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"a".to_vec(), vec![0xFF]));
    }
}
