// rust/payload/compress.rs — gzip + brotli compression.
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

// ── Pure-Rust core ─────────────────────────────────────────────

/// gzip-compress `data` at the given level (0–9; default 6).
pub fn gzip_compress_bytes(data: &[u8], level: u32) -> std::io::Result<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data)?;
    enc.finish()
}

/// Default cap on decompressed output (64 MiB) — a decompression-bomb guard.
/// A few hundred compressed bytes can otherwise expand to gigabytes (e.g.
/// zero-run deflate), OOM-aborting the process. Callers that legitimately
/// need more can pass `max_decompressed` to the napi entries.
pub const DEFAULT_MAX_DECOMPRESSED: usize = 64 * 1024 * 1024;

/// gzip-decompress `data`, erroring if the output would exceed `max` bytes.
pub fn gzip_decompress_bytes(data: &[u8], max: usize) -> std::io::Result<Vec<u8>> {
    // Pre-sized output Vec: `read_to_end` on a `Vec::new()` grows the buffer
    // from 32 bytes in doubling steps (each with a realloc + copy) — ~30%
    // overhead on real payloads. The pre-size is bounded by `max` (the
    // decompression-bomb cap) and by `data.len() * 8` (gzip rarely exceeds 8x
    // on small inputs), so it never over-allocates by much.
    let mut out = Vec::with_capacity(data.len().saturating_mul(8).min(max.max(64)));
    let dec = flate2::read::GzDecoder::new(data);
    dec.take(max as u64 + 1).read_to_end(&mut out)?;
    if out.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("gzip output exceeds the {max}-byte decompression cap"),
        ));
    }
    Ok(out)
}

/// brotli-compress `data` at the given quality (0–11; default 5).
pub fn brotli_compress_bytes(data: &[u8], quality: u32) -> std::io::Result<Vec<u8>> {
    let mut enc = brotli::CompressorWriter::new(Vec::new(), 4096, quality, 22);
    enc.write_all(data)?;
    // into_inner finalizes the stream (BROTLI_OPERATION_FINISH).
    Ok(enc.into_inner())
}

/// brotli-decompress `data`, erroring if the output would exceed `max` bytes.
pub fn brotli_decompress_bytes(data: &[u8], max: usize) -> std::io::Result<Vec<u8>> {
    // Same pre-sized output trick as gzip (brotli's internal 4 KiB buffer is
    // kept — larger buffers measured slower on small inputs). Brotli
    // decompression benefits most from avoiding the output Vec's doubling
    // reallocs.
    let mut out = Vec::with_capacity(data.len().saturating_mul(16).min(max.max(64)));
    let dec = brotli::Decompressor::new(data, 4096);
    dec.take(max as u64 + 1).read_to_end(&mut out)?;
    if out.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("brotli output exceeds the {max}-byte decompression cap"),
        ));
    }
    Ok(out)
}

// ── Streaming `*_into` cores (write into a caller buffer, no Vec) ──
// The C-ABI (`bun:ffi`) path uses these so gzip/brotli write directly into the
// caller's JS buffer — no intermediate `Vec` + memcpy. A too-small buffer is
// reported as `TooSmall { needed }` (the EXACT total, computed in a single
// pass) so the JS wrapper allocates once and retries, never re-running the
// whole (de)compression.

/// Error for the streaming `*_into` cores.
#[derive(Debug)]
pub enum StreamError {
    /// Underlying I/O failure (invalid stream, etc.).
    Io(std::io::Error),
    /// The caller's output buffer was too small; `needed` is the exact total
    /// size the stream would produce (the stream was fully consumed once to
    /// count it).
    TooSmall { needed: usize },
    /// The stream's output would exceed the `max` decompression cap.
    ExceedsMax(usize),
}

impl From<std::io::Error> for StreamError {
    fn from(e: std::io::Error) -> Self {
        StreamError::Io(e)
    }
}

/// Write sink that copies into a caller-provided slice up to its capacity and
/// silently COUNTS any overflow — so a one-pass compress can report the exact
/// required size without an intermediate `Vec`.
struct CountingWriter<'a> {
    out: &'a mut [u8],
    pos: usize,
    overflow: usize,
}

impl Write for CountingWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let cap = self.out.len().saturating_sub(self.pos);
        let take = cap.min(buf.len());
        if take > 0 {
            self.out[self.pos..self.pos + take].copy_from_slice(&buf[..take]);
            self.pos += take;
        }
        self.overflow += buf.len() - take;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// gzip-compress `data` directly into `out` (one pass, no intermediate `Vec`).
/// Returns bytes written, or `StreamError::TooSmall { needed }` when `out` is
/// too small (the exact required size, computed without a second pass).
pub fn gzip_compress_into(
    data: &[u8],
    level: u32,
    out: &mut [u8],
) -> std::result::Result<usize, StreamError> {
    let mut w = CountingWriter {
        out,
        pos: 0,
        overflow: 0,
    };
    let mut enc = flate2::write::GzEncoder::new(&mut w, flate2::Compression::new(level));
    enc.write_all(data)?;
    enc.finish()?;
    if w.overflow > 0 {
        return Err(StreamError::TooSmall {
            needed: w.pos + w.overflow,
        });
    }
    Ok(w.pos)
}

/// brotli-compress `data` directly into `out` (one pass, no intermediate `Vec`).
/// Returns bytes written, or `StreamError::TooSmall { needed }` when `out` is
/// too small (the exact required size, computed without a second pass).
pub fn brotli_compress_into(
    data: &[u8],
    quality: u32,
    out: &mut [u8],
) -> std::result::Result<usize, StreamError> {
    let mut w = CountingWriter {
        out,
        pos: 0,
        overflow: 0,
    };
    let mut enc = brotli::CompressorWriter::new(&mut w, 4096, quality, 22);
    enc.write_all(data)?;
    let w2 = enc.into_inner();
    if w2.overflow > 0 {
        return Err(StreamError::TooSmall {
            needed: w2.pos + w2.overflow,
        });
    }
    Ok(w2.pos)
}

/// Shared decompress-into loop: read from a `Read` stream into `out` up to its
/// capacity, bounded by the `max` cap. When `out` is exactly filled, the
/// stream is consumed once more (into a scratch) to detect overflow and report
/// the exact `needed` size.
fn decompress_into<R: Read>(mut dec: R, max: usize, out: &mut [u8]) -> std::result::Result<usize, StreamError> {
    let mut written = 0usize;
    while written < out.len() {
        let n = dec.read(&mut out[written..])?;
        if n == 0 {
            break;
        }
        written += n;
    }
    if written > max {
        return Err(StreamError::ExceedsMax(max));
    }
    if written < out.len() {
        // Stream ended inside the buffer — fits, done.
        return Ok(written);
    }
    // `out` was exactly filled — check whether the stream has more to emit.
    let mut total = written;
    let mut scratch = [0u8; 4096];
    loop {
        let n = dec.read(&mut scratch)?;
        if n == 0 {
            break;
        }
        total += n;
        if total > max {
            return Err(StreamError::ExceedsMax(max));
        }
    }
    if total > written {
        return Err(StreamError::TooSmall { needed: total });
    }
    Ok(written)
}

/// gzip-decompress `data` directly into `out` (one pass, no intermediate `Vec`),
/// bounded by the `max` decompression cap.
pub fn gzip_decompress_into(
    data: &[u8],
    max: usize,
    out: &mut [u8],
) -> std::result::Result<usize, StreamError> {
    decompress_into(flate2::read::GzDecoder::new(data), max, out)
}

/// brotli-decompress `data` directly into `out` (one pass, no intermediate
/// `Vec`), bounded by the `max` decompression cap.
pub fn brotli_decompress_into(
    data: &[u8],
    max: usize,
    out: &mut [u8],
) -> std::result::Result<usize, StreamError> {
    decompress_into(brotli::Decompressor::new(data, 4096), max, out)
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

/// gzip-decompress a gzip stream → original bytes. `max_decompressed` caps the
/// output (default 64 MiB) as a decompression-bomb guard.
#[napi]
pub fn gzip_decompress(data: Uint8Array, max_decompressed: Option<u32>) -> Result<Buffer> {
    let max = max_decompressed
        .map(|m| m as usize)
        .unwrap_or(DEFAULT_MAX_DECOMPRESSED);
    gzip_decompress_bytes(data.as_ref(), max)
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

/// brotli-decompress a brotli stream → original bytes. `max_decompressed` caps
/// the output (default 64 MiB) as a decompression-bomb guard.
#[napi]
pub fn brotli_decompress(data: Uint8Array, max_decompressed: Option<u32>) -> Result<Buffer> {
    let max = max_decompressed
        .map(|m| m as usize)
        .unwrap_or(DEFAULT_MAX_DECOMPRESSED);
    brotli_decompress_bytes(data.as_ref(), max)
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(format!("brotli decompress failed: {e}")))
}

/// gzip batch: packed `[u32 count]{[u32 len][data]}` in → packed
/// `[u32 count]{[u32 len][gzip]}` out (same level for all items).
#[napi]
pub fn gzip_compress_batch_packed(data: Uint8Array, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(6).min(9);
    crate::util::run_packed_batch(data.as_ref(), move |chunk| {
        gzip_compress_bytes(chunk, level).unwrap_or_default()
    })
    .map(Buffer::from)
}

/// gzip-decompress batch: packed gzip streams in → packed originals out. Each
/// item's output is capped by `max_decompressed` (default 64 MiB); an item
/// that exceeds it becomes empty (the batch's fail convention).
#[napi]
pub fn gzip_decompress_batch_packed(
    data: Uint8Array,
    max_decompressed: Option<u32>,
) -> Result<Buffer> {
    let max = max_decompressed
        .map(|m| m as usize)
        .unwrap_or(DEFAULT_MAX_DECOMPRESSED);
    crate::util::run_packed_batch(data.as_ref(), move |chunk| {
        gzip_decompress_bytes(chunk, max).unwrap_or_default()
    })
    .map(Buffer::from)
}

/// brotli batch: packed data in → packed brotli streams out.
#[napi]
pub fn brotli_compress_batch_packed(data: Uint8Array, quality: Option<u32>) -> Result<Buffer> {
    let quality = quality.unwrap_or(5).min(11);
    crate::util::run_packed_batch(data.as_ref(), move |chunk| {
        brotli_compress_bytes(chunk, quality).unwrap_or_default()
    })
    .map(Buffer::from)
}

/// brotli-decompress batch: packed brotli streams in → packed originals out.
/// Each item's output is capped by `max_decompressed` (default 64 MiB); an
/// item that exceeds it becomes empty (the batch's fail convention).
#[napi]
pub fn brotli_decompress_batch_packed(
    data: Uint8Array,
    max_decompressed: Option<u32>,
) -> Result<Buffer> {
    let max = max_decompressed
        .map(|m| m as usize)
        .unwrap_or(DEFAULT_MAX_DECOMPRESSED);
    crate::util::run_packed_batch(data.as_ref(), move |chunk| {
        brotli_decompress_bytes(chunk, max).unwrap_or_default()
    })
    .map(Buffer::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &[u8] = b"the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog.";

    #[test]
    fn gzip_roundtrip() {
        let compressed = gzip_compress_bytes(PAYLOAD, 6).unwrap();
        assert!(compressed.len() < PAYLOAD.len());
        assert_eq!(
            gzip_decompress_bytes(&compressed, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            PAYLOAD
        );
    }

    #[test]
    fn brotli_roundtrip() {
        let compressed = brotli_compress_bytes(PAYLOAD, 5).unwrap();
        assert!(compressed.len() < PAYLOAD.len());
        assert_eq!(
            brotli_decompress_bytes(&compressed, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            PAYLOAD
        );
    }

    #[test]
    fn gzip_handles_empty_and_binary() {
        let empty = gzip_compress_bytes(b"", 6).unwrap();
        assert_eq!(
            gzip_decompress_bytes(&empty, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            b""
        );

        let binary: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = gzip_compress_bytes(&binary, 6).unwrap();
        assert_eq!(
            gzip_decompress_bytes(&compressed, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            binary
        );
    }

    #[test]
    fn brotli_handles_binary() {
        let binary: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = brotli_compress_bytes(&binary, 5).unwrap();
        assert_eq!(
            brotli_decompress_bytes(&compressed, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            binary
        );
    }

    #[test]
    fn gzip_rejects_garbage() {
        assert!(gzip_decompress_bytes(b"not-a-gzip-stream", DEFAULT_MAX_DECOMPRESSED).is_err());
    }

    #[test]
    fn decompression_bomb_is_capped() {
        // A tiny gzip/brotli stream that inflates to a megabyte of zeros must
        // ERROR when the cap is smaller than the output — not OOM the process.
        let bomb = vec![0u8; 1_000_000];
        let gz = gzip_compress_bytes(&bomb, 1).unwrap();
        assert!(gz.len() < bomb.len() / 100, "zero-run gzip should compress hard");
        assert!(gzip_decompress_bytes(&gz, 1024).is_err());

        let br = brotli_compress_bytes(&bomb, 0).unwrap();
        assert!(
            br.len() < bomb.len() / 100,
            "zero-run brotli should compress hard"
        );
        assert!(brotli_decompress_bytes(&br, 1024).is_err());

        // The same streams roundtrip fine within a generous cap.
        assert_eq!(
            gzip_decompress_bytes(&gz, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            bomb
        );
        assert_eq!(
            brotli_decompress_bytes(&br, DEFAULT_MAX_DECOMPRESSED).unwrap(),
            bomb
        );
    }

    #[test]
    fn streaming_roundtrip_matches_bytes() {
        // Streaming compress into an exact-size buffer == the Vec-based core.
        let expected = gzip_compress_bytes(PAYLOAD, 6).unwrap();
        let mut buf = vec![0u8; expected.len()];
        let w = gzip_compress_into(PAYLOAD, 6, &mut buf).expect("exact buffer");
        assert_eq!(w, expected.len());
        assert_eq!(&buf[..w], expected.as_slice());

        let mut out = vec![0u8; PAYLOAD.len() + 64];
        let d = gzip_decompress_into(&expected, DEFAULT_MAX_DECOMPRESSED, &mut out)
            .expect("large buffer");
        assert_eq!(&out[..d], PAYLOAD);

        let bexpected = brotli_compress_bytes(PAYLOAD, 5).unwrap();
        let mut bbuf = vec![0u8; bexpected.len()];
        let bw = brotli_compress_into(PAYLOAD, 5, &mut bbuf).expect("exact buffer");
        assert_eq!(bw, bexpected.len());
        assert_eq!(&bbuf[..bw], bexpected.as_slice());

        let mut bout = vec![0u8; PAYLOAD.len() + 64];
        let bd = brotli_decompress_into(&bexpected, DEFAULT_MAX_DECOMPRESSED, &mut bout)
            .expect("large buffer");
        assert_eq!(&bout[..bd], PAYLOAD);
    }

    #[test]
    fn streaming_too_small_reports_needed() {
        let expected = gzip_compress_bytes(PAYLOAD, 6).unwrap();
        let mut tiny = [0u8; 4];
        match gzip_compress_into(PAYLOAD, 6, &mut tiny) {
            Err(StreamError::TooSmall { needed }) => assert_eq!(needed, expected.len()),
            other => panic!("expected TooSmall, got {other:?}"),
        }
        let mut exact = vec![0u8; expected.len()];
        assert_eq!(
            gzip_compress_into(PAYLOAD, 6, &mut exact).unwrap(),
            expected.len()
        );

        let mut dout = [0u8; 8];
        match gzip_decompress_into(&expected, DEFAULT_MAX_DECOMPRESSED, &mut dout) {
            Err(StreamError::TooSmall { needed }) => assert_eq!(needed, PAYLOAD.len()),
            other => panic!("expected TooSmall, got {other:?}"),
        }

        let bexpected = brotli_compress_bytes(PAYLOAD, 5).unwrap();
        let mut btiny = [0u8; 4];
        match brotli_compress_into(PAYLOAD, 5, &mut btiny) {
            Err(StreamError::TooSmall { needed }) => assert_eq!(needed, bexpected.len()),
            other => panic!("expected TooSmall, got {other:?}"),
        }
        let mut bdout = [0u8; 8];
        match brotli_decompress_into(&bexpected, DEFAULT_MAX_DECOMPRESSED, &mut bdout) {
            Err(StreamError::TooSmall { needed }) => assert_eq!(needed, PAYLOAD.len()),
            other => panic!("expected TooSmall, got {other:?}"),
        }
    }

    #[test]
    fn streaming_decompress_caps_bomb() {
        let bomb = vec![0u8; 1_000_000];
        let gz = gzip_compress_bytes(&bomb, 1).unwrap();
        let mut out = vec![0u8; 2048];
        match gzip_decompress_into(&gz, 1024, &mut out) {
            Err(StreamError::ExceedsMax(_)) => {}
            other => panic!("expected ExceedsMax, got {other:?}"),
        }
        let br = brotli_compress_bytes(&bomb, 0).unwrap();
        let mut bout = vec![0u8; 2048];
        match brotli_decompress_into(&br, 1024, &mut bout) {
            Err(StreamError::ExceedsMax(_)) => {}
            other => panic!("expected ExceedsMax, got {other:?}"),
        }
    }

    #[test]
    fn streaming_handles_empty_and_binary() {
        let empty = gzip_compress_bytes(b"", 6).unwrap();
        let mut out = vec![0u8; 4];
        let d = gzip_decompress_into(&empty, DEFAULT_MAX_DECOMPRESSED, &mut out)
            .expect("empty gzip decompresses to 0 bytes");
        assert_eq!(d, 0);

        let binary: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = gzip_compress_bytes(&binary, 6).unwrap();
        let mut bout = vec![0u8; binary.len() + 64];
        let w = gzip_decompress_into(&compressed, DEFAULT_MAX_DECOMPRESSED, &mut bout).unwrap();
        assert_eq!(&bout[..w], binary.as_slice());
    }
}
