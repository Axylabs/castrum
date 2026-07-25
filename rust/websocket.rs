use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use ring::digest;

const WS_MAGIC: &[u8] = b"258EAFA5-E914-47DA-95CA-5AB5DC11BE85";

#[napi]
pub fn ws_accept_key(key: Uint8Array) -> Result<Buffer> {
    let mut ctx = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(key.as_ref());
    ctx.update(WS_MAGIC);

    let hash = ctx.finish();

    let mut out = [0u8; 28];
    let n = BASE64
        .encode_slice(hash.as_ref(), &mut out)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(Buffer::from(out[..n].to_vec()))
}