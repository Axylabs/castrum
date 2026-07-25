use napi::bindgen_prelude::*;
use napi_derive::napi;

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

#[inline]
fn hex_encode(bytes: &[u8], out: &mut [u8]) {
    for (i, b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_LOWER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_LOWER[(b & 0x0f) as usize];
    }
}

#[napi]
pub fn random_token(byte_len: u32) -> Result<Buffer> {
    let len = byte_len as usize;

    if len == 32 {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;

        let mut out = [0u8; 64];
        hex_encode(&bytes, &mut out);

        return Ok(Buffer::from(out.to_vec()));
    }

    let out_len = len
        .checked_mul(2)
        .ok_or_else(|| Error::from_reason("byte_len too large"))?;

    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;

    let mut out = vec![0u8; out_len];
    hex_encode(&bytes, &mut out);

    Ok(Buffer::from(out))
}