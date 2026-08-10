// rust/util/batch.rs — v2: DIRECT WRITE, NO INTERMEDIATE Vec<Vec<u8>>
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::json::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};
use crate::util::{count_batch, should_parallelize, sum_batch_i64, total_bytes, unpack};

// ── Internal helpers (direct-write variants) ──

/// Direct-write JSON sum batch — eliminates intermediate Vec<i64>.
#[inline]
fn json_sum_batch_direct(items: &[&[u8]], out: &mut Vec<u8>) {
    let n = items.len();
    out.reserve(4 + n * 8);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    let start = out.len();
    out.resize(start + n * 8, 0);

    // Slice the output buffer to write directly into it.
    let out_slice = &mut out[start..];

    if should_parallelize(items.len(), total_bytes(items)) {
        use rayon::prelude::*;
        let chunk_size = 256;

        // Use par_chunks_mut to get mutable disjoint slices of the output buffer.
        out_slice
            .par_chunks_mut(chunk_size * 8)
            .enumerate()
            .for_each(|(ci, out_chunk)| {
                let num_items = out_chunk.len() / 8;
                let item_start = ci * chunk_size;
                let item_end = (item_start + num_items).min(items.len());

                for (i, item) in items[item_start..item_end].iter().enumerate() {
                    let sum = json_sum_ids_bytes(item).unwrap_or(0);
                    out_chunk[i * 8..(i + 1) * 8].copy_from_slice(&sum.to_le_bytes());
                }
            });
    } else {
        for (i, item) in items.iter().enumerate() {
            let sum = json_sum_ids_bytes(item).unwrap_or(0);
            out_slice[i * 8..(i + 1) * 8].copy_from_slice(&sum.to_le_bytes());
        }
    }
}

/// Direct-write parse batch — eliminates intermediate Vec<Vec<u8>>.
#[inline]
fn parse_batch_direct<F>(items: &[&[u8]], out: &mut Vec<u8>, f: F)
where
    F: Fn(&[u8]) -> Result<Vec<u8>> + Sync,
{
    let n = items.len();
    out.reserve(4 + n * 32);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for item in items {
        let r = f(item).unwrap_or_default();
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(&r);
    }
}

#[inline]
fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::query_parser::query_parse_packed_vec(input)
}

#[inline]
fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::cookie_parser::cookie_parse_packed_vec(input)
}

#[inline]
fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::http_parser::http_parse_request_packed_vec(input)
}

#[inline]
fn form_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::form::form_parse_packed_vec(input)
}

#[inline]
fn sign_cookie_batch_bytes(data: &[u8], secret: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, |v| {
        Ok(crate::crypto::cookie_sign::sign_cookie_bytes(v, &key))
    });
    Ok(out)
}

#[inline]
fn count_batch_data(
    data: &[u8],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> Result<u32> {
    let items = unpack(data)?;
    Ok(count_batch(&items, f, chunk_items) as u32)
}

#[inline]
fn sum_ids_batch_data(data: &[u8], chunk_items: usize) -> Result<i64> {
    let items = unpack(data)?;
    Ok(sum_batch_i64(
        &items,
        |item| json_sum_ids_bytes(item).unwrap_or(0),
        chunk_items,
    ))
}

#[inline]
fn total_len_batch_data(
    data: &[u8],
    f: impl Fn(&[u8]) -> Result<Vec<u8>> + Sync,
    chunk_items: usize,
) -> Result<u32> {
    let items = unpack(data)?;
    let chunk_items = chunk_items.max(64);
    let total: usize = if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        items
            .par_chunks(chunk_items)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|item| f(item).map(|v| v.len()).unwrap_or(0))
                    .sum::<usize>()
            })
            .sum()
    } else {
        items
            .iter()
            .map(|item| f(item).map(|v| v.len()).unwrap_or(0))
            .sum()
    };
    Ok(total as u32)
}

// ── Packed input → packed output ──

#[inline]
fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(
        &items,
        json_valid_bytes,
        512,
    ))
}

#[inline]
fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(
        &items,
        validate_email_bytes,
        4096,
    ))
}

#[inline]
fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(
        &items,
        validate_uuid_bytes,
        4096,
    ))
}

#[inline]
fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(
        &items,
        validate_ipv4_bytes,
        4096,
    ))
}

#[inline]
fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(
        &items,
        validate_ipv6_bytes,
        4096,
    ))
}

#[inline]
fn json_sum_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(4 + items.len() * 8);
    json_sum_batch_direct(&items, &mut out);
    Ok(out)
}

#[inline]
fn query_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, query_parse_packed_vec);
    Ok(out)
}

#[inline]
fn cookie_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, cookie_parse_packed_vec);
    Ok(out)
}

#[inline]
fn form_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, form_parse_packed_vec);
    Ok(out)
}

#[inline]
fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 64);
    parse_batch_direct(&items, &mut out, http_parse_request_packed_vec);
    Ok(out)
}

#[inline]
fn hex_encode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, |v| {
        Ok(crate::crypto::base64::hex_encode_bytes(v).into_bytes())
    });
    Ok(out)
}

#[inline]
fn hex_decode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, |v| {
        crate::crypto::base64::hex_decode_bytes(v).map_err(|e| Error::from_reason(e.to_string()))
    });
    Ok(out)
}

// ── Sync packed batch APIs ──

#[napi]
pub fn json_valid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_valid_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_email_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_email_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_uuid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_uuid_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_ipv4_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv4_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_ipv6_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv6_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn json_sum_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_sum_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn query_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(query_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn cookie_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(cookie_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn form_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(form_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn sign_cookie_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(sign_cookie_batch_bytes(
        data.as_ref(),
        secret.as_ref(),
    )?))
}
#[napi]
pub fn verify_cookie_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    Ok(Buffer::from(crate::util::validation_bitset_chunked(
        &items,
        |s| crate::crypto::cookie_sign::verify_cookie_bytes(s, &key).is_some(),
        4096,
    )))
}
#[napi]
pub fn csrf_verify_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    Ok(Buffer::from(crate::util::validation_bitset_chunked(
        &items,
        |t| crate::crypto::csrf::csrf_verify_with_key(t, &key),
        4096,
    )))
}
#[napi]
pub fn http_parse_request_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_batch_bytes(
        input.as_ref(),
    )?))
}
#[napi]
pub fn hex_encode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(hex_encode_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn hex_decode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(hex_decode_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn base64_encode_batch_packed(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<Buffer> {
    let us = url_safe.unwrap_or(false);
    let pad = padding.unwrap_or(true);
    let items = unpack(input.as_ref())?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, move |v| {
        Ok(crate::crypto::base64::base64_encode_bytes(v, us, pad))
    });
    Ok(Buffer::from(out))
}
#[napi]
pub fn base64_decode_batch_packed(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<Buffer> {
    let us = url_safe.unwrap_or(false);
    let pad = padding.unwrap_or(true);
    let items = unpack(input.as_ref())?;
    let mut out = Vec::with_capacity(items.len() * 32);
    parse_batch_direct(&items, &mut out, move |v| {
        crate::crypto::base64::base64_decode_bytes(v, us, pad)
    });
    Ok(Buffer::from(out))
}

// ── Aggregate sync packed batch APIs ──

#[napi]
pub fn json_valid_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), json_valid_bytes, 512)
}
#[napi]
pub fn validate_email_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_email_bytes, 4096)
}
#[napi]
pub fn validate_uuid_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_uuid_bytes, 4096)
}
#[napi]
pub fn validate_ipv4_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_ipv4_bytes, 4096)
}
#[napi]
pub fn validate_ipv6_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_ipv6_bytes, 4096)
}
#[napi]
pub fn json_sum_batch_total_packed(input: Uint8Array) -> Result<i64> {
    sum_ids_batch_data(input.as_ref(), 512)
}
#[napi]
pub fn query_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(input.as_ref(), query_parse_packed_vec, 256)
}
#[napi]
pub fn cookie_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(input.as_ref(), cookie_parse_packed_vec, 256)
}
#[napi]
pub fn http_parse_request_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(input.as_ref(), http_parse_request_packed_vec, 256)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build packed input: `[u32 count] repeated { [u32 len][bytes] }`.
    fn pack_items(items: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(items.len() as u32).to_le_bytes());
        for item in items {
            out.extend_from_slice(&(item.len() as u32).to_le_bytes());
            out.extend_from_slice(item);
        }
        out
    }

    /// Decode packed byte results: `[u32 count] repeated { [u32 len][bytes] }`.
    fn unpack_results(packed: &[u8]) -> Vec<Vec<u8>> {
        assert!(packed.len() >= 4);
        let n = u32::from_le_bytes(packed[0..4].try_into().unwrap()) as usize;
        let mut pos = 4usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let len = u32::from_le_bytes(packed[pos..pos + 4].try_into().unwrap()) as usize;
            pos += 4;
            out.push(packed[pos..pos + len].to_vec());
            pos += len;
        }
        out
    }

    #[test]
    fn hex_encode_batch_matches_scalar() {
        let data = pack_items(&[b"hi\0\xff", b"AB"]);
        let out = hex_encode_batch_bytes(&data).unwrap();
        let results = unpack_results(&out);
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0],
            crate::crypto::base64::hex_encode_bytes(b"hi\0\xff").into_bytes()
        );
        assert_eq!(results[1], b"4142");
    }

    #[test]
    fn hex_decode_batch_roundtrips() {
        let data = pack_items(&[b"686900ff", b"4142"]);
        let out = hex_decode_batch_bytes(&data).unwrap();
        let results = unpack_results(&out);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], b"hi\0\xff");
        assert_eq!(results[1], b"AB");
    }

    #[test]
    fn base64_encode_batch_matches_scalar() {
        let data = pack_items(&[b"hello world!", b"\xfb"]);
        let out = base64_encode_batch_packed(Uint8Array::new(data), None, None).unwrap();
        let results = unpack_results(out.as_ref());
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0],
            crate::crypto::base64::base64_encode_bytes(b"hello world!", false, true)
        );
        assert_eq!(
            results[1],
            crate::crypto::base64::base64_encode_bytes(b"\xfb", false, true)
        );
    }

    #[test]
    fn base64_decode_batch_roundtrips() {
        let a = crate::crypto::base64::base64_encode_bytes(b"hello world!", false, true);
        let b = crate::crypto::base64::base64_encode_bytes(b"\xfb", false, true);
        let data = pack_items(&[&a, &b]);
        let out = base64_decode_batch_packed(Uint8Array::new(data), None, None).unwrap();
        let results = unpack_results(out.as_ref());
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], b"hello world!");
        assert_eq!(results[1], [0xfb]);
    }

    #[test]
    fn base64_encode_batch_urlsafe_no_pad() {
        let data = pack_items(&[b"\xfb"]);
        let out =
            base64_encode_batch_packed(Uint8Array::new(data), Some(true), Some(false)).unwrap();
        let results = unpack_results(out.as_ref());
        assert_eq!(results[0], b"-w");
    }
}
