// rust/batch_core.rs — Generic rayon-parallel batch helpers.
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
