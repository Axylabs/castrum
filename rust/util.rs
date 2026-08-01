use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result};
use napi_derive::napi;
use std::borrow::Cow;
use std::sync::OnceLock;
use memchr;

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
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    #[inline(always)]
    pub fn push(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    #[inline(always)]
    pub fn write_u32(&mut self, value: u32) {
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

// ── Zero-Alloc Packed Iterator ─────────────────────────────────────

/// A zero-allocation iterator over packed batch buffers.
/// Format: [u32 count] repeated: [u32 len] [bytes]
#[derive(Clone, Copy)]
pub struct PackedIter<'a> {
    data: &'a [u8],
    offset: usize,
    count: usize,
}

impl<'a> PackedIter<'a> {
    /// Create a new `PackedIter` from a packed buffer.
    /// Returns `None` if the buffer is malformed (too short, count impossible).
    #[inline]
    pub fn new(data: &'a [u8]) -> Result<Self> {
        if data.len() < 4 {
            return Err(Error::from_reason("packed buffer: missing count"));
        }

        let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;

        // Validate count is plausible
        let max_possible = (data.len() - 4) / 4;
        if count > max_possible {
            return Err(Error::from_reason("packed buffer: impossible item count"));
        }

        Ok(Self {
            data,
            offset: 4,
            count,
        })
    }

    /// Total number of items (from the header).
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.count
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Get the raw item at a specific index without advancing the iterator.
    /// Returns `None` if index out of bounds or data is incomplete.
    #[inline]
    pub fn get(&self, index: usize) -> Option<&'a [u8]> {
        if index >= self.count {
            return None;
        }

        let mut offset = 4usize;
        for _ in 0..index {
            if offset + 4 > self.data.len() {
                return None;
            }
            let len = u32::from_le_bytes([
                self.data[offset],
                self.data[offset + 1],
                self.data[offset + 2],
                self.data[offset + 3],
            ]) as usize;
            offset += 4 + len;
        }

        // Read the target item
        if offset + 4 > self.data.len() {
            return None;
        }
        let len = u32::from_le_bytes([
            self.data[offset],
            self.data[offset + 1],
            self.data[offset + 2],
            self.data[offset + 3],
        ]) as usize;
        offset += 4;
        if offset + len > self.data.len() {
            return None;
        }
        Some(&self.data[offset..offset + len])
    }

    /// Collect into a `Vec<&[u8]>` (allocating, for compatibility with existing code).
    #[inline]
    pub fn collect_vec(&self) -> Result<Vec<&'a [u8]>> {
        let mut items = Vec::with_capacity(self.count);
        let mut offset = 4usize;
        for _ in 0..self.count {
            if offset + 4 > self.data.len() {
                return Err(Error::from_reason("packed buffer: truncated length"));
            }
            let len = u32::from_le_bytes([
                self.data[offset],
                self.data[offset + 1],
                self.data[offset + 2],
                self.data[offset + 3],
            ]) as usize;
            offset += 4;
            if offset + len > self.data.len() {
                return Err(Error::from_reason("packed buffer: truncated item"));
            }
            items.push(&self.data[offset..offset + len]);
            offset += len;
        }
        Ok(items)
    }
}

impl<'a> Iterator for PackedIter<'a> {
    type Item = &'a [u8];

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.offset >= self.data.len() || self.count == 0 {
            return None;
        }

        if self.offset + 4 > self.data.len() {
            return None;
        }

        let len = u32::from_le_bytes([
            self.data[self.offset],
            self.data[self.offset + 1],
            self.data[self.offset + 2],
            self.data[self.offset + 3],
        ]) as usize;

        self.offset += 4;

        if self.offset + len > self.data.len() {
            return None;
        }

        let item = &self.data[self.offset..self.offset + len];
        self.offset += len;
        self.count -= 1;

        Some(item)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.count, Some(self.count))
    }
}

impl<'a> ExactSizeIterator for PackedIter<'a> {}

// ── Generic batch processing helpers ───────────────────────────────

/// Generic batch validation using `AsRef<[u8]>`.
#[inline]
pub fn validation_bitset_chunked<T: AsRef<[u8]> + Sync>(
    items: &[T],
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

    if should_parallelize(count, total_bytes_ref(items)) {
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
                    if f(items[i].as_ref()) {
                        chunk[(i / 8) - start_byte] |= 1 << (i & 7);
                    }
                }
            });
    } else {
        for (i, item) in items.iter().enumerate() {
            if f(item.as_ref()) {
                out[4 + (i >> 3)] |= 1 << (i & 7);
            }
        }
    }

    out
}

/// Generic batch count using `AsRef<[u8]>`.
#[inline]
pub fn count_batch<T: AsRef<[u8]> + Sync>(
    items: &[T],
    f: impl Fn(&[u8]) -> bool + Sync,
    chunk_items: usize,
) -> usize {
    let chunk_items = chunk_items.max(64);

    if should_parallelize(items.len(), total_bytes_ref(items)) {
        use rayon::prelude::*;

        items
            .par_chunks(chunk_items)
            .map(|chunk| chunk.iter().filter(|item| f(item.as_ref())).count())
            .sum()
    } else {
        items.iter().filter(|item| f(item.as_ref())).count()
    }
}

/// Generic batch sum using `AsRef<[u8]>`.
#[inline]
pub fn sum_batch_i64<T: AsRef<[u8]> + Sync>(
    items: &[T],
    f: impl Fn(&[u8]) -> i64 + Sync,
    chunk_items: usize,
) -> i64 {
    let chunk_items = chunk_items.max(64);

    if should_parallelize(items.len(), total_bytes_ref(items)) {
        use rayon::prelude::*;

        items
            .par_chunks(chunk_items)
            .fold(|| 0i64, |acc, chunk| {
                chunk.iter().fold(acc, |a, item| a.saturating_add(f(item.as_ref())))
            })
            .reduce(|| 0i64, |a, b| a.saturating_add(b))
    } else {
        items
            .iter()
            .fold(0i64, |acc, item| acc.saturating_add(f(item.as_ref())))
    }
}

/// Helper: total bytes for `AsRef<[u8]>` slice.
#[inline(always)]
fn total_bytes_ref<T: AsRef<[u8]>>(items: &[T]) -> usize {
    items.iter().map(|x| x.as_ref().len()).sum()
}

// ── Cow helpers ─────────────────────────────────────────────────────

/// Returns `Cow::Borrowed` when no escaping/decoding is needed,
/// `Cow::Owned` when modifications were necessary.
pub fn cow_decode_url(input: &[u8]) -> Cow<'_, [u8]> {
    if memchr::memchr2(b'+', b'%', input).is_none() {
        return Cow::Borrowed(input);
    }
    // At least some decoding needed; caller should use the _into_slice functions
    Cow::Owned(input.to_vec())
}

/// Returns the underlying data for a Cow, whether owned or borrowed.
#[inline(always)]
pub fn cow_as_slice<'a>(c: &'a Cow<'_, [u8]>) -> &'a [u8] {
    c.as_ref()
}

// ── Legacy unpack (wraps PackedIter for backwards compat) ──────────

/// Packed batch input format:
///   [u32 count]
///   repeated count times:
///     [u32 byte_length]
///     [bytes]
#[inline]
pub fn unpack<'a>(data: &'a [u8]) -> Result<Vec<&'a [u8]>> {
    PackedIter::new(data)?.collect_vec()
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