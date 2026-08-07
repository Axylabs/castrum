// rust/compress.rs — gzip + brotli compression.
//
// Backend-framework feature: response/body compression. gzip uses the
// memory-safe zlib-rs backend of flate2 (pure Rust, no C); brotli uses the pure
// Rust `brotli` crate. Both are heavy per-byte CPU work — ideal Rust offload.
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::io::{Read, Write};

use crate::util::{should_parallelize, total_bytes, unpack};

// ── Pure-Rust core ─────────────────────────────────────────────

/// gzip-compress `data` at the given level (0–9; default 6).
pub fn gzip_compress_bytes(data: &[u8], level: u32) -> std::io::Result<Vec<u8>> {
    let mut enc =
        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data)?;
    enc.finish()
}

/// gzip-decompress `data`.
pub fn gzip_decompress_bytes(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut dec = flate2::read::GzDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)?;
    Ok(out)
}

/// brotli-compress `data` at the given quality (0–11; default 5).
pub fn brotli_compress_bytes(data: &[u8], quality: u32) -> std::io::Result<Vec<u8>> {
    let mut enc = brotli::CompressorWriter::new(Vec::new(), 4096, quality, 22);
    enc.write_all(data)?;
    // into_inner finalizes the stream (BROTLI_OPERATION_FINISH).
    Ok(enc.into_inner())
}

/// brotli-decompress `data`.
pub fn brotli_decompress_bytes(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut dec = brotli::Decompressor::new(data, 4096);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)?;
    Ok(out)
}

// ── NAPI entry points ──────────────────────────────────────────

/// gzip-compress bytes → gzip stream.
#[napi]
pub fn gzip_compress(data: Uint8Array, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(6).min(9);
    gzip_compress_bytes(data.as_ref(), level)
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("gzip compress failed: {e}")))
}

/// gzip-decompress a gzip stream → original bytes.
#[napi]
pub fn gzip_decompress(data: Uint8Array) -> Result<Buffer> {
    gzip_decompress_bytes(data.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("gzip decompress failed: {e}")))
}

/// brotli-compress bytes → brotli stream.
#[napi]
pub fn brotli_compress(data: Uint8Array, quality: Option<u32>) -> Result<Buffer> {
    let quality = quality.unwrap_or(5).min(11);
    brotli_compress_bytes(data.as_ref(), quality)
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("brotli compress failed: {e}")))
}

/// brotli-decompress a brotli stream → original bytes.
#[napi]
pub fn brotli_decompress(data: Uint8Array) -> Result<Buffer> {
    brotli_decompress_bytes(data.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("brotli decompress failed: {e}")))
}

/// Parallel gzip batch: packed `[u32 count]{[u32 len][data]}` in → packed
/// `[u32 count]{[u32 len][gzip]}` out (same level for all items).
#[napi]
pub fn gzip_compress_batch_packed(
    data: Uint8Array,
    level: Option<u32>,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let level = level.unwrap_or(6).min(9);
    packed_batch(items, |chunk| gzip_compress_bytes(chunk, level))
}

/// Parallel gzip-decompress batch: packed gzip streams in → packed originals out.
#[napi]
pub fn gzip_decompress_batch_packed(data: Uint8Array) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    packed_batch(items, gzip_decompress_bytes)
}

/// Parallel brotli batch: packed data in → packed brotli streams out.
#[napi]
pub fn brotli_compress_batch_packed(
    data: Uint8Array,
    quality: Option<u32>,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    let quality = quality.unwrap_or(5).min(11);
    packed_batch(items, |chunk| brotli_compress_bytes(chunk, quality))
}

/// Parallel brotli-decompress batch: packed brotli streams in → packed originals out.
#[napi]
pub fn brotli_decompress_batch_packed(data: Uint8Array) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;
    packed_batch(items, brotli_decompress_bytes)
}

/// Shared direct-write packed batch helper (items that fail produce an empty
/// entry so item counts stay aligned).
fn packed_batch(
    items: Vec<&[u8]>,
    f: impl Fn(&[u8]) -> std::io::Result<Vec<u8>> + Sync,
) -> Result<Buffer> {
    let mut out = Vec::with_capacity(4 + items.len() * 24);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items
            .par_iter()
            .map(|c| f(c).unwrap_or_default())
            .collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for c in items {
            let r = f(c).unwrap_or_default();
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &[u8] = b"the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog.";

    #[test]
    fn gzip_roundtrip() {
        let compressed = gzip_compress_bytes(PAYLOAD, 6).unwrap();
        assert!(compressed.len() < PAYLOAD.len());
        assert_eq!(gzip_decompress_bytes(&compressed).unwrap(), PAYLOAD);
    }

    #[test]
    fn brotli_roundtrip() {
        let compressed = brotli_compress_bytes(PAYLOAD, 5).unwrap();
        assert!(compressed.len() < PAYLOAD.len());
        assert_eq!(brotli_decompress_bytes(&compressed).unwrap(), PAYLOAD);
    }

    #[test]
    fn gzip_handles_empty_and_binary() {
        let empty = gzip_compress_bytes(b"", 6).unwrap();
        assert_eq!(gzip_decompress_bytes(&empty).unwrap(), b"");

        let binary: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = gzip_compress_bytes(&binary, 6).unwrap();
        assert_eq!(gzip_decompress_bytes(&compressed).unwrap(), binary);
    }

    #[test]
    fn brotli_handles_binary() {
        let binary: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = brotli_compress_bytes(&binary, 5).unwrap();
        assert_eq!(brotli_decompress_bytes(&compressed).unwrap(), binary);
    }

    #[test]
    fn gzip_rejects_garbage() {
        assert!(gzip_decompress_bytes(b"not-a-gzip-stream").is_err());
    }
}
