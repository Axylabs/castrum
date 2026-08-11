// rust/util/packed.rs — Zero-alloc packed-wire iterators + byte writers.
//
// The canonical implementation of the packed batch format
// (`[u32 count] { [u32 len] [bytes] }`) and the low-level byte writers used by
// the parser/output modules. Everything here is allocation-free apart from the
// explicitly-allocating compat helper (`unpack`).

use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result};

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

    /// One-pass, zero-alloc statistics: `(item_count, total_payload_bytes)`.
    ///
    /// Reads the item-count header and scans the per-item length fields
    /// WITHOUT materializing the item slices (unlike [`Self::collect_vec`]).
    /// Used by the batch dispatchers to decide serial-vs-parallel execution.
    #[inline]
    pub fn count_and_total_bytes(&self) -> Result<(usize, usize)> {
        let mut offset = 4usize;
        let mut total = 0usize;
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
            offset += len;
            total += len;
        }
        Ok((self.count, total))
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
pub fn unpack(data: &[u8]) -> Result<Vec<&[u8]>> {
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
        // SAFETY: `output.as_mut()` yields a mutable slice over the napi
        // Uint8Array's backing store. This is sound because (1) no other
        // reference to `output` is live while `f` runs, (2) the input was
        // copied to `owned_input` when it could alias `output` (checked by
        // `slices_overlap` above), and (3) `f`'s writers are capacity-checked
        // (`ingress/output.rs` `write_*` panic instead of writing OOB).
        unsafe { f(&owned_input, output.as_mut())? }
    } else {
        // SAFETY: as above — `input_bytes` is a shared borrow that does not
        // alias `output` (verified by `slices_overlap`), so taking a mutable
        // slice of `output` cannot create aliasing UB.
        unsafe { f(input_bytes, output.as_mut())? }
    };

    Ok(written as u32)
}

// ── Bounds-checked packed OUTPUT writers (reusable-output `_into`) ──
//
// These write the same packed formats as the allocating batch functions but
// into a caller-provided `&mut [u8]`, returning the number of bytes written.
// Capacity is enforced via `write_u32_le`/`ensure_capacity` (Err "packed
// output: buffer too small" instead of an OOB write). The `_into` NAPI
// wrappers route through `run_packed_into` so input/output aliasing is
// detected and the input is copied when they overlap.

/// Write `[u32 count][bits…]` (batch bitset) into `out`. Returns bytes written.
#[inline]
pub fn write_bitset_batch_into<F>(data: &[u8], out: &mut [u8], f: F) -> Result<usize>
where
    F: Fn(&[u8]) -> bool + Sync,
{
    let iter = PackedIter::new(data)?;
    let (count, total) = iter.count_and_total_bytes()?;
    let bitset_len = count.div_ceil(8);
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, count as u32)?;
    ensure_capacity(out, pos, bitset_len)?;
    if crate::util::should_parallelize(count, total) {
        let items = crate::util::unpack(data)?;
        let bits = crate::util::validation_bitset_chunked(&items, f, 4096);
        out[pos..pos + bitset_len].copy_from_slice(&bits[4..]);
    } else {
        // The pooled output buffer may hold stale bytes — zero the bits first.
        out[pos..pos + bitset_len].fill(0);
        for (i, item) in iter.enumerate() {
            if f(item) {
                out[pos + (i >> 3)] |= 1 << (i & 7);
            }
        }
    }
    Ok(pos + bitset_len)
}

/// Write `[u32 count][i64…]` (batch i64 array) into `out`. Returns bytes written.
#[inline]
pub fn write_sum_batch_into<F>(data: &[u8], out: &mut [u8], f: F) -> Result<usize>
where
    F: Fn(&[u8]) -> i64 + Sync,
{
    let iter = PackedIter::new(data)?;
    let (count, total) = iter.count_and_total_bytes()?;
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, count as u32)?;
    ensure_capacity(out, pos, count.saturating_mul(8))?;
    if crate::util::should_parallelize(count, total) {
        use rayon::prelude::*;
        let items = crate::util::unpack(data)?;
        let sums: Vec<i64> = items.par_iter().map(|item| f(item)).collect();
        for (i, s) in sums.iter().enumerate() {
            out[pos + i * 8..pos + (i + 1) * 8].copy_from_slice(&s.to_le_bytes());
        }
    } else {
        for (i, item) in iter.enumerate() {
            let s = f(item);
            out[pos + i * 8..pos + (i + 1) * 8].copy_from_slice(&s.to_le_bytes());
        }
    }
    Ok(pos + count.saturating_mul(8))
}

/// Write `[u32 count][u32…]` (batch u32 array, e.g. crc32) into `out`.
/// Returns bytes written.
#[inline]
pub fn write_u32_batch_into<F>(data: &[u8], out: &mut [u8], f: F) -> Result<usize>
where
    F: Fn(&[u8]) -> u32 + Sync,
{
    let iter = PackedIter::new(data)?;
    let (count, total) = iter.count_and_total_bytes()?;
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, count as u32)?;
    ensure_capacity(out, pos, count.saturating_mul(4))?;
    if crate::util::should_parallelize(count, total) {
        use rayon::prelude::*;
        let items = crate::util::unpack(data)?;
        let vals: Vec<u32> = items.par_iter().map(|item| f(item)).collect();
        for (i, v) in vals.iter().enumerate() {
            out[pos + i * 4..pos + (i + 1) * 4].copy_from_slice(&v.to_le_bytes());
        }
    } else {
        for (i, item) in iter.enumerate() {
            let v = f(item);
            out[pos + i * 4..pos + (i + 1) * 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    Ok(pos + count.saturating_mul(4))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed_from(items: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(items.len() as u32).to_le_bytes());
        for item in items {
            out.extend_from_slice(&(item.len() as u32).to_le_bytes());
            out.extend_from_slice(item);
        }
        out
    }

    #[test]
    fn packed_iter_roundtrip() {
        let buf = packed_from(&[b"a", b"", b"hello", b"w\x00\xff"]);
        let iter = PackedIter::new(&buf).unwrap();
        assert_eq!(iter.len(), 4);
        let items: Vec<&[u8]> = iter.collect();
        assert_eq!(
            items,
            vec![&b"a"[..], &b""[..], &b"hello"[..], &b"w\x00\xff"[..]]
        );
    }

    #[test]
    fn packed_iter_empty() {
        let buf = packed_from(&[]);
        let iter = PackedIter::new(&buf).unwrap();
        assert!(iter.is_empty());
        assert_eq!(iter.len(), 0);
        assert!(iter.collect_vec().unwrap().is_empty());
        assert!(unpack(&buf).unwrap().is_empty());
    }

    #[test]
    fn packed_iter_missing_count_is_error() {
        assert!(PackedIter::new(b"").is_err());
        assert!(PackedIter::new(b"\x01\x02").is_err());
        // Claimed count is impossible for a 4-byte-only buffer.
        assert!(PackedIter::new(&[1, 0, 0, 0]).is_err());
    }

    #[test]
    fn packed_iter_truncated_item() {
        let mut buf = packed_from(&[b"abc", b"defg"]);
        buf.truncate(buf.len() - 1); // cut into the last item
        // The Iterator stops silently on a malformed tail…
        let iter = PackedIter::new(&buf).unwrap();
        let items: Vec<&[u8]> = iter.collect();
        assert_eq!(items, vec![b"abc"]);
        // …while the validating collect_vec/unpack report it.
        assert!(unpack(&buf).is_err());
    }

    #[test]
    fn write_helpers_capacity_checks() {
        let mut out = [0u8; 8];
        let mut pos = 0usize;
        write_u32_le(&mut out, &mut pos, 7).unwrap();
        write_bytes(&mut out, &mut pos, b"abcd").unwrap();
        assert_eq!(pos, 8);
        // One byte over the end → error, position unchanged.
        assert!(write_bytes(&mut out, &mut pos, b"e").is_err());
        assert_eq!(pos, 8);
        // Overflow path.
        assert!(ensure_capacity(&out, usize::MAX, 4).is_err());
        // Lowercase writer is one-pass and capacity-checked.
        let mut small = [0u8; 2];
        assert!(write_bytes_lowercase(&mut small, &mut 0usize, b"abc").is_err());
        let mut out2 = [0u8; 3];
        let mut p2 = 0usize;
        write_bytes_lowercase(&mut out2, &mut p2, b"AbC").unwrap();
        assert_eq!(&out2, b"abc");
        assert_eq!(p2, 3);
    }

    #[test]
    fn slices_overlap_cases() {
        let a = [1u8, 2, 3, 4];
        let b = [5u8, 6];
        assert!(!slices_overlap(&a, &b));
        // Overlapping views of one backing buffer.
        assert!(slices_overlap(&a[0..3], &a[2..4]));
        assert!(slices_overlap(&a, &a[1..2]));
        assert!(slices_overlap(&a[2..], &a[0..3]));
        // Empty slices never overlap.
        assert!(!slices_overlap(&a[0..0], &a));
        assert!(!slices_overlap(&a, &b[0..0]));
    }
}
