// rust/form.rs — application/x-www-form-urlencoded body parser.
//
// Reuses the zero-alloc query-parser core (`query_parse_packed_into_slice`):
// it already splits on '&', decodes '+'→space and %XX, which is exactly the
// x-www-form-urlencoded wire format. This module adds the public napi surface:
// a scalar `form_parse_packed` and the higher-order `FormParser` instance,
// which owns a reusable output buffer so repeated parses don't reallocate.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::http::query_parser::query_parse_packed_into_slice;

/// Parse an application/x-www-form-urlencoded body into packed pairs.
/// Output: `[u32 count] repeated { [u32 name_len] [name] [u32 value_len] [value] }`
#[inline]
pub fn form_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    // Same conservative upper bound as the query parser (9x + 16).
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    let written = query_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

#[napi]
pub fn form_parse_packed(input: Uint8Array) -> Result<Buffer> {
    form_parse_packed_vec(input.as_ref()).map(Buffer::from)
}

/// Higher-order instance: owns a reusable output buffer so repeated parses do
/// not reallocate. Buffer allocation happens once in the constructor (or is
/// amortized via grow-on-demand in `parse`), and `parse` writes into the
/// reused buffer — the compiled-once pattern shared by `SchemaValidator` /
/// `HmacSigner` / `TemplateRenderer`.
#[napi]
pub struct FormParser {
    buf: Vec<u8>,
}

#[napi]
impl FormParser {
    #[napi(constructor)]
    pub fn new(capacity: Option<u32>) -> Self {
        // Clamp the initial buffer to a sane cap so a huge capacity can't
        // force a multi-GiB single allocation; parse() still grows on demand.
        const MAX_CAPACITY: usize = 16 * 1024 * 1024;
        let cap = (capacity.unwrap_or(4096).max(256) as usize).min(MAX_CAPACITY);
        Self { buf: vec![0u8; cap] }
    }

    /// Parse into the instance's reusable buffer and return the packed pairs.
    #[napi]
    pub fn parse(&mut self, input: Uint8Array) -> Result<Buffer> {
        let need = input.len().saturating_mul(9).saturating_add(16);
        if self.buf.len() < need {
            self.buf.resize(need, 0);
        }
        let written = query_parse_packed_into_slice(input.as_ref(), &mut self.buf)?;
        Ok(Buffer::from(self.buf[..written].to_vec()))
    }

    /// Zero-alloc parse into a caller-provided output buffer.
    #[napi]
    pub fn parse_into(&self, input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
        crate::util::run_packed_into(&input, &mut output, query_parse_packed_into_slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::decode_packed_pairs;

    #[test]
    fn form_parse_basic_pairs() {
        let packed = form_parse_packed_vec(b"name=John%20Doe&age=30&tags=a&tags=b").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs.len(), 4);
        assert_eq!(pairs[0], (b"name".to_vec(), b"John Doe".to_vec()));
        assert_eq!(pairs[1], (b"age".to_vec(), b"30".to_vec()));
        assert_eq!(pairs[2], (b"tags".to_vec(), b"a".to_vec()));
        assert_eq!(pairs[3], (b"tags".to_vec(), b"b".to_vec()));
    }

    #[test]
    fn form_parse_plus_and_percent() {
        let packed = form_parse_packed_vec(b"a+b=c%2Bd&empty=").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs[0], (b"a b".to_vec(), b"c+d".to_vec()));
        assert_eq!(pairs[1], (b"empty".to_vec(), b"".to_vec()));
    }

    #[test]
    fn form_parse_key_without_equals() {
        let packed = form_parse_packed_vec(b"flag&x=1").unwrap();
        let pairs = decode_packed_pairs(&packed);
        assert_eq!(pairs[0], (b"flag".to_vec(), b"".to_vec()));
        assert_eq!(pairs[1], (b"x".to_vec(), b"1".to_vec()));
    }

    #[test]
    fn form_parse_empty_input() {
        let packed = form_parse_packed_vec(b"").unwrap();
        assert!(decode_packed_pairs(&packed).is_empty());
    }

    #[test]
    fn form_parse_rejects_malformed_percent() {
        assert!(form_parse_packed_vec(b"a=%ZZ").is_err());
    }

    #[test]
    fn form_parser_reuses_buffer_across_parses() {
        let mut parser = FormParser::new(Some(64));
        let a = parser.parse(Uint8Array::new(b"x=1&y=2".to_vec())).unwrap();
        assert_eq!(
            decode_packed_pairs(a.as_ref()),
            vec![(b"x".to_vec(), b"1".to_vec()), (b"y".to_vec(), b"2".to_vec())]
        );
        // A larger input grows the reusable buffer and still parses.
        let big = format!("k={}", "a".repeat(200));
        let b = parser.parse(Uint8Array::new(big.into_bytes())).unwrap();
        let pairs = decode_packed_pairs(b.as_ref());
        assert_eq!(pairs[0].1, b"a".repeat(200));
    }
}
