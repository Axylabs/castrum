use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::util::{trim_ascii_whitespace, write_bytes, write_u32_le};

/// Legacy JSON parser.
///
/// Deprecated for hot paths.
pub fn cookie_parse_vec(input: &[u8]) -> Result<Vec<u8>> {
    use serde_json::{Map, Value};

    let mut cookies = Map::new();

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);

        if pair.is_empty() {
            continue;
        }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(pos) => (&pair[..pos], &pair[pos + 1..]),
            None => (pair, &[] as &[u8]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() {
            continue;
        }

        let name = String::from_utf8_lossy(name).into_owned();
        let value = String::from_utf8_lossy(value).into_owned();

        cookies.insert(name, Value::String(value));
    }

    let mut out = Vec::with_capacity(input.len().saturating_add(16));

    sonic_rs::to_writer(&mut out, &Value::Object(cookies))
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(out)
}

#[napi]
pub fn cookie_parse(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(cookie_parse_vec(input.as_ref())?))
}

/// Parse cookies into packed pairs.
///
/// Output format:
///
///   [u32 count]
///   repeat count times:
///     [u32 key_len]
///     [key bytes]
///     [u32 value_len]
///     [value bytes]
pub fn cookie_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;

    // Placeholder count.
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);

        if pair.is_empty() {
            continue;
        }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(pos) => (&pair[..pos], &pair[pos + 1..]),
            None => (pair, &[] as &[u8]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() {
            continue;
        }

        write_u32_le(out, &mut pos, name.len() as u32)?;
        write_bytes(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());

    Ok(pos)
}

#[napi]
pub fn cookie_parse_packed(input: Uint8Array) -> Result<Buffer> {
    let input = input.as_ref();

    let pair_count = memchr::memchr_iter(b';', input).count() + 1;

    let upper_bound = input
        .len()
        .saturating_add(pair_count.saturating_mul(8))
        .saturating_add(4);

    let mut out = vec![0u8; upper_bound];
    let written = cookie_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);

    Ok(Buffer::from(out))
}

#[napi]
pub fn cookie_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, cookie_parse_packed_into_slice)
}