// rust/util/batch/core.rs — packed-buffer batch routing + domain helpers.
//
// The reusable plumbing behind the `*_batch_packed` napi APIs (in `api.rs`):
// every helper takes a packed `[u32 count]{[u32 len][bytes]}` buffer and
// produces the packed/aggregate result. Serial paths iterate `PackedIter`
// zero-alloc (no `Vec<&[u8]>` materialization); parallel paths materialize the
// `unpack` Vec and delegate to the generic `util::batch_core` helpers (which
// own the rayon chunking). Both paths are byte-identical.
//
// Note: signatures use napi `Result` (legacy), so this module depends on napi
// types even though it performs no JS marshaling.

use napi::bindgen_prelude::*;

use crate::json::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::packed::PackedIter;
use crate::util::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};
use crate::util::{count_batch, should_parallelize, sum_batch_i64, total_bytes, unpack};

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
pub(crate) fn sum_batch_serial(data: &[u8], f: impl Fn(&[u8]) -> i64) -> Result<Vec<u8>> {
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
pub(crate) fn run_sum_batch(data: &[u8], f: impl Fn(&[u8]) -> i64 + Sync) -> Result<Vec<u8>> {
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
pub(crate) fn bitset_serial(data: &[u8], f: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>> {
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
        Ok(crate::util::validation_bitset_chunked(
            &items,
            f,
            chunk_items,
        ))
    } else {
        bitset_serial(data, f)
    }
}

/// Serial byte-map over a packed buffer — writes `[u32 len][bytes]` per item
/// directly, skipping the `unpack` Vec. Single computation per item.
#[inline]
pub(crate) fn bytes_map_serial(data: &[u8], f: impl Fn(&[u8]) -> Vec<u8>) -> Result<Vec<u8>> {
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
        let results: Vec<Vec<u8>> = items.par_iter().enumerate().map(|(i, c)| f(c, i)).collect();
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
pub(crate) fn hmac_sha256_batch_bytes(data: &[u8], key: &aws_lc_rs::hmac::Key) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| {
        let tag = aws_lc_rs::hmac::sign(key, v);
        let mut sig = [0u8; 64];
        crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig);
        sig.to_vec()
    })
}

/// Packed HMAC-SHA256 verify batch (two packed lists: data + hex sigs, zipped)
/// → bitset. Key compiled once.
#[inline]
pub(crate) fn hmac_sha256_verify_batch_bytes(
    data: &[u8],
    sigs: &[u8],
    key: &aws_lc_rs::hmac::Key,
) -> Result<Vec<u8>> {
    let count = PackedIter::new(data)?
        .len()
        .min(PackedIter::new(sigs)?.len());
    let mut out = Vec::with_capacity(4 + count.div_ceil(8));
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + count.div_ceil(8), 0);
    for (i, (item, sig)) in PackedIter::new(data)?
        .zip(PackedIter::new(sigs)?)
        .enumerate()
    {
        let sig = crate::util::bytes::trim_ascii_whitespace(sig);
        if let Some(sig_bytes) = crate::util::bytes::hex_decode_32(sig) {
            if aws_lc_rs::hmac::verify(key, item, &sig_bytes).is_ok() {
                out[4 + (i >> 3)] |= 1 << (i & 7);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
#[inline]
pub(crate) fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::query_parser::query_parse_packed_vec(input)
}

#[inline]
fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    crate::http::http_parser::http_parse_request_packed_vec(input)
}

/// Packed sign-cookie batch (signed cookie bytes out) — key compiled once.
#[inline]
pub(crate) fn sign_cookie_batch_bytes(data: &[u8], secret: &[u8]) -> Result<Vec<u8>> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    bytes_map_serial(data, |v| {
        crate::crypto::cookie_sign::sign_cookie_bytes(v, &key)
    })
}

#[inline]
pub(crate) fn count_batch_data(
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
pub(crate) fn sum_ids_batch_data(data: &[u8], chunk_items: usize) -> Result<i64> {
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
pub(crate) fn total_len_batch_data(
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

// ── Packed input → packed output (domain helpers) ──

#[inline]
pub(crate) fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, json_valid_bytes, 512)
}

#[inline]
pub(crate) fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_email_bytes, 4096)
}

#[inline]
pub(crate) fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_uuid_bytes, 4096)
}

#[inline]
pub(crate) fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_ipv4_bytes, 4096)
}

#[inline]
pub(crate) fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_bitset_batch(data, validate_ipv6_bytes, 4096)
}

#[inline]
pub(crate) fn json_sum_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    run_sum_batch(data, |item| json_sum_ids_bytes(item).unwrap_or(0))
}

/// Shared scratch writer for the packed-pairs parse batches (query/cookie/form).
///
/// Each item parses via its `*_into_slice` writer into ONE reused scratch buffer
/// (grown to the worst-case `9·len + 16` bound) instead of allocating a fresh
/// `vec![0u8; 9·len + 16]` per item (which the allocating `*_packed_vec` helpers
/// do). A malformed item emits an empty result frame — byte-parity with the
/// old `*_packed_vec(...).unwrap_or_default()` behavior.
#[inline]
pub(crate) fn parse_pairs_batch(
    data: &[u8],
    parse: impl Fn(&[u8], &mut [u8]) -> Result<usize>,
) -> Result<Vec<u8>> {
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    let mut scratch: Vec<u8> = Vec::new();
    for item in iter {
        let cap = item.len().saturating_mul(9).saturating_add(16);
        if scratch.len() < cap {
            scratch.resize(cap, 0);
        }
        match parse(item, &mut scratch) {
            Ok(written) => {
                out.extend_from_slice(&(written as u32).to_le_bytes());
                out.extend_from_slice(&scratch[..written]);
            }
            // Malformed %XX → empty result frame (parity with `unwrap_or_default`).
            Err(_) => out.extend_from_slice(&0u32.to_le_bytes()),
        }
    }
    Ok(out)
}

#[inline]
pub(crate) fn query_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    parse_pairs_batch(
        data,
        crate::http::query_parser::query_parse_packed_into_slice,
    )
}

#[inline]
pub(crate) fn cookie_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    parse_pairs_batch(
        data,
        crate::http::cookie_parser::cookie_parse_packed_into_slice,
    )
}

#[inline]
pub(crate) fn form_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    parse_pairs_batch(
        data,
        crate::http::query_parser::query_parse_packed_into_slice,
    )
}

#[inline]
pub(crate) fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| {
        http_parse_request_packed_vec(v).unwrap_or_default()
    })
}

#[inline]
pub(crate) fn hex_encode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    // Direct-write: hex output size is deterministic (2x input), so write each
    // item straight into the shared output Vec — no per-item String/Vec alloc.
    // The nibble loop lives in `util::bytes::hex_encode` (single source).
    let iter = PackedIter::new(data)?;
    let count = iter.len();
    let mut out = Vec::with_capacity(4 + count * 32);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for item in iter {
        let out_len = item.len() * 2;
        out.extend_from_slice(&(out_len as u32).to_le_bytes());
        let start = out.len();
        out.resize(start + out_len, 0);
        crate::util::bytes::hex_encode(item, &mut out[start..start + out_len]);
    }
    Ok(out)
}

#[inline]
pub(crate) fn hex_decode_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    bytes_map_serial(data, |v| {
        crate::crypto::base64::hex_decode_bytes(v)
            .map_err(|e| Error::from_reason(e.to_string()))
            .unwrap_or_default()
    })
}
