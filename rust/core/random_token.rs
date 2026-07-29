// rust/core/random_token.rs — Cryptographic random token generation
// Pure Rust, no napi dependencies.

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Generate cryptographically secure random bytes, hex-encoded.
pub fn random_token(byte_len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; byte_len];
    let _ = getrandom::fill(&mut buf);
    let mut out = vec![0u8; byte_len * 2];
    hex_encode(&buf, &mut out);
    out
}

fn hex_encode(bytes: &[u8], out: &mut [u8]) {
    for (i, &b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_LOWER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_LOWER[(b & 0x0f) as usize];
    }
}