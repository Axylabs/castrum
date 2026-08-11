// rust/http/url_codec.rs — URL percent-encoding
use crate::util::bytes::{decode_percent_at, HEX_UPPER};
use crate::util::{ensure_capacity, write_bytes};
use memchr::memchr;
use napi::bindgen_prelude::*;
use napi_derive::napi;

const fn is_unreserved_char(b: u8) -> bool {
    matches!(b,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
        | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | 0x27 | b'(' | b')'
    )
}

/// 256-entry lookup for RFC 3986 unreserved characters — one table load per
/// byte instead of a chain of range compares on the hot encoding loop.
static UNRESERVED_LUT: [bool; 256] = {
    let mut t = [false; 256];
    let mut i = 0usize;
    while i < 256 {
        t[i] = is_unreserved_char(i as u8);
        i += 1;
    }
    t
};

#[inline(always)]
fn is_unreserved(b: u8) -> bool {
    UNRESERVED_LUT[b as usize]
}

/// Percent-encode a raw byte slice (RFC 3986 unreserved set). Shared by the
/// scalar napi path and the packed batch path.
fn url_encode_bytes(input: &[u8]) -> Vec<u8> {
    // Worst case: every byte is encoded → 3x. Use len + len/4 + 8 for typical.
    let mut out = Vec::with_capacity(input.len() + input.len() / 4 + 8);
    let mut start = 0usize;

    for (i, &b) in input.iter().enumerate() {
        if !is_unreserved(b) {
            out.extend_from_slice(&input[start..i]);
            // ⭐ Batch the 3-byte %XX write — one extend instead of 3 pushes.
            let mut encoded = [b'%', 0, 0];
            encoded[1] = HEX_UPPER[(b >> 4) as usize];
            encoded[2] = HEX_UPPER[(b & 0x0f) as usize];
            out.extend_from_slice(&encoded);
            start = i + 1;
        }
    }

    out.extend_from_slice(&input[start..]);
    out
}

#[napi]
pub fn url_encode(input: Uint8Array) -> Buffer {
    Buffer::from(url_encode_bytes(input.as_ref()))
}

/// Packed percent-encode batch: `[u32 count]{[u32 len][data]}` in →
/// `[u32 count]{[u32 len][encoded]}` out.
#[napi]
pub fn url_encode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    crate::util::run_packed_batch(input.as_ref(), url_encode_bytes).map(Buffer::from)
}

#[napi]
pub fn url_decode(input: Uint8Array) -> Result<Buffer> {
    let (out, saw_high) = url_decode_bytes_vec(input.as_ref())?;
    // The single decode pass already told us whether any output byte is
    // >= 0x80. ASCII output is trivially valid UTF-8, so the full simdutf8
    // validation pass is only needed when a high bit was observed.
    if saw_high {
        simdutf8::basic::from_utf8(&out).map_err(|e| Error::from_reason(e.to_string()))?;
    }
    Ok(Buffer::from(out))
}

/// Packed percent-decode batch (UTF-8 validated). Items that fail decoding
/// (malformed %XX or invalid UTF-8) yield an empty result — skip-on-error,
/// matching the other decode batches.
#[napi]
pub fn url_decode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    crate::util::run_packed_batch(input.as_ref(), |v| match url_decode_bytes_vec(v) {
        Ok((out, saw_high)) => {
            if saw_high && simdutf8::basic::from_utf8(&out).is_err() {
                Vec::new()
            } else {
                out
            }
        }
        Err(_) => Vec::new(),
    })
    .map(Buffer::from)
}

/// Packed strict percent-decode batch (no UTF-8 validation).
#[napi]
pub fn url_decode_bytes_batch_packed(input: Uint8Array) -> Result<Buffer> {
    crate::util::run_packed_batch(input.as_ref(), |v| {
        url_decode_bytes_vec(v).map(|(out, _)| out).unwrap_or_default()
    })
    .map(Buffer::from)
}

pub fn url_encode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    let mut start = 0usize;

    for (i, &b) in input.iter().enumerate() {
        if !is_unreserved(b) {
            write_bytes(out, &mut pos, &input[start..i])?;
            ensure_capacity(out, pos, 3)?;
            out[pos] = b'%';
            out[pos + 1] = HEX_UPPER[(b >> 4) as usize];
            out[pos + 2] = HEX_UPPER[(b & 0x0f) as usize];
            pos += 3;
            start = i + 1;
        }
    }

    write_bytes(out, &mut pos, &input[start..])?;
    Ok(pos)
}

#[napi]
pub fn url_encode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, url_encode_into_slice)
}

#[inline]
fn url_decode_bytes_vec(input: &[u8]) -> Result<(Vec<u8>, bool)> {
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0usize;
    let mut saw_high = false;

    while let Some(rel) = memchr(b'%', &input[pos..]) {
        let i = pos + rel;
        let run = &input[pos..i];
        // Copied runs are passed through verbatim; check them for high bytes.
        if !run.is_ascii() {
            saw_high = true;
        }
        out.extend_from_slice(run);

        let (byte, next) = decode_percent_at(input, i)
            .ok_or_else(|| Error::from_reason("invalid %-encoding: malformed %XX sequence"))?;
        // `%XX` can decode to a non-ASCII byte (e.g. `%C3%A9`); track it.
        if byte >= 0x80 {
            saw_high = true;
        }
        out.push(byte);
        pos = next;
    }

    let tail = &input[pos..];
    if !tail.is_ascii() {
        saw_high = true;
    }
    out.extend_from_slice(tail);
    Ok((out, saw_high))
}

#[napi]
pub fn url_decode_bytes(input: Uint8Array) -> Result<Buffer> {
    let (out, _saw_high) = url_decode_bytes_vec(input.as_ref())?;
    Ok(Buffer::from(out))
}

pub fn url_decode_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    let mut src_pos = 0usize;

    while let Some(rel) = memchr(b'%', &input[src_pos..]) {
        let i = src_pos + rel;
        write_bytes(out, &mut pos, &input[src_pos..i])?;

        let (byte, next) = decode_percent_at(input, i)
            .ok_or_else(|| Error::from_reason("invalid %-encoding: malformed %XX sequence"))?;

        ensure_capacity(out, pos, 1)?;
        out[pos] = byte;
        pos += 1;
        src_pos = next;
    }

    write_bytes(out, &mut pos, &input[src_pos..])?;
    Ok(pos)
}

#[napi]
pub fn url_decode_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, url_decode_into_slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_reserved_and_unreserved() {
        let mut out = vec![0u8; 64];
        let n = url_encode_into_slice(b"/a b?c=d", &mut out).unwrap();
        // '/', space, '?', '=' are all percent-encoded; alphanumerics are not.
        assert_eq!(&out[..n], b"%2Fa%20b%3Fc%3Dd");
    }

    #[test]
    fn url_decode_roundtrip() {
        let mut out = vec![0u8; 64];
        let n = url_decode_into_slice(b"%2Fa%20b%3Fc%3Dd", &mut out).unwrap();
        assert_eq!(&out[..n], b"/a b?c=d");
    }

    #[test]
    fn url_decode_rejects_malformed_percent() {
        let mut out = vec![0u8; 64];
        assert!(url_decode_into_slice(b"%ZZ", &mut out).is_err());
        assert!(url_decode_into_slice(b"%2", &mut out).is_err());
    }
}
