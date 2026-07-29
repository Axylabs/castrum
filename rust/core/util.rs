// rust/core/util.rs — Core utilities: PackedIter, VecWriter, trim, helpers
// Pure Rust, no napi dependencies.

use std::borrow::Cow;

use crate::core::prelude::*;

// ── VecWriter ────────────────────────────────────────────────────

/// A simple byte vector writer that provides efficient write operations.
#[derive(Default)]
pub struct VecWriter {
    buf: Vec<u8>,
}

impl VecWriter {
    /// Create a new `VecWriter` with the given capacity.
    #[inline(always)]
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    /// The current length of the buffer.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    /// Returns `true` if the buffer is empty.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Consume the writer and return the underlying bytes.
    #[inline(always)]
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Push a single byte.
    #[inline(always)]
    pub fn push(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    /// Write a u32 in little-endian.
    #[inline(always)]
    pub fn write_u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    /// Write a byte slice.
    #[inline(always)]
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Write a byte slice as lowercase ASCII.
    #[inline(always)]
    pub fn write_bytes_ascii_lowercase(&mut self, bytes: &[u8]) {
        let start = self.buf.len();
        self.buf.extend_from_slice(bytes);
        self.buf[start..].make_ascii_lowercase();
    }

    /// Patch a u32 at a specific position.
    #[inline(always)]
    pub fn patch_u32(&mut self, pos: usize, value: u32) {
        debug_assert!(pos + 4 <= self.buf.len());
        self.buf[pos..pos + 4].copy_from_slice(&value.to_le_bytes());
    }
}

// ── Read u32 from slice ─────────────────────────────────────────

/// Read a u32 in little-endian at the given offset.
#[inline(always)]
pub fn read_u32_le(data: &[u8], offset: usize) -> CoreResult<u32> {
    let slice = data
        .get(offset..offset + 4)
        .ok_or_else(|| malformed_data("truncated u32", offset))?;

    let bytes: [u8; 4] = slice
        .try_into()
        .map_err(|_| malformed_data("invalid u32", offset))?;

    Ok(u32::from_le_bytes(bytes))
}

// ── Zero-Alloc Packed Iterator ─────────────────────────────────────

/// A zero-allocation iterator over packed batch buffers.
///
/// Format: `[u32 count]` repeated: `[u32 len] [bytes]`
#[derive(Clone, Copy)]
pub struct PackedIter<'a> {
    data: &'a [u8],
    offset: usize,
    count: usize,
}

impl<'a> PackedIter<'a> {
    /// Create a new `PackedIter` from a packed buffer.
    /// Returns `Err` if the buffer is malformed.
    #[inline]
    pub fn new(data: &'a [u8]) -> CoreResult<Self> {
        if data.len() < 4 {
            return Err(malformed_data("packed buffer: missing count", 0));
        }

        let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;

        // Validate count is plausible
        let max_possible = (data.len() - 4) / 4;
        if count > max_possible {
            return Err(malformed_data("packed buffer: impossible item count", 0));
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

    /// Returns `true` if there are no items.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Get the raw item at a specific index without advancing the iterator.
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

    /// Collect into a `Vec<&[u8]>` (allocating, for compatibility).
    #[inline]
    pub fn collect_vec(&self) -> CoreResult<Vec<&'a [u8]>> {
        let mut items = Vec::with_capacity(self.count);
        let mut offset = 4usize;
        for _ in 0..self.count {
            if offset + 4 > self.data.len() {
                return Err(malformed_data("packed buffer: truncated length", offset));
            }
            let len = u32::from_le_bytes([
                self.data[offset],
                self.data[offset + 1],
                self.data[offset + 2],
                self.data[offset + 3],
            ]) as usize;
            offset += 4;
            if offset + len > self.data.len() {
                return Err(malformed_data("packed buffer: truncated item", offset));
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

// ── Trim helpers ───────────────────────────────────────────────────

/// Trim ASCII whitespace from both ends of a byte slice.
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

/// Total bytes in a slice of slices.
#[inline(always)]
pub fn total_bytes(items: &[&[u8]]) -> usize {
    items.iter().map(|x| x.len()).sum()
}

/// Convert a hex digit byte to its numeric value.
#[inline(always)]
pub fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Ensure there is enough capacity in the output buffer.
#[inline(always)]
pub fn ensure_capacity(out: &[u8], pos: usize, additional: usize) -> CoreResult<()> {
    let end = pos
        .checked_add(additional)
        .ok_or_else(|| overflow("packed output"))?;

    if end > out.len() {
        return Err(buffer_too_small(end, out.len()));
    }

    Ok(())
}

/// Write a u32 at the given position and advance the position.
#[inline(always)]
pub fn write_u32_le(out: &mut [u8], pos: &mut usize, value: u32) -> CoreResult<()> {
    ensure_capacity(out, *pos, 4)?;
    out[*pos..*pos + 4].copy_from_slice(&value.to_le_bytes());
    *pos += 4;
    Ok(())
}

/// Write bytes at the given position and advance the position.
#[inline(always)]
pub fn write_bytes(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> CoreResult<()> {
    ensure_capacity(out, *pos, bytes.len())?;
    out[*pos..*pos + bytes.len()].copy_from_slice(bytes);
    *pos += bytes.len();
    Ok(())
}

/// Write bytes as lowercase at the given position.
#[inline(always)]
pub fn write_bytes_lowercase(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> CoreResult<()> {
    ensure_capacity(out, *pos, bytes.len())?;
    let start = *pos;
    let end = start + bytes.len();
    out[start..end].copy_from_slice(bytes);
    out[start..end].make_ascii_lowercase();
    *pos = end;
    Ok(())
}

/// Determine if a batch should be parallelized based on size.
#[inline(always)]
pub fn should_parallelize(items: usize, bytes: usize) -> bool {
    let threads = rayon::current_num_threads().max(1);
    items >= threads.saturating_mul(2048) || bytes >= threads.saturating_mul(1024 * 1024)
}

/// Check if two slices overlap in memory.
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

/// Returns `Cow::Borrowed` when no escaping/decoding is needed.
pub fn cow_decode_url(input: &[u8]) -> Cow<'_, [u8]> {
    if memchr::memchr2(b'+', b'%', input).is_none() {
        return Cow::Borrowed(input);
    }
    // At least some decoding needed; caller should use the _into_slice functions
    Cow::Owned(input.to_vec())
}

/// Pack a batch from individual items into a packed buffer.
///
/// Format: `[u32 count]` repeated `[u32 len] [bytes]`
#[inline]
pub fn pack_batch(items: &[&[u8]]) -> Vec<u8> {
    let total_len: usize = items.iter().map(|i| 4 + i.len()).sum();
    let mut out = Vec::with_capacity(4 + total_len);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for item in items {
        out.extend_from_slice(&(item.len() as u32).to_le_bytes());
        out.extend_from_slice(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vec_writer() {
        let mut w = VecWriter::with_capacity(16);
        w.write_u32(42);
        w.push(b'a');
        w.write_bytes(b"bc");
        assert_eq!(w.len(), 7);
        assert_eq!(w.into_bytes(), vec![42, 0, 0, 0, 97, 98, 99]);
    }

    #[test]
    fn test_packed_iter() {
        let items = vec![b"hello" as &[u8], b"world"];
        let packed = pack_batch(&items);
        let iter = PackedIter::new(&packed).unwrap();
        let collected: Vec<&[u8]> = iter.collect();
        assert_eq!(collected, vec![b"hello" as &[u8], b"world"]);
    }

    #[test]
    fn test_trim() {
        assert_eq!(trim_ascii_whitespace(b"  hello  "), b"hello");
        assert_eq!(trim_ascii_whitespace(b"\t\n foo \r\n"), b"foo");
    }

    #[test]
    fn test_read_u32_le() {
        let data = [0x78, 0x56, 0x34, 0x12];
        assert_eq!(read_u32_le(&data, 0).unwrap(), 0x12345678);
    }
}
