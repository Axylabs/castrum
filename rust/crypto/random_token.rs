// rust/crypto/random_token.rs — random hex tokens (16/32/64 bytes use stack buffers)
use crate::util::bytes::hex_encode;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn random_token(byte_len: u32) -> Result<Buffer> {
    // Enterprise guard: never allocate more than this from a single call, even
    // on API misuse — a u32 byte_len would otherwise permit a ~4 GiB alloc.
    const MAX_BYTE_LEN: usize = 16 * 1024 * 1024;
    if byte_len as usize > MAX_BYTE_LEN {
        return Err(Error::from_reason(format!(
            "random_token: byte_len {byte_len} exceeds max {MAX_BYTE_LEN}"
        )));
    }

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
            let out_len = len
                .checked_mul(2)
                .ok_or_else(|| Error::from_reason("byte_len too large"))?;
            let mut bytes = vec![0u8; len];
            getrandom::fill(&mut bytes).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut out = vec![0u8; out_len];
            hex_encode(&bytes, &mut out);
            Ok(Buffer::from(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_sizes_return_hex_of_requested_length() {
        // The token is hex-encoded, so the output is exactly `len * 2` bytes
        // of lowercase hex characters.
        for len in [16u32, 32, 64, 7, 128] {
            let out = random_token(len).expect("valid len must succeed");
            assert_eq!(out.len(), len as usize * 2);
            for b in out.iter() {
                assert!(b.is_ascii_hexdigit(), "byte 0x{b:02x} is not hex");
            }
        }
    }

    #[test]
    fn tokens_are_random() {
        let a = random_token(32).unwrap();
        let b = random_token(32).unwrap();
        assert_ne!(a.to_vec(), b.to_vec(), "two tokens must not collide");
    }

    #[test]
    fn huge_length_is_rejected() {
        // The 16 MiB guard prevents a ~4 GiB single allocation from a u32 arg.
        assert!(random_token(16 * 1024 * 1024 + 1).is_err());
        assert!(random_token(u32::MAX).is_err());
    }
}
