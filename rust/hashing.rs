use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};

#[napi]
pub fn crc32(input: Uint8Array) -> u32 {
    crc32fast::hash(input.as_ref())
}

#[napi(js_name = "fnv1a64")]
pub fn fnv1a64(input: Uint8Array) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    input
        .as_ref()
        .iter()
        .fold(OFFSET_BASIS, |hash, &b| {
            (hash ^ u64::from(b)).wrapping_mul(PRIME)
        })
}

/// Packed batch CRC32.
///
/// Input format:
///   [u32 count]
///   repeated:
///     [u32 len]
///     [bytes]
///
/// Output format:
///   [u32 count]
///   repeated:
///     [u32 crc]
#[napi]
pub fn crc32_batch_packed(input: Uint8Array) -> Result<Buffer> {
    let items = unpack(input.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 4);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;

        let crcs: Vec<u32> = items
            .par_iter()
            .map(|item| crc32fast::hash(item))
            .collect();

        for crc in crcs {
            out.extend_from_slice(&crc.to_le_bytes());
        }
    } else {
        for item in items {
            let crc = crc32fast::hash(item);
            out.extend_from_slice(&crc.to_le_bytes());
        }
    }

    Ok(Buffer::from(out))
}