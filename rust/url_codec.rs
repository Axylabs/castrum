use napi::bindgen_prelude::*;
use napi_derive::napi;
use memchr::memchr;

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

#[inline(always)]
fn is_unreserved(b: u8) -> bool {
    matches!(
        b,
        b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | 0x27
            | b'('
            | b')'
    )
}

#[inline(always)]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[napi]
pub fn url_encode(input: Uint8Array) -> Buffer {
    let input = input.as_ref();

    let mut out = Vec::with_capacity(input.len() + input.len() / 4 + 8);
    let mut start = 0usize;

    for (i, &b) in input.iter().enumerate() {
        if !is_unreserved(b) {
            out.extend_from_slice(&input[start..i]);
            out.push(b'%');
            out.push(HEX_UPPER[(b >> 4) as usize]);
            out.push(HEX_UPPER[(b & 0x0f) as usize]);
            start = i + 1;
        }
    }

    out.extend_from_slice(&input[start..]);
    Buffer::from(out)
}

#[napi]
pub fn url_decode(input: Uint8Array) -> Result<Buffer> {
    let input = input.as_ref();

    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0usize;

    while let Some(rel) = memchr(b'%', &input[pos..]) {
        let i = pos + rel;

        out.extend_from_slice(&input[pos..i]);

        if i + 2 >= input.len() {
            return Err(Error::from_reason(
                "Invalid percent-encoded sequence: missing bytes",
            ));
        }

        let hi = hex_val(input[i + 1]).ok_or_else(|| {
            Error::from_reason("Invalid percent-encoded sequence: bad high nibble")
        })?;

        let lo = hex_val(input[i + 2]).ok_or_else(|| {
            Error::from_reason("Invalid percent-encoded sequence: bad low nibble")
        })?;

        out.push((hi << 4) | lo);
        pos = i + 3;
    }

    out.extend_from_slice(&input[pos..]);

    simdutf8::basic::from_utf8(&out)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(Buffer::from(out))
}