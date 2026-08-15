use aws_lc_rs::digest;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use napi::bindgen_prelude::*;
use napi_derive::napi;

const WS_MAGIC: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Zero-alloc core: RFC 6455 Sec-WebSocket-Accept (exactly 28 bytes) into a
/// caller-provided buffer. Shared by the C-ABI (`bun:ffi`) path so it never
/// allocates the accept string.
pub fn ws_accept_key_into(key: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut ctx = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(key);
    ctx.update(WS_MAGIC);

    let hash = ctx.finish();

    BASE64
        .encode_slice(hash.as_ref(), out)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// RFC 6455 Sec-WebSocket-Accept core over a raw key slice. Shared by the
/// scalar napi path and the packed batch path.
pub fn ws_accept_key_bytes(key: &[u8]) -> Result<Vec<u8>> {
    let mut out = [0u8; 28];
    let n = ws_accept_key_into(key, &mut out)?;
    Ok(out[..n].to_vec())
}

#[napi]
pub fn ws_accept_key(key: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(ws_accept_key_bytes(key.as_ref())?))
}

/// Packed WebSocket accept-key batch: `[u32 count]{[u32 len][key]}` in →
/// `[u32 count]{[u32 len][accept]}` out.
#[napi]
pub fn ws_accept_key_batch_packed(input: Uint8Array) -> Result<Buffer> {
    crate::util::run_packed_batch(input.as_ref(), |k| {
        ws_accept_key_bytes(k).unwrap_or_default()
    })
    .map(Buffer::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6455_accept_key_vector() {
        // RFC 6455 §1.3: accept = base64(SHA1(key + magic GUID)) where `key` is
        // the Sec-WebSocket-Key header value (the base64 string) concatenated
        // with the magic GUID. Verified against node:crypto.
        let key = b"dGhlIHNhbXBsZSBub25jZQ==";
        let out = ws_accept_key(Uint8Array::new(key.to_vec())).unwrap();
        assert_eq!(out.as_ref(), b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn different_keys_differ() {
        let a = ws_accept_key(Uint8Array::new(b"AAAA".to_vec())).unwrap();
        let b = ws_accept_key(Uint8Array::new(b"BBBB".to_vec())).unwrap();
        assert_ne!(a.as_ref(), b.as_ref());
    }
}
