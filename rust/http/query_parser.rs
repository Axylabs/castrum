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
    //
    // A malformed escape is NOT an error here: the shared decoder answers with
    // the raw component, exactly like the pure-TS fallback
    // (`decodeURIComponent` throws → `catch` returns the segment). The only
    // error left is a too-small output buffer, which the C-ABI caller turns
    // into the needed-size answer.
    let written = crate::util::bytes::decode_form_component_into(src, &mut out[*pos..])
        .map_err(|_| Error::from_reason("packed output: buffer too small"))?;
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
/// empty pairs, split at `=`) AND its decoding, including the raw fallback for a
/// malformed `%XX`: the reported size and the written size must never disagree,
/// or the caller's grow-and-retry loop would never terminate.
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
        size += 4 + crate::util::bytes::decode_form_component_len(key);
        size += 4 + crate::util::bytes::decode_form_component_len(value);
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
    fn query_parse_malformed_percent_falls_back_to_raw() {
        // JS: `try { decodeURIComponent(s.replace(/\+/g," ")) } catch { return s }`
        // — applied PER COMPONENT, so name and value fail independently. Checked
        // against Bun's `decodeURIComponent`:
        //   "a=%ZZ"     → [["a", "%ZZ"]]
        //   "a+b=%2"    → [["a b", "%2"]]      (`+` in the NAME still decodes)
        //   "x=1+2%ZZ"  → [["x", "1+2%ZZ"]]    (raw keeps its `+`)
        //   "a+b=%20"   → [["a b", " "]]
        let packed = query_parse_packed_vec(b"a=%ZZ").unwrap();
        assert_eq!(
            decode_packed_pairs(&packed),
            vec![(b"a".to_vec(), b"%ZZ".to_vec())]
        );
        let packed = query_parse_packed_vec(b"a+b=%2").unwrap();
        assert_eq!(
            decode_packed_pairs(&packed),
            vec![(b"a b".to_vec(), b"%2".to_vec())]
        );
        let packed = query_parse_packed_vec(b"x=1+2%ZZ").unwrap();
        assert_eq!(
            decode_packed_pairs(&packed),
            vec![(b"x".to_vec(), b"1+2%ZZ".to_vec())]
        );
        let packed = query_parse_packed_vec(b"a+b=%20").unwrap();
        assert_eq!(
            decode_packed_pairs(&packed),
            vec![(b"a b".to_vec(), b" ".to_vec())]
        );
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
    fn query_parse_non_utf8_escape_falls_back_to_raw() {
        // `%FF` decodes to a byte that cannot appear in valid UTF-8, so JS's
        // `decodeURIComponent` throws and the component is returned raw. The
        // packed output must therefore hold the literal `%FF` text, NOT a 0xFF
        // byte (which a JS caller could only read back lossily as U+FFFD).
        let packed = query_parse_packed_vec(b"a=%FF").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], (b"a".to_vec(), b"%FF".to_vec()));
        // A literal invalid byte with nothing to decode still passes through.
        let packed = query_parse_packed_vec(b"a=\xFF").unwrap();
        assert_eq!(
            decode_packed_pairs(&packed),
            vec![(b"a".to_vec(), b"\xFF".to_vec())]
        );
    }
}
