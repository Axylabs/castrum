// rust/cookie_parser.rs — Unified zero-alloc cookie parser
// Eliminated the _vec variant; all callers use the single _into_slice path.
// Upper-bound pre-allocation for callers that need a Vec.

use crate::util::bytes::cookie_pairs;
use crate::util::{write_bytes, write_u32_le};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse cookies into a caller-provided slice (zero-alloc).
/// Output format: [u32 count] repeated { [u32 name_len] [name] [u32 value_len] [value] }
#[inline]
pub fn cookie_parse_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut pos = 0usize;
    write_u32_le(out, &mut pos, 0)?;

    let mut count = 0u32;

    for (name, value) in cookie_pairs(input) {
        write_u32_le(out, &mut pos, name.len() as u32)?;
        write_bytes(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;

        count += 1;
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(pos)
}

/// Allocate and parse cookies. Uses conservative upper bound to avoid a pre-scan.
#[inline]
pub fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let upper_bound = input.len().saturating_mul(9).saturating_add(16);
    let mut out = vec![0u8; upper_bound];
    let written = cookie_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

#[napi]
pub fn cookie_parse_packed(input: Uint8Array) -> Result<Buffer> {
    cookie_parse_packed_vec(input.as_ref()).map(Buffer::from)
}

#[napi]
pub fn cookie_parse_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, cookie_parse_packed_into_slice)
}
