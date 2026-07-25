use napi::{Error, Result};
use napi_derive::napi;
use std::sync::OnceLock;
use napi::bindgen_prelude::Uint8Array;

static RAYON_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

#[cfg(target_os = "linux")]
static CORE_IDS: OnceLock<Option<Vec<core_affinity::CoreId>>> = OnceLock::new();

/// Call once at application startup if you want a custom Rayon thread count.
#[napi]
pub fn init_thread_pool(rayon_threads: Option<u32>) -> Result<()> {
    let stored = RAYON_INIT.get_or_init(|| {
        let default_threads = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(2);

        // Leave one core for the Bun event loop if possible.
        let preferred = default_threads.saturating_sub(1).max(1);

        let threads = rayon_threads.unwrap_or(preferred).clamp(1, 8);

        rayon::ThreadPoolBuilder::new()
            .num_threads(threads as usize)
            .stack_size(512 * 1024)
            .thread_name(|i| format!("rust-bench-rayon-{}", i))
            .start_handler(move |id| {
                pin_rayon_thread(id);
            })
            .build_global()
            .map_err(|e| e.to_string())
    });

    match stored {
        Ok(()) => Ok(()),
        Err(msg) => Err(Error::from_reason(msg.clone())),
    }
}

#[cfg(target_os = "linux")]
fn pin_rayon_thread(id: usize) {
    let ids = CORE_IDS.get_or_init(|| core_affinity::get_core_ids());

    if let Some(ids) = ids {
        // Best-effort isolation:
        // leave CPU 0 for the Bun event loop, IRQs, kernel work, etc.
        if ids.len() > 1 {
            let idx = 1 + (id % (ids.len() - 1));
            let _ = core_affinity::set_for_current(ids[idx]);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn pin_rayon_thread(_id: usize) {}

#[napi]
pub fn rayon_num_threads() -> u32 {
    rayon::current_num_threads() as u32
}

#[inline]
pub fn read_u32_le(data: &[u8], offset: usize) -> Result<u32> {
    let slice = data
        .get(offset..offset + 4)
        .ok_or_else(|| Error::from_reason("packed buffer: truncated u32"))?;

    let bytes: [u8; 4] = slice
        .try_into()
        .map_err(|_| Error::from_reason("packed buffer: invalid u32"))?;

    Ok(u32::from_le_bytes(bytes))
}

/// Packed batch input format:
///   [u32 count]
///   repeated count times:
///     [u32 byte_length]
///     [bytes]
pub fn unpack<'a>(data: &'a [u8]) -> Result<Vec<&'a [u8]>> {
    if data.len() < 4 {
        return Err(Error::from_reason("packed buffer: missing count"));
    }

    let count = read_u32_le(data, 0)? as usize;
    let mut offset = 4usize;

    // Minimum valid item is 4 bytes: [u32 len]
    let reserve = count
        .min(data.len() / 4 + 1)
        .min(4_000_000);

    let mut items = Vec::with_capacity(reserve);

    for _ in 0..count {
        let len = read_u32_le(data, offset)? as usize;
        offset += 4;

        let end = offset
            .checked_add(len)
            .ok_or_else(|| Error::from_reason("packed buffer: length overflow"))?;

        if end > data.len() {
            return Err(Error::from_reason("packed buffer: truncated item"));
        }

        items.push(&data[offset..end]);
        offset = end;
    }

    Ok(items)
}
/// Packed batch output format for variable-length byte results.
pub fn pack_byte_results(results: &[Vec<u8>]) -> Vec<u8> {
    let total: usize = results
        .iter()
        .map(|r| 4usize.saturating_add(r.len()))
        .sum();

    let mut out = Vec::with_capacity(4usize.saturating_add(total));

    out.extend_from_slice(&(results.len() as u32).to_le_bytes());

    for r in results {
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(r);
    }

    out
}

#[inline]
pub fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let mut start = 0usize;
    let mut end = bytes.len();

    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }

    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }

    &bytes[start..end]
}

#[inline]
pub fn total_bytes(items: &[&[u8]]) -> usize {
    items.iter().map(|x| x.len()).sum()
}


/// Produce a packed bitset for boolean validation results.
///
/// Output format:
///   [u32 count]
///   [ceil(count/8) bytes of bitset]
///
/// Bit `i` LSB-first within each byte is 1 if `f(items[i])` returned true.
#[inline]
pub fn validation_bitset(items: &[&[u8]], f: impl Fn(&[u8]) -> bool + Sync) -> Vec<u8> {
    let count = items.len();
    let bitset_len = count.div_ceil(8);
    let mut bits = vec![0u8; bitset_len];

    if should_parallelize(count, total_bytes(items)) {
        use rayon::prelude::*;

        bits.par_iter_mut().enumerate().for_each(|(byte_idx, slot)| {
            let start = byte_idx * 8;
            let end = (start + 8).min(count);

            let mut byte = 0u8;

            for (bit, item) in items[start..end].iter().enumerate() {
                if f(item) {
                    byte |= 1 << bit;
                }
            }

            *slot = byte;
        });
    } else {
        for (i, item) in items.iter().enumerate() {
            if f(item) {
                bits[i >> 3] |= 1 << (i & 7);
            }
        }
    }

    let mut out = Vec::with_capacity(4 + bitset_len);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.extend_from_slice(&bits);
    out
}
#[inline]
pub fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[inline]
pub fn ensure_capacity(out: &[u8], pos: usize, additional: usize) -> Result<()> {
    let end = pos
        .checked_add(additional)
        .ok_or_else(|| Error::from_reason("packed output: overflow"))?;

    if end > out.len() {
        return Err(Error::from_reason("packed output: buffer too small"));
    }

    Ok(())
}

#[inline]
pub fn write_u32_le(out: &mut [u8], pos: &mut usize, value: u32) -> Result<()> {
    ensure_capacity(out, *pos, 4)?;
    out[*pos..*pos + 4].copy_from_slice(&value.to_le_bytes());
    *pos += 4;
    Ok(())
}

#[inline]
pub fn write_bytes(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> Result<()> {
    ensure_capacity(out, *pos, bytes.len())?;
    out[*pos..*pos + bytes.len()].copy_from_slice(bytes);
    *pos += bytes.len();
    Ok(())
}


#[inline]
pub fn should_parallelize(items: usize, bytes: usize) -> bool {
    let threads = rayon::current_num_threads().max(1);

    // Be conservative under high concurrent load.
    //
    // For small payloads, FFI + Rayon dispatch cost dominates.
    // For large batches, Rayon helps.
    items >= threads.saturating_mul(256) || bytes >= threads.saturating_mul(256 * 1024)
}


#[inline]
pub fn write_bytes_lowercase(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> Result<()> {
    ensure_capacity(out, *pos, bytes.len())?;

    let start = *pos;
    let end = start + bytes.len();

    out[start..end].copy_from_slice(bytes);
    out[start..end].make_ascii_lowercase();

    *pos = end;
    Ok(())
}


#[inline]
pub fn tokio_join_error(e: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("tokio blocking task failed: {e}"))
}

#[inline]
fn ranges_overlap(a: &[u8], b: &[u8]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }

    let a_start = a.as_ptr() as usize;
    let b_start = b.as_ptr() as usize;

    let a_end = a_start.saturating_add(a.len());
    let b_end = b_start.saturating_add(b.len());

    a_start < b_end && b_start < a_end
}

/// Helper for `*_packed_into` functions.
///
/// napi v3 marks `Uint8Array::as_mut()` as unsafe because it exposes mutable
/// JavaScript-owned memory to Rust.
///
/// This helper:
/// - uses unsafe mutable access for the output buffer,
/// - copies the input if the input/output memory ranges overlap,
/// - otherwise avoids the extra input copy.
#[inline]
pub fn run_packed_into<F>(
    input: &Uint8Array,
    output: &mut Uint8Array,
    f: F,
) -> Result<u32>
where
    F: FnOnce(&[u8], &mut [u8]) -> Result<usize>,
{
    let input_bytes = input.as_ref();

    let overlaps = {
        let output_bytes = output.as_ref();
        ranges_overlap(input_bytes, output_bytes)
    };

    let written = if overlaps {
        // If JS passed overlapping views, copy the input so the parser is not
        // reading from memory that Rust may also be writing.
        let owned_input = input_bytes.to_vec();

        // SAFETY:
        // - This is a synchronous NAPI call.
        // - The output buffer is exclusively borrowed here.
        // - The input has been copied if input/output ranges overlap.
        unsafe { f(&owned_input, output.as_mut())? }
    } else {
        // SAFETY:
        // - This is a synchronous NAPI call.
        // - The output buffer is exclusively borrowed here.
        // - Input/output ranges do not overlap.
        unsafe { f(input_bytes, output.as_mut())? }
    };

    Ok(written as u32)
}