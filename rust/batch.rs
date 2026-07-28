// rust/batch.rs — v2: DIRECT WRITE, NO INTERMEDIATE Vec<Vec<u8>>
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::{
    count_batch, should_parallelize, sum_batch_i64, total_bytes, unpack,
};
use crate::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};

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
        out_slice.par_chunks_mut(chunk_size * 8).enumerate().for_each(|(ci, out_chunk)| {
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
    crate::query_parser::query_parse_packed_vec(input)
}

#[inline]
fn cookie_parse_packed_vec(input: &[u8]) -> Vec<u8> {
    crate::cookie_parser::cookie_parse_packed_vec(input)
}

#[inline]
fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http_parser::http_parse_request_packed_vec(input)
}

#[inline]
fn count_batch_data(data: &[u8], f: impl Fn(&[u8]) -> bool + Sync, chunk_items: usize) -> Result<u32> {
    let items = unpack(data)?;
    Ok(count_batch(&items, f, chunk_items) as u32)
}

#[inline]
fn sum_ids_batch_data(data: &[u8], chunk_items: usize) -> Result<i64> {
    let items = unpack(data)?;
    Ok(sum_batch_i64(&items, |item| json_sum_ids_bytes(item).unwrap_or(0), chunk_items))
}

#[inline]
fn total_len_batch_data(data: &[u8], f: impl Fn(&[u8]) -> Result<Vec<u8>> + Sync, chunk_items: usize) -> Result<u32> {
    let items = unpack(data)?;
    let chunk_items = chunk_items.max(64);
    let total: usize = if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        items.par_chunks(chunk_items)
            .map(|chunk| chunk.iter().map(|item| f(item).map(|v| v.len()).unwrap_or(0)).sum::<usize>())
            .sum()
    } else {
        items.iter().map(|item| f(item).map(|v| v.len()).unwrap_or(0)).sum()
    };
    Ok(total as u32)
}

// ── Packed input → packed output ──

#[inline]
fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(&items, json_valid_bytes, 512))
}

#[inline]
fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(&items, validate_email_bytes, 4096))
}

#[inline]
fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(&items, validate_uuid_bytes, 4096))
}

#[inline]
fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(&items, validate_ipv4_bytes, 4096))
}

#[inline]
fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(crate::util::validation_bitset_chunked(&items, validate_ipv6_bytes, 4096))
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
    parse_batch_direct(&items, &mut out, |i| Ok(cookie_parse_packed_vec(i)));
    Ok(out)
}

#[inline]
fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    let mut out = Vec::with_capacity(items.len() * 64);
    parse_batch_direct(&items, &mut out, http_parse_request_packed_vec);
    Ok(out)
}

// ── Sync packed batch APIs ──

#[napi] pub fn json_valid_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(json_valid_batch_bytes(input.as_ref())?)) }
#[napi] pub fn validate_email_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(validate_email_batch_bytes(input.as_ref())?)) }
#[napi] pub fn validate_uuid_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(validate_uuid_batch_bytes(input.as_ref())?)) }
#[napi] pub fn validate_ipv4_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(validate_ipv4_batch_bytes(input.as_ref())?)) }
#[napi] pub fn validate_ipv6_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(validate_ipv6_batch_bytes(input.as_ref())?)) }
#[napi] pub fn json_sum_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(json_sum_batch_bytes(input.as_ref())?)) }
#[napi] pub fn query_parse_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(query_parse_batch_bytes(input.as_ref())?)) }
#[napi] pub fn cookie_parse_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(cookie_parse_batch_bytes(input.as_ref())?)) }
#[napi] pub fn http_parse_request_batch_packed(input: Uint8Array) -> Result<Buffer> { Ok(Buffer::from(http_parse_request_batch_bytes(input.as_ref())?)) }

// ── Aggregate sync packed batch APIs ──

#[napi] pub fn json_valid_batch_count_packed(input: Uint8Array) -> Result<u32> { count_batch_data(input.as_ref(), json_valid_bytes, 512) }
#[napi] pub fn validate_email_batch_count_packed(input: Uint8Array) -> Result<u32> { count_batch_data(input.as_ref(), validate_email_bytes, 4096) }
#[napi] pub fn validate_uuid_batch_count_packed(input: Uint8Array) -> Result<u32> { count_batch_data(input.as_ref(), validate_uuid_bytes, 4096) }
#[napi] pub fn validate_ipv4_batch_count_packed(input: Uint8Array) -> Result<u32> { count_batch_data(input.as_ref(), validate_ipv4_bytes, 4096) }
#[napi] pub fn validate_ipv6_batch_count_packed(input: Uint8Array) -> Result<u32> { count_batch_data(input.as_ref(), validate_ipv6_bytes, 4096) }
#[napi] pub fn json_sum_batch_total_packed(input: Uint8Array) -> Result<i64> { sum_ids_batch_data(input.as_ref(), 512) }
#[napi] pub fn query_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> { total_len_batch_data(input.as_ref(), query_parse_packed_vec, 256) }
#[napi] pub fn cookie_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> { total_len_batch_data(input.as_ref(), |i| Ok(cookie_parse_packed_vec(i)), 256) }
#[napi] pub fn http_parse_request_batch_total_len_packed(input: Uint8Array) -> Result<u32> { total_len_batch_data(input.as_ref(), http_parse_request_packed_vec, 256) }

// ── Async packed batch APIs ──

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