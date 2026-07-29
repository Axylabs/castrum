use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result};
use napi_derive::napi;
use std::sync::OnceLock;

static RAYON_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

#[cfg(target_os = "linux")]
static CORE_IDS: OnceLock<Option<Vec<core_affinity::CoreId>>> = OnceLock::new();

#[napi]
pub fn init_thread_pool(rayon_threads: Option<u32>) -> Result<()> {
    let stored = RAYON_INIT.get_or_init(|| {
        let default_threads = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(2);

        // Leave a little headroom for Bun/internal runtime threads.
        let preferred = default_threads.saturating_sub(1).max(1);

        // Do not hard-cap to 8 by default.
        // If you need a cap, set RUST_BENCH_MAX_RAYON_THREADS.
        let max_threads = std::env::var("RUST_BENCH_MAX_RAYON_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_threads.max(1));

        let threads = rayon_threads
            .unwrap_or(preferred)
            .clamp(1, max_threads.max(1));

        rayon::ThreadPoolBuilder::new()
            .num_threads(threads as usize)
            .stack_size(512 * 1024)
            .thread_name(|i| format!("rust-bench-rayon-{}", i))
            .start_handler(move |id| pin_rayon_thread(id))
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
    if std::env::var_os("RUST_BENCH_PIN_CORES").is_none() {
        return;
    }

    let ids = CORE_IDS.get_or_init(core_affinity::get_core_ids);
    if let Some(ids) = ids {
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

#[derive(Default)]
pub struct VecWriter {
    buf: Vec<u8>,
}

impl VecWriter {
    #[inline(always)]
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    #[inline(always)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    #[inline(always)]
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    #[inline(always)]
    pub fn push(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    #[inline(always)]
    pub fn write_u16(&mut self, value: u16) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    #[inline(always)]
    pub fn write_u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    #[inline(always)]
    pub fn write_u64(&mut self, value: u64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    #[inline(always)]
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    #[inline(always)]
    pub fn write_bytes_ascii_lowercase(&mut self, bytes: &[u8]) {
        let start = self.buf.len();
        self.buf.extend_from_slice(bytes);
        self.buf[start..].make_ascii_lowercase();
    }

    #[inline(always)]
    pub fn patch_u32(&mut self, pos: usize, value: u32) {
        debug_assert!(pos + 4 <= self.buf.len());
        self.buf[pos..pos + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[inline(always)]
    pub fn reserve(&mut self, additional: usize) {
        self.buf.reserve(additional);
    }
}

#[inline(always)]
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
#[inline]
pub fn unpack<'a>(data: &'a [u8]) -> Result<Vec<&'a [u8]>> {
    if data.len() < 4 {
        return Err(Error::from_reason("packed buffer: missing count"));
    }

    let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;

    // Each item requires at least a 4-byte length prefix.
    let max_possible = (data.len() - 4) / 4;
    if count > max_possible {
        return Err(Error::from_reason("packed buffer: impossible item count"));
    }

    let mut offset = 4usize;
    let reserve = count.min(4_000_000);
    let mut items = Vec::with_capacity(reserve);

    for _ in 0..count {
        if offset + 4 > data.len() {
            return Err(Error::from_reason("packed buffer: truncated length"));
        }

        let len = u32::from_le_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;

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

#[inline]
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
pub fn pack_byte_results_direct<F>(items: &[&[u8]], out: &mut Vec<u8>, f: F)
where
    F: Fn(&[u8]) -> Vec<u8> + Sync,
{
    let n = items.len();
    out.reserve(4 + n * 16);
    out.extend_from_slice(&(n as u32).to_le_bytes());

    for item in items {
        let r = f(item);
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(&r);
    }
}

#[inline(always)]
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

#[inline(always)]
pub fn total_bytes(items: &[&[u8]]) -> usize {
    items.iter().map(|x| x.len()).sum()
}

#[inline]
pub fn validation_bitset(items: &[&[u8]], f: impl Fn(&[u8]) -> bool + Sync) -> Vec<u8> {
    validation_bitset_chunked(items, f, 4096)
}

/// Direct-write chunked bitset validator.
#[inline]
pub fn validation_bitset_chunked(
    items: &[&[u8]],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> Vec<u8> {
    let count = items.len();
    let bitset_len = count.div_ceil(8);

    let mut out = Vec::with_capacity(4 + bitset_len);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.resize(4 + bitset_len, 0);

    if count == 0 {
        return out;
    }

    if should_parallelize(count, total_bytes(items)) {
        use rayon::prelude::*;

        let chunk_items = chunk_items.max(64);
        let chunk_bytes = chunk_items.div_ceil(8);
        let bits = &mut out[4..];

        bits.par_chunks_mut(chunk_bytes)
            .enumerate()
            .for_each(|(chunk_idx, chunk)| {
                let start_item = chunk_idx * chunk_bytes * 8;
                let end_item = (start_item + chunk.len() * 8).min(count);
                let start_byte = start_item / 8;

                for i in start_item..end_item {
                    if f(items[i]) {
                        chunk[(i / 8) - start_byte] |= 1 << (i & 7);
                    }
                }
            });
    } else {
        for (i, item) in items.iter().enumerate() {
            if f(item) {
                out[4 + (i >> 3)] |= 1 << (i & 7);
            }
        }
    }

    out
}

#[inline]
pub fn count_batch(
    items: &[&[u8]],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> usize {
    let chunk_items = chunk_items.max(64);

    if should_parallelize(items.len(), total_bytes(items)) {
        use rayon::prelude::*;

        items
            .par_chunks(chunk_items)
            .map(|chunk| chunk.iter().filter(|item| f(item)).count())
            .sum()
    } else {
        items.iter().filter(|item| f(item)).count()
    }
}

#[inline]
pub fn sum_batch_i64(
    items: &[&[u8]],
    f: impl Fn(&[u8]) -> i64 + Sync,
    chunk_items: usize,
) -> i64 {
    let chunk_items = chunk_items.max(64);

    if should_parallelize(items.len(), total_bytes(items)) {
        use rayon::prelude::*;

        items
            .par_chunks(chunk_items)
            .fold(|| 0i64, |acc, chunk| {
                chunk.iter().fold(acc, |a, item| a.saturating_add(f(item)))
            })
            .reduce(|| 0i64, |a, b| a.saturating_add(b))
    } else {
        items
            .iter()
            .fold(0i64, |acc, item| acc.saturating_add(f(item)))
    }
}

#[inline(always)]
pub fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[inline(always)]
pub fn ensure_capacity(out: &[u8], pos: usize, additional: usize) -> Result<()> {
    let end = pos
        .checked_add(additional)
        .ok_or_else(|| Error::from_reason("packed output: overflow"))?;

    if end > out.len() {
        return Err(Error::from_reason("packed output: buffer too small"));
    }

    Ok(())
}

#[inline(always)]
pub fn write_u32_le(out: &mut [u8], pos: &mut usize, value: u32) -> Result<()> {
    ensure_capacity(out, *pos, 4)?;
    out[*pos..*pos + 4].copy_from_slice(&value.to_le_bytes());
    *pos += 4;
    Ok(())
}

#[inline(always)]
pub fn write_bytes(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> Result<()> {
    ensure_capacity(out, *pos, bytes.len())?;
    out[*pos..*pos + bytes.len()].copy_from_slice(bytes);
    *pos += bytes.len();
    Ok(())
}

#[inline(always)]
pub fn write_bytes_lowercase(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> Result<()> {
    ensure_capacity(out, *pos, bytes.len())?;
    let start = *pos;
    let end = start + bytes.len();
    out[start..end].copy_from_slice(bytes);
    out[start..end].make_ascii_lowercase();
    *pos = end;
    Ok(())
}

#[inline(always)]
pub fn should_parallelize(items: usize, bytes: usize) -> bool {
    let threads = rayon::current_num_threads().max(1);
    items >= threads.saturating_mul(2048) || bytes >= threads.saturating_mul(1024 * 1024)
}

#[inline(always)]
pub fn tokio_join_error(e: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("tokio blocking task failed: {e}"))
}

#[inline(always)]
pub fn slices_overlap(a: &[u8], b: &[u8]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }

    let a_start = a.as_ptr() as usize;
    let b_start = b.as_ptr() as usize;
    let a_end = a_start.saturating_add(a.len());
    let b_end = b_start.saturating_add(b.len());

    a_start < b_end && b_start < a_end
}

#[inline]
pub fn run_packed_into<F>(input: &Uint8Array, output: &mut Uint8Array, f: F) -> Result<u32>
where
    F: FnOnce(&[u8], &mut [u8]) -> Result<usize>,
{
    let input_bytes = input.as_ref();

    let overlaps = {
        let output_bytes = output.as_ref();
        slices_overlap(input_bytes, output_bytes)
    };

    let written = if overlaps {
        let owned_input = input_bytes.to_vec();
        unsafe { f(&owned_input, output.as_mut())? }
    } else {
        unsafe { f(input_bytes, output.as_mut())? }
    };

    Ok(written as u32)
}