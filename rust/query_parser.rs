use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::util::{ensure_capacity, hex_val, write_u32_le};

/// Legacy JSON parser.
///
/// Deprecated for hot paths.
pub fn query_parse_vec(input: &[u8]) -> Result<Vec<u8>> {
    use serde_json::{Map, Value};

    let mut params = Map::new();

    for (key, value) in form_urlencoded::parse(input) {
        let key = key.into_owned();
        let value = Value::String(value.into_owned());

        match params.get_mut(&key) {
            Some(Value::Array(arr)) => arr.push(value),
            Some(existing) => {
                let first = existing.clone();
                *existing = Value::Array(vec![first, value]);
            }
            None => {
                params.insert(key, value);
            }
        }
    }

    let mut out = Vec::with_capacity(input.len().saturating_mul(2).saturating_add(2));

    sonic_rs::to_writer(&mut out, &Value::Object(params))
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(out)
}

#[napi]
pub fn query_parse(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(query_parse_vec(input.as_ref())?))
}

fn write_decoded_form_component(src: &[u8], out: &mut [u8], pos: &mut usize) -> Result<()> {
    let len_pos = *pos;

    // Placeholder length.
    write_u32_le(out, pos, 0)?;

    let start = *pos;
    let mut i = 0usize;

    while i < src.len() {
        match src[i] {
            b'+' => {
                ensure_capacity(out, *pos, 1)?;
                out[*pos] = b' ';
                *pos += 1;
                i += 1;
            }
            b'%' => {
                if i + 2 >= src.len() {
                    return Err(Error::from_reason(
                        "invalid percent-encoded sequence: missing bytes",
                    ));
                }

                let hi = hex_val(src[i + 1]).ok_or_else(|| {
                    Error::from_reason("invalid percent-encoded sequence: bad high nibble")
                })?;

                let lo = hex_val(src[i + 2]).ok_or_else(|| {
                    Error::from_reason("invalid percent-encoded sequence: bad low nibble")
                })?;

                ensure_capacity(out, *pos, 1)?;
                out[*pos] = (hi << 4) | lo;
                *pos += 1;

                i += 3;
            }
            b => {
                ensure_capacity(out, *pos, 1)?;
                out[*pos] = b;
                *pos += 1;
                i += 1;
            }
        }
    }

    let decoded_len = (*pos - start) as u32;

    out[len_pos..len_pos + 4].copy_from_slice(&decoded_len.to_le_bytes());

    Ok(())
}

/// Parse application/x-www-form-urlencoded bytes into packed pairs.
///
/// Output format:
///
///   [u32 count]
///   repeat count times:
///     [u32 key_len]
///     [decoded key bytes]
///     [u32 value_len]
///     [decoded value bytes]
pub fn query_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;

    // Placeholder count.
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() {
            continue;
        }

        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[] as &[u8]),
        };

        write_decoded_form_component(key, out, &mut pos)?;
        write_decoded_form_component(value, out, &mut pos)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());

    Ok(pos)
}

#[napi]
pub fn query_parse_packed(input: Uint8Array) -> Result<Buffer> {
    let input = input.as_ref();

    // Worst-case overhead is bounded by length prefixes per pair.
    // Use a conservative allocation.
    let mut out = vec![0u8; input.len().saturating_mul(5).saturating_add(4)];

    let written = query_parse_packed_into_slice(input, &mut out)?;

    out.truncate(written);

    Ok(Buffer::from(out))
}

#[napi]
pub fn query_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    let written = query_parse_packed_into_slice(input.as_ref(), output.as_mut())?;
    Ok(written as u32)
}