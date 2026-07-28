// rust/cookie_parser.rs — v2: NO PRE-SCAN
use crate::util::{trim_ascii_whitespace, write_bytes, write_u32_le, VecWriter};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse cookies into a caller-provided slice (zero-alloc).
pub fn cookie_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() { continue; }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() { continue; }

        write_u32_le(out, &mut pos, name.len() as u32)?;
        write_bytes(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Allocating parser — uses a conservative upper bound to skip the memchr pre-scan.
/// Upper bound: each pair contributes ≤ 8 bytes overhead + original bytes.
/// # pairs ≤ # semicolons + 1 ≤ input.len() + 1.
/// So total ≤ input.len() + 4 + (input.len() + 1) * 8 = 9 * input.len() + 12.
/// We use 9 * input.len() + 16 for safety.
pub fn cookie_parse_packed_vec(input: &[u8]) -> Vec<u8> {
    // ⭐ No pre-scan — eliminates one full pass over the input.
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);

    let mut w = VecWriter::with_capacity(upper_bound);
    let count_pos = w.len();
    w.write_u32(0);

    let mut count = 0u32;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() { continue; }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() { continue; }

        w.write_u32(name.len() as u32);
        w.write_bytes(name);

        w.write_u32(value.len() as u32);
        w.write_bytes(value);

        count += 1;
    }

    w.patch_u32(count_pos, count);
    w.into_bytes()
}

#[napi]
pub fn cookie_parse_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(cookie_parse_packed_vec(input.as_ref())))
}

#[napi]
pub fn cookie_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, cookie_parse_packed_into_slice)
}