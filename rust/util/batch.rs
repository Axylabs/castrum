// rust/util/batch.rs — v2: DIRECT WRITE, NO INTERMEDIATE Vec<Vec<u8>>
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::crypto::hashing::fnv1a64_bytes;
use crate::json::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::packed::PackedIter;
use crate::util::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};
use crate::util::{
    count_batch, should_parallelize, sum_batch_i64, total_bytes, unpack,
    write_bitset_batch_into, write_sum_batch_into,
};

// ── Internal helpers (serial zero-alloc + direct-write variants) ──

/// Direct-write sum batch — eliminates intermediate Vec<i64>.
#[inline]
fn sum_batch_direct(items: &[&[u8]], out: &mut Vec<u8>, f: impl Fn(&[u8]) -> i64 + Sync) {
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
                    let sum = f(item);
                    out_chunk[i * 8..(i + 1) * 8].copy_from_slice(&sum.to_le_bytes());
                }
            });
    } else {
        for (i, item) in items.iter().enumerate() {
            let sum = f(item);
            out_slice[i * 8..(i + 1) * 8].copy_from_slice(&sum.to_le_bytes());
        }
    }
}

/// Zero-alloc serial sum over a packed buffer — no `Vec<&[u8]>` materialization.
#[inline]
fn sum_batch_serial(data: &[u8], f: impl Fn(&[u8]) -> i64) -> Result<Vec<u8>> {
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 8);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + count * 8, 0);
    for (i, item) in iter.enumerate() {
        let sum = f(item);
        out[4 + i * 8..4 + (i + 1) * 8].copy_from_slice(&sum.to_le_bytes());
    }
    Ok(out)
}

/// Shared packed-batch routing prelude.
///
/// Parses the packed buffer once, decides parallel-vs-serial, and materializes
/// the `unpack` Vec ONLY when parallelizing (the serial path iterates `iter`
/// zero-alloc). Returns the iterator (for serial passes), the parallel flag and
/// the unpacked slices (only meaningful when `parallel`). All batch functions
/// route through this so the prelude can never drift.
#[inline]
fn packed_routing<'a>(data: &'a [u8]) -> Result<(PackedIter<'a>, bool, Vec<&'a [u8]>)> {
    let iter = PackedIter::new(data)?;
    let (count, bytes) = iter.count_and_total_bytes()?;
    if should_parallelize(count, bytes) {
        let items = unpack(data)?;
        Ok((iter, true, items))
    } else {
        Ok((iter, false, Vec::new()))
    }
}

/// Route a sum batch: rayon direct-write when the workload justifies it, else a
/// zero-alloc serial pass. Identical `[u32 count][i64…]` output on both paths.
#[inline]
fn run_sum_batch(data: &[u8], f: impl Fn(&[u8]) -> i64 + Sync) -> Result<Vec<u8>> {
    let (iter, parallel, items) = packed_routing(data)?;
    let count = iter.len();
    if parallel {
        let mut out = Vec::with_capacity(4 + count * 8);
        sum_batch_direct(&items, &mut out, f);
        Ok(out)
    } else {
        sum_batch_serial(data, f)
    }
}

/// Zero-alloc serial bitset over a packed buffer — no `Vec<&[u8]>` materialization.
#[inline]
fn bitset_serial(data: &[u8], f: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>> {
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let bitset_len = count.div_ceil(8);
    let mut out = Vec::with_capacity(4 + bitset_len);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + bitset_len, 0);
    for (i, item) in iter.enumerate() {
        if f(item) {
            out[4 + (i >> 3)] |= 1 << (i & 7);
        }
    }
    Ok(out)
}

/// Route a bitset batch: rayon `validation_bitset_chunked` when the workload
/// justifies it, else a zero-alloc serial pass. Identical output on both paths.
#[inline]
pub(crate) fn run_bitset_batch(
    data: &[u8],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> Result<Vec<u8>> {
    let (_iter, parallel, items) = packed_routing(data)?;
    if parallel {
        Ok(crate::util::validation_bitset_chunked(&items, f, chunk_items))
    } else {
        bitset_serial(data, f)
    }
}

/// Serial byte-map over a packed buffer — writes `[u32 len][bytes]` per item
/// directly, skipping the `unpack` Vec. Single computation per item.
#[inline]
fn bytes_map_serial(data: &[u8], f: impl Fn(&[u8]) -> Vec<u8>) -> Result<Vec<u8>> {
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for item in iter {
        let r = f(item);
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(&r);
    }
    Ok(out)
}

/// Generic packed→packed batch: `[u32 count] { [u32 len][bytes] }` in →
/// `[u32 count] { [u32 len][result-bytes] }` out.
///
/// The serial path iterates the packed input directly (zero-alloc — no `unpack`
/// Vec); the rayon path materializes `Vec<&[u8]>` (owned `Send` slices are
/// required for parallel work) and collects per-item results. Both paths write
/// byte-identical output, so callers can't tell which path ran. A mapper that
/// cannot produce a result for an item should return an empty `Vec` so the item
/// count stays aligned — feature modules own that policy (e.g. `unwrap_or_default`).
#[inline]
pub(crate) fn run_packed_batch(
    data: &[u8],
    f: impl Fn(&[u8]) -> Vec<u8> + Sync,
) -> Result<Vec<u8>> {
    let (iter, parallel, items) = packed_routing(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    if parallel {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items.par_iter().map(|c| f(c)).collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for item in iter {
            let r = f(item);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }
    Ok(out)
}

/// Indexed variant of [`run_packed_batch`] for mappers that need the item index
/// (e.g. AEAD batch nonce derivation: nonce = base XOR idx).
#[inline]
pub(crate) fn run_packed_batch_idx(
    data: &[u8],
    f: impl Fn(&[u8], usize) -> Vec<u8> + Sync,
) -> Result<Vec<u8>> {
    let (iter, parallel, items) = packed_routing(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    if parallel {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items
            .par_iter()
            .enumerate()
            .map(|(i, c)| f(c, i))
            .collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for (i, item) in iter.enumerate() {
            let r = f(item, i);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }
    Ok(out)
}

/// Packed HMAC-SHA256 sign batch (hex signatures out) — key compiled once.
#[inline]
fn hmac_sha256_batch_bytes(data: &[u8], key: &aws_lc_rs::hmac::Key) -> Result<Vec<u8>> {
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * (4 + 64));
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for item in iter {
        let tag = aws_lc_rs::hmac::sign(key, item);
        let mut sig = [0u8; 64];
        crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig);
        out.extend_from_slice(&64u32.to_le_bytes());
        out.extend_from_slice(&sig);
    }
    Ok(out)
}

/// Packed HMAC-SHA256 verify batch (two packed lists: data + hex sigs, zipped)
/// → bitset. Key compiled once.
#[inline]
fn hmac_sha256_verify_batch_bytes(
    data: &[u8],
    sigs: &[u8],
    key: &aws_lc_rs::hmac::Key,
) -> Result<Vec<u8>> {
    let count = PackedIter::new(data)?.len().min(PackedIter::new(sigs)?.len());
    let mut out = Vec::with_capacity(4 + count.div_ceil(8));
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + count.div_ceil(8), 0);
    for (i, (item, sig)) in PackedIter::new(data)?.zip(PackedIter::new(sigs)?).enumerate() {
        let sig = crate::util::bytes::trim_ascii_whitespace(sig);
        if let Some(sig_bytes) = crate::util::bytes::hex_decode_32(sig) {
            if aws_lc_rs::hmac::verify(key, item, &sig_bytes).is_ok() {
                out[4 + (i >> 3)] |= 1 << (i & 7);
            }
        }
    }
    Ok(out)
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
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    bytes_map_serial(data, |v| crate::crypto::cookie_sign::sign_cookie_bytes(v, &key))
}

#[inline]
fn count_batch_data(
    data: &[u8],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> Result<u32> {
    let (iter, parallel, items) = packed_routing(data)?;
    if parallel {
        return Ok(count_batch(&items, f, chunk_items) as u32);
    }
    let mut n = 0u32;
    for item in iter {
        if f(item) {
            n += 1;
        }
    }
    Ok(n)
}

#[inline]
fn sum_ids_batch_data(data: &[u8], chunk_items: usize) -> Result<i64> {
    let (iter, parallel, items) = packed_routing(data)?;
    if parallel {
        return Ok(sum_batch_i64(
            &items,
            |item| json_sum_ids_bytes(item).unwrap_or(0),
            chunk_items,
        ));
    }
    let mut total = 0i64;
    for item in iter {
        total = total.saturating_add(json_sum_ids_bytes(item).unwrap_or(0));
    }
    Ok(total)
}

#[inline]
fn total_len_batch_data(
    data: &[u8],
    f: impl Fn(&[u8]) -> Result<Vec<u8>> + Sync,
    chunk_items: usize,
) -> Result<u32> {
    let (iter, parallel, items) = packed_routing(data)?;
    if parallel {
        let chunk_items = chunk_items.max(64);
        use rayon::prelude::*;
        let total: usize = items
            .par_chunks(chunk_items)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|item| f(item).map(|v| v.len()).unwrap_or(0))
                    .sum::<usize>()
            })
            .sum();
        return Ok(total as u32);
    }
    let mut total = 0usize;
    for item in iter {
        total += f(item).map(|v| v.len()).unwrap_or(0);
    }
    Ok(total as u32)
}

// ── Packed input → packed output ──

#[inline]
fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, json_valid_bytes, 512)
}

#[inline]
fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_email_bytes, 4096)
}

#[inline]
fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_uuid_bytes, 4096)
}

#[inline]
fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_ipv4_bytes, 4096)
}

#[inline]
fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_ipv6_bytes, 4096)
}

#[inline]
fn json_sum_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_sum_batch(data, |item| json_sum_ids_bytes(item).unwrap_or(0))
}

#[inline]
fn query_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| query_parse_packed_vec(v).unwrap_or_default())
}

#[inline]
fn cookie_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| cookie_parse_packed_vec(v).unwrap_or_default())
}

#[inline]
fn form_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| form_parse_packed_vec(v).unwrap_or_default())
}

#[inline]
fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| http_parse_request_packed_vec(v).unwrap_or_default())
}

#[inline]
fn hex_encode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    // Direct-write: hex output size is deterministic (2x input), so write each
    // item straight into the shared output Vec — no per-item String/Vec alloc.
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for item in iter {
        let out_len = item.len() * 2;
        out.extend_from_slice(&(out_len as u32).to_le_bytes());
        let start = out.len();
        out.resize(start + out_len, 0);
        let mut pos = 0usize;
        for &b in item {
            out[start + pos] = crate::util::bytes::HEX_LOWER[(b >> 4) as usize];
            out[start + pos + 1] = crate::util::bytes::HEX_LOWER[(b & 0x0f) as usize];
            pos += 2;
        }
    }
    Ok(out)
}

#[inline]
fn hex_decode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| {
        crate::crypto::base64::hex_decode_bytes(v)
            .map_err(|e| Error::from_reason(e.to_string()))
            .unwrap_or_default()
    })
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
pub fn fnv1a64_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(run_sum_batch(input.as_ref(), |item| {
        fnv1a64_bytes(item) as i64
    })?))
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
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    run_bitset_batch(
        data.as_ref(),
        |s| crate::crypto::cookie_sign::verify_cookie_bytes_bool(s, &key),
        4096,
    )
    .map(Buffer::from)
}
#[napi]
pub fn csrf_verify_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    run_bitset_batch(
        data.as_ref(),
        |t| crate::crypto::csrf::csrf_verify_with_key(t, &key),
        4096,
    )
    .map(Buffer::from)
}

// ── HMAC-SHA256 batch (packed) ──

#[napi]
pub fn hmac_sha256_batch_packed(input: Uint8Array, key: Uint8Array) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key.as_ref());
    Ok(Buffer::from(hmac_sha256_batch_bytes(
        input.as_ref(),
        &key,
    )?))
}

#[napi]
pub fn hmac_sha256_verify_batch_packed(
    input: Uint8Array,
    sigs: Uint8Array,
    key: Uint8Array,
) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key.as_ref());
    Ok(Buffer::from(hmac_sha256_verify_batch_bytes(
        input.as_ref(),
        sigs.as_ref(),
        &key,
    )?))
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
    let out = bytes_map_serial(input.as_ref(), move |v| {
        crate::crypto::base64::base64_encode_bytes(v, us, pad)
    })?;
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
    let out = bytes_map_serial(input.as_ref(), move |v| {
        crate::crypto::base64::base64_decode_bytes(v, us, pad)
            .map_err(|e| Error::from_reason(e.to_string()))
            .unwrap_or_default()
    })?;
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

// ── Reusable-output (`_into`) packed batch variants ──
// Write the packed result into a caller-provided buffer and return bytes
// written. Wire format is byte-identical to the allocating variants; the JS
// loader uses these with a pooled output buffer to avoid per-call allocation.
// `run_packed_into` guards against input/output aliasing (copies input when
// they overlap) and every write is capacity-checked.

#[napi]
pub fn json_valid_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_bitset_batch_into(data, out, json_valid_bytes)
    })
}

#[napi]
pub fn validate_email_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_bitset_batch_into(data, out, validate_email_bytes)
    })
}

#[napi]
pub fn validate_uuid_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_bitset_batch_into(data, out, validate_uuid_bytes)
    })
}

#[napi]
pub fn validate_ipv4_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_bitset_batch_into(data, out, validate_ipv4_bytes)
    })
}

#[napi]
pub fn validate_ipv6_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_bitset_batch_into(data, out, validate_ipv6_bytes)
    })
}

#[napi]
pub fn json_sum_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_sum_batch_into(data, out, |item| json_sum_ids_bytes(item).unwrap_or(0))
    })
}

#[napi]
pub fn fnv1a64_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        write_sum_batch_into(data, out, |item| fnv1a64_bytes(item) as i64)
    })
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

    /// Item count that reliably crosses `should_parallelize`'s item threshold,
    /// forcing the rayon branch of the routing helpers.
    fn parallel_item_count() -> usize {
        rayon::current_num_threads().max(1).saturating_mul(2048) + 64
    }

    #[test]
    fn bitset_serial_matches_parallel() {
        let n = parallel_item_count();
        let items: Vec<Vec<u8>> = (0..n).map(|i| vec![b'x'; 1 + (i % 3)]).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let packed = pack_items(&refs);

        let serial = bitset_serial(&packed, |x| x.len() == 1).unwrap();
        let routed = run_bitset_batch(&packed, |x| x.len() == 1, 64).unwrap();
        assert_eq!(serial, routed);
    }

    #[test]
    fn sum_serial_matches_parallel() {
        let n = parallel_item_count();
        let items: Vec<Vec<u8>> = (0..n).map(|i| i.to_string().into_bytes()).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let packed = pack_items(&refs);

        let serial = sum_batch_serial(&packed, |x| x.len() as i64).unwrap();
        let routed = run_sum_batch(&packed, |x| x.len() as i64).unwrap();
        assert_eq!(serial, routed);
    }

    #[test]
    fn bytes_map_serial_matches_direct() {
        let items: Vec<Vec<u8>> = (0..32)
            .map(|i| format!("a={}&b={}", i, i).into_bytes())
            .collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let packed = pack_items(&refs);

        let serial =
            bytes_map_serial(&packed, |v| query_parse_packed_vec(v).unwrap_or_default()).unwrap();

        // Reconstruct the previous unpack + per-item write behavior for parity.
        let unpacked = unpack(&packed).unwrap();
        let mut expected = Vec::new();
        expected.extend_from_slice(&(unpacked.len() as u32).to_le_bytes());
        for item in &unpacked {
            let r = query_parse_packed_vec(item).unwrap_or_default();
            expected.extend_from_slice(&(r.len() as u32).to_le_bytes());
            expected.extend_from_slice(&r);
        }
        assert_eq!(serial, expected);
    }

    #[test]
    fn hmac_batch_matches_scalar() {
        let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret");
        let data = pack_items(&[b"hello", b"world"]);
        let out = hmac_sha256_batch_bytes(&data, &key).unwrap();
        let results = unpack_results(&out);
        assert_eq!(results.len(), 2);
        for (input, result) in [b"hello".as_slice(), b"world".as_slice()]
            .iter()
            .zip(&results)
        {
            let tag = aws_lc_rs::hmac::sign(&key, input);
            let mut sig = [0u8; 64];
            crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig);
            assert_eq!(result.as_slice(), &sig[..]);
        }
    }

    #[test]
    fn hmac_verify_batch_matches_scalar() {
        let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret");
        let mut sig_ok = [0u8; 64];
        let tag = aws_lc_rs::hmac::sign(&key, b"hello");
        crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig_ok);
        let sig_bad = [b'0'; 64];

        let data = pack_items(&[b"hello", b"tampered"]);
        let sigs = pack_items(&[&sig_ok, &sig_bad]);
        let out = hmac_sha256_verify_batch_packed(
            Uint8Array::new(data),
            Uint8Array::new(sigs),
            Uint8Array::new(b"secret".to_vec()),
        )
        .unwrap();
        let bits = out.as_ref();
        assert_eq!(&bits[..4], &2u32.to_le_bytes());
        assert_eq!(bits[4], 0b0000_0001); // item 0 valid, item 1 invalid
    }

    // ── reusable-output (_into) variants ──

    #[test]
    fn bitset_into_matches_allocating() {
        // Force the rayon branch (large count) so serial/parallel parity holds.
        let n = parallel_item_count();
        let items: Vec<Vec<u8>> = (0..n).map(|i| vec![b'x'; 1 + (i % 3)]).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let packed = pack_items(&refs);

        let allocating = run_bitset_batch(&packed, |x| x.len() == 1, 64).unwrap();
        let mut out = vec![0u8; allocating.len()];
        let written = write_bitset_batch_into(&packed, &mut out, |x| x.len() == 1).unwrap();
        assert_eq!(written, allocating.len());
        assert_eq!(&out[..written], &allocating[..]);
    }

    #[test]
    fn bitset_into_zeroes_stale_bytes() {
        let packed = pack_items(&[b"a", b"bb", b"ccc"]);
        let mut out = vec![0xFFu8; 4 + 1]; // stale bytes must be zeroed by writer
        let written = write_bitset_batch_into(&packed, &mut out, |_| false).unwrap();
        assert_eq!(written, 5);
        assert_eq!(&out[..written], &[3, 0, 0, 0, 0]); // count=3, all bits clear
    }

    #[test]
    fn bitset_into_errors_on_small_buffer() {
        let packed = pack_items(&[b"a", b"bb", b"ccc"]);
        let mut out = vec![0u8; 4]; // needs 4 + ceil(3/8) = 5
        assert!(write_bitset_batch_into(&packed, &mut out, |_| true).is_err());
    }

    #[test]
    fn sum_into_matches_allocating() {
        let n = parallel_item_count();
        let items: Vec<Vec<u8>> = (0..n).map(|i| i.to_string().into_bytes()).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let packed = pack_items(&refs);

        let allocating = run_sum_batch(&packed, |x| x.len() as i64).unwrap();
        let mut out = vec![0u8; allocating.len()];
        let written = write_sum_batch_into(&packed, &mut out, |x| x.len() as i64).unwrap();
        assert_eq!(written, allocating.len());
        assert_eq!(&out[..written], &allocating[..]);
    }

    #[test]
    fn u32_into_matches_expected_layout() {
        let packed = pack_items(&[b"a", b"bb", b"ccc"]);
        let mut out = vec![0u8; 4 + 3 * 4];
        let written = crate::util::write_u32_batch_into(&packed, &mut out, |x| x.len() as u32)
            .unwrap();
        assert_eq!(written, 4 + 3 * 4);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 3);
        for (i, x) in [&b"a"[..], b"bb", b"ccc"]
            .iter()
            .enumerate()
        {
            let v = u32::from_le_bytes(out[4 + i * 4..4 + (i + 1) * 4].try_into().unwrap());
            assert_eq!(v as usize, x.len());
        }
    }

    #[test]
    fn validate_email_into_reports_length_and_errors() {
        let data = pack_items(&[b"a@b.com", b"not-an-email"]);
        let out = Uint8Array::new(vec![0u8; 16]);
        let n = validate_email_batch_packed_into(Uint8Array::new(data), out).unwrap();
        assert_eq!(n as usize, 4 + 1); // count + 1-byte bitset for 2 items

        let out2 = Uint8Array::new(vec![0u8; 4]);
        assert!(validate_email_batch_packed_into(
            Uint8Array::new(pack_items(&[b"a@b.com", b"x"])),
            out2,
        )
        .is_err());
    }

    #[test]
    fn fnv1a64_into_matches_allocating() {
        let data = pack_items(&[b"hello", b"world", b""]);
        let allocating = fnv1a64_batch_packed(Uint8Array::new(data.clone())).unwrap();
        let out = Uint8Array::new(vec![0u8; allocating.len()]);
        let n = fnv1a64_batch_packed_into(Uint8Array::new(data), out).unwrap();
        assert_eq!(n as usize, allocating.len());
    }
}
