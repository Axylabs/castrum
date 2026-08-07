// rust/random_token.rs — random hex tokens (16/32/64 bytes use stack buffers)
use crate::bytes::hex_encode;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn random_token(byte_len: u32) -> Result<Buffer> {
    let len = byte_len as usize;

    // ⭐ Common sizes (16, 32, 64) use stack buffers — no heap alloc.
    match len {
        16 => {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut out = [0u8; 32];
            hex_encode(&bytes, &mut out);
            Ok(Buffer::from(out.to_vec()))
        }
        32 => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut out = [0u8; 64];
            hex_encode(&bytes, &mut out);
            Ok(Buffer::from(out.to_vec()))
        }
        64 => {
            let mut bytes = [0u8; 64];
            getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut out = [0u8; 128];
            hex_encode(&bytes, &mut out);
            Ok(Buffer::from(out.to_vec()))
        }
        _ => {
            let out_len = len.checked_mul(2)
                .ok_or_else(|| Error::from_reason("byte_len too large"))?;
            let mut bytes = vec![0u8; len];
            getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut out = vec![0u8; out_len];
            hex_encode(&bytes, &mut out);
            Ok(Buffer::from(out))
        }
    }
}