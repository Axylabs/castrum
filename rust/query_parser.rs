// rust/query_parser.rs — v2: NO PRE-SCAN + memchr for %
use crate::util::{ensure_capacity, hex_val, write_bytes, write_u32_le, VecWriter};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[inline]
fn write_decoded_form_component_vec(w: &mut VecWriter, src: &[u8]) -> Result<()> {
    let len_pos = w.len();
    w.write_u32(0);
    let start = w.len();

    // Fast path: no '+' and no '%'.
    if memchr::memchr2(b'+', b'%', src).is_none() {
        w.write_bytes(src);
    } else {
        let mut i = 0usize;
        while i < src.len() {
            match src[i] {
                b'+' => { w.push(b' '); i += 1; }
                b'%' => {
                    if i + 2 >= src.len() {
                        return Err(Error::from_reason("invalid %-encoding: missing bytes"));
                    }
                    let hi = hex_val(src[i + 1])
                        .ok_or_else(|| Error::from_reason("invalid %-encoding: bad hi nibble"))?;
                    let lo = hex_val(src[i + 2])
                        .ok_or_else(|| Error::from_reason("invalid %-encoding: bad lo nibble"))?;
                    w.push((hi << 4) | lo);
                    i += 3;
                }
                b => { w.push(b); i += 1; }
            }
        }
    }

    let decoded_len = (w.len() - start) as u32;
    w.patch_u32(len_pos, decoded_len);
    Ok(())
}

fn write_decoded_form_component(src: &[u8], out: &mut [u8], pos: &mut usize) -> Result<()> {
    let len_pos = *pos;
    write_u32_le(out, pos, 0)?;
    let start = *pos;

    if memchr::memchr2(b'+', b'%', src).is_none() {
        write_bytes(out, pos, src)?;
    } else {
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
                        return Err(Error::from_reason("invalid %-encoding: missing bytes"));
                    }
                    let hi = hex_val(src[i + 1])
                        .ok_or_else(|| Error::from_reason("invalid %-encoding: bad hi nibble"))?;
                    let lo = hex_val(src[i + 2])
                        .ok_or_else(|| Error::from_reason("invalid %-encoding: bad lo nibble"))?;
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
    }

    let decoded_len = (*pos - start) as u32;
    out[len_pos..len_pos + 4].copy_from_slice(&decoded_len.to_le_bytes());
    Ok(())
}

/// Parse application/x-www-form-urlencoded into packed pairs.
pub fn query_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;
    let mut count = 0u32;

    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() { continue; }
        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };
        write_decoded_form_component(key, out, &mut pos)?;
        write_decoded_form_component(value, out, &mut pos)?;
        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Allocating parser — no pre-scan, conservative upper bound.
pub fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut w = VecWriter::with_capacity(upper_bound);
    let count_pos = w.len();
    w.write_u32(0);

    let mut count = 0u32;

    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() { continue; }
        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };
        write_decoded_form_component_vec(&mut w, key)?;
        write_decoded_form_component_vec(&mut w, value)?;
        count += 1;
    }

    w.patch_u32(count_pos, count);
    Ok(w.into_bytes())
}

#[napi]
pub fn query_parse_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(query_parse_packed_vec(input.as_ref())?))
}

#[napi]
pub fn query_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, query_parse_packed_into_slice)
}