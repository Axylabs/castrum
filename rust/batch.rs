use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::cookie_parser::cookie_parse_packed_into_slice;
use crate::http_parser::http_parse_request_packed_into_slice;
use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::query_parser::query_parse_packed_into_slice;
use crate::util::{pack_byte_results, unpack, validation_bitset};
use crate::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

fn json_sum_batch(items: &[&[u8]]) -> Vec<u8> {
    let sums: Vec<i64> =
        if crate::util::should_parallelize(items.len(), crate::util::total_bytes(items)) {
            use rayon::prelude::*;
            items
                .par_iter()
                .map(|item| json_sum_ids_bytes(item).unwrap_or(0))
                .collect()
        } else {
            items
                .iter()
                .map(|item| json_sum_ids_bytes(item).unwrap_or(0))
                .collect()
        };

    let mut out = Vec::with_capacity(4 + sums.len() * 8);
    out.extend_from_slice(&(sums.len() as u32).to_le_bytes());
    for sum in sums {
        out.extend_from_slice(&sum.to_le_bytes());
    }
    out
}
fn parse_batch(items: &[&[u8]], f: impl Fn(&[u8]) -> Result<Vec<u8>> + Sync) -> Vec<u8> {
    let results: Vec<Vec<u8>> =
        if crate::util::should_parallelize(items.len(), crate::util::total_bytes(items)) {
            use rayon::prelude::*;
            items
                .par_iter()
                .map(|item| f(item).unwrap_or_default())
                .collect()
        } else {
            items
                .iter()
                .map(|item| f(item).unwrap_or_default())
                .collect()
        };

    pack_byte_results(&results)
}




fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let pair_count = memchr::memchr_iter(b'&', input).count() + 1;

    let upper_bound = input
        .len()
        .saturating_add(pair_count.saturating_mul(8))
        .saturating_add(4);

    let mut out = vec![0u8; upper_bound];
    let written = query_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);

    Ok(out)
}

fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let pair_count = memchr::memchr_iter(b';', input).count() + 1;

    let upper_bound = input
        .len()
        .saturating_add(pair_count.saturating_mul(8))
        .saturating_add(4);

    let mut out = vec![0u8; upper_bound];
    let written = cookie_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);

    Ok(out)
}

fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![0u8; input.len().saturating_add(528)];
    let written = http_parse_request_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}
// ------------------------------------------------------------------
// Packed input -> packed output internal functions
// ------------------------------------------------------------------

fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, json_valid_bytes))
}

fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_email_bytes))
}

fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_uuid_bytes))
}

fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_ipv4_bytes))
}

fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_ipv6_bytes))
}

fn json_sum_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(json_sum_batch(&items))
}

fn query_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, query_parse_packed_vec))
}

fn cookie_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, cookie_parse_packed_vec))
}

fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, http_parse_request_packed_vec))
}

// ------------------------------------------------------------------
// Sync packed batch APIs
// ------------------------------------------------------------------

#[napi]
pub fn json_valid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_valid_batch_bytes(input.as_ref())?))
}

#[napi]
pub fn validate_email_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_email_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_uuid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_uuid_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_ipv4_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv4_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_ipv6_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv6_batch_bytes(
        input.as_ref(),
    )?))
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
pub fn http_parse_request_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_batch_bytes(
        input.as_ref(),
    )?))
}

// ------------------------------------------------------------------
// Async packed batch APIs
// ------------------------------------------------------------------

macro_rules! packed_async_fn {
    ($fn_name:ident, $func:path) => {
        #[napi]
        pub async fn $fn_name(input: Uint8Array) -> Result<Buffer> {
            let packed = input.as_ref().to_vec();

            let output = tokio::task::spawn_blocking(move || $func(&packed))
                .await
                .map_err(crate::util::tokio_join_error)?;

            Ok(Buffer::from(output?))
        }
    };
}

packed_async_fn!(json_valid_batch_packed_async, json_valid_batch_bytes);
packed_async_fn!(validate_email_batch_packed_async, validate_email_batch_bytes);
packed_async_fn!(validate_uuid_batch_packed_async, validate_uuid_batch_bytes);
packed_async_fn!(validate_ipv4_batch_packed_async, validate_ipv4_batch_bytes);
packed_async_fn!(validate_ipv6_batch_packed_async, validate_ipv6_batch_bytes);
packed_async_fn!(json_sum_batch_packed_async, json_sum_batch_bytes);
packed_async_fn!(query_parse_batch_packed_async, query_parse_batch_bytes);
packed_async_fn!(cookie_parse_batch_packed_async, cookie_parse_batch_bytes);
packed_async_fn!(http_parse_request_batch_packed_async, http_parse_request_batch_bytes);