// rust/packed.rs — Zero-alloc packed-wire iterators + byte writers.
//
// The canonical implementation of the packed batch format
// (`[u32 count] { [u32 len] [bytes] }`) and the low-level byte writers used by
// the parser/output modules. Everything here is allocation-free apart from the
// explicitly-allocating compat helpers (`unpack`, `VecWriter`).

use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result};

/// Growable byte writer (the allocating packed-buffer builder).
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
pub fn total_bytes(items: &[&[u8]]) -> usize {
    items.iter().map(|x| x.len()).sum()
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
    // One pass: lowercase each byte as it is written (no copy-then-lowercase).
    for (i, &b) in bytes.iter().enumerate() {
        out[*pos + i] = b.to_ascii_lowercase();
    }
    *pos += bytes.len();
    Ok(())
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
