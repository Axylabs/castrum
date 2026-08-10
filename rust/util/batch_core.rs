// rust/util/batch_core.rs — Generic rayon-parallel batch helpers.
//
// The shared patterns for "run a predicate/map over many byte items" with an
// automatic serial-vs-parallel decision. Feature modules keep their own
// zero-alloc direct-write loops where they exist deliberately; these helpers
// cover the bitset / count / sum / map-to-bytes shapes.

use crate::util::threadpool::should_parallelize;

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
            .fold(
                || 0i64,
                |acc, chunk| {
                    chunk
                        .iter()
                        .fold(acc, |a, item| a.saturating_add(f(item.as_ref())))
                },
            )
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Item count that reliably crosses `should_parallelize`'s item threshold
    /// regardless of the ambient rayon pool size, forcing the parallel branch.
    fn parallel_len() -> usize {
        rayon::current_num_threads().max(1).saturating_mul(2048) + 64
    }

    #[test]
    fn count_batch_matches_manual() {
        let items: Vec<&[u8]> = vec![b"a", b"bb", b"c", b"dd", b""];
        assert_eq!(count_batch(&items, |x| x.len() == 1, 64), 2);
        assert_eq!(count_batch(&items, |x| x.is_empty(), 64), 1);
        assert_eq!(count_batch(&items, |_| true, 64), 5);
        assert_eq!(count_batch(&items, |_| false, 64), 0);
    }

    #[test]
    fn count_batch_parallel_matches_expected() {
        let n = parallel_len();
        let items: Vec<Vec<u8>> = (0..n).map(|_| vec![b'x']).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        assert_eq!(count_batch(&refs, |x| x[0] == b'x', 64), n);
        assert_eq!(count_batch(&refs, |x| x[0] == b'y', 64), 0);
    }

    #[test]
    fn validation_bitset_layout() {
        let items: Vec<&[u8]> = vec![b"a", b"bb", b"c", b"dd", b""];
        // Predicate len==1 → items 0 and 2 → bits 0b0000_0101.
        let bits = validation_bitset_chunked(&items, |x| x.len() == 1, 64);
        assert_eq!(&bits[..4], &5u32.to_le_bytes());
        assert_eq!(bits[4], 0b0000_0101);
        assert_eq!(bits.len(), 4 + 1);
    }

    #[test]
    fn validation_bitset_parallel_all_set() {
        let n = parallel_len();
        let items: Vec<Vec<u8>> = (0..n).map(|_| vec![b'x']).collect();
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let bits = validation_bitset_chunked(&refs, |x| x[0] == b'x', 64);
        assert_eq!(&bits[..4], &(n as u32).to_le_bytes());
        let set: usize = bits[4..].iter().map(|b| b.count_ones() as usize).sum();
        assert_eq!(set, n);
    }

    #[test]
    fn validation_bitset_empty() {
        let bits = validation_bitset_chunked::<&[u8]>(&[], |_| true, 64);
        assert_eq!(bits, vec![0u8; 4]);
    }

    #[test]
    fn sum_batch_matches_manual() {
        let items: Vec<&[u8]> = vec![b"a", b"bb", b"ccc"];
        assert_eq!(sum_batch_i64(&items, |x| x.len() as i64, 64), 6);
    }

    #[test]
    fn sum_batch_saturates() {
        let items: Vec<Vec<u8>> = vec![vec![0u8; 8], vec![0u8; 8]];
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        assert_eq!(sum_batch_i64(&refs, |_| i64::MAX, 64), i64::MAX);
        assert_eq!(sum_batch_i64(&refs, |_| i64::MIN, 64), i64::MIN);
    }
}
