// rust/core/websocket.rs — WebSocket utilities
// Pure Rust, no napi dependencies.

use aws_lc_rs::digest;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// WebSocket magic GUID used for the accept key calculation.
pub const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-5AB5DC11BE85";

/// Compute a WebSocket accept key from the client's key.
pub fn ws_accept_key(key: &[u8]) -> Vec<u8> {
    let mut ctx = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(key);
    ctx.update(WS_GUID);
    let hash = ctx.finish();

    let mut out = [0u8; 28];
    let n = BASE64
        .encode_slice(hash.as_ref(), &mut out)
        .unwrap_or(0);
    out[..n].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_accept_key() {
        let result = ws_accept_key(b"dGhlIHNhbXBsZSBub25jZQ==");
        assert!(!result.is_empty());
    }
}