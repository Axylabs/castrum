// rust/ws_frames.rs — RFC 6455 WebSocket frame encode/decode.
//
// Backend-framework feature: byte-level WebSocket framing (opcode, FIN, length
// encoding, client masking). Bun already provides a full WebSocket server; this
// is the low-level codec used when you need raw frame control or a benchmark
// reference for the byte machinery. The default mask key is the RFC 6455 §5.7
// example (`0x37 0xfa 0x21 0x3d`) so encode is deterministic and testable; real
// clients should use a random key (pass a different one if desired).
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use napi::bindgen_prelude::*;
use napi_derive::napi;

const DEFAULT_MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

// ── Pure-Rust core ─────────────────────────────────────────────

/// Encode a single WebSocket frame per RFC 6455 §5.2.
pub fn encode_frame(opcode: u8, payload: &[u8], mask: bool, fin: bool) -> Vec<u8> {
    let header_len = 2
        + if payload.len() > 125 {
            if payload.len() > 65_535 {
                8
            } else {
                2
            }
        } else {
            0
        }
        + if mask { 4 } else { 0 };

    let mut out = Vec::with_capacity(header_len + payload.len());
    out.push((if fin { 0x80 } else { 0 }) | (opcode & 0x0f));

    let len = payload.len();
    let mask_bit = if mask { 0x80 } else { 0 };
    if len <= 125 {
        out.push(mask_bit | len as u8);
    } else if len <= 65_535 {
        out.push(mask_bit | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(mask_bit | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }

    if mask {
        out.extend_from_slice(&DEFAULT_MASK);
        for (i, &b) in payload.iter().enumerate() {
            out.push(b ^ DEFAULT_MASK[i & 3]);
        }
    } else {
        out.extend_from_slice(payload);
    }

    out
}

/// A decoded WebSocket frame.
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Decode a single WebSocket frame (RFC 6455 §5.2). Returns `None` on any
/// malformed / truncated input. Server→client frames are unmasked here.
pub fn decode_frame(data: &[u8]) -> Option<Frame> {
    if data.len() < 2 {
        return None;
    }
    let fin = data[0] & 0x80 != 0;
    let opcode = data[0] & 0x0f;
    let masked = data[1] & 0x80 != 0;
    let mut len = (data[1] & 0x7f) as u64;
    let mut pos = 2usize;

    if len == 126 {
        if data.len() < pos + 2 {
            return None;
        }
        len = u16::from_be_bytes([data[pos], data[pos + 1]]) as u64;
        pos += 2;
    } else if len == 127 {
        if data.len() < pos + 8 {
            return None;
        }
        let mut arr = [0u8; 8];
        arr.copy_from_slice(&data[pos..pos + 8]);
        len = u64::from_be_bytes(arr);
        pos += 8;
    }

    let mut mask = [0u8; 4];
    if masked {
        if data.len() < pos + 4 {
            return None;
        }
        mask.copy_from_slice(&data[pos..pos + 4]);
        pos += 4;
    }

    let payload = data.get(pos..pos + len as usize)?;
    let payload = if masked {
        payload
            .iter()
            .enumerate()
            .map(|(i, &b)| b ^ mask[i & 3])
            .collect()
    } else {
        payload.to_vec()
    };

    Some(Frame { fin, opcode, payload })
}

// ── NAPI entry points ──────────────────────────────────────────

#[napi(object)]
pub struct WsFrame {
    pub fin: bool,
    pub opcode: u32,
    pub payload: Buffer,
}

/// Encode a WebSocket frame. `opcode`: 1=text, 2=binary, 8=close, 9=ping,
/// 10=pong. `mask` applies client masking (RFC 6455 requires clients to mask).
#[napi]
pub fn ws_frame_encode(
    opcode: u32,
    payload: Uint8Array,
    mask: bool,
    fin: bool,
) -> Buffer {
    Buffer::from(encode_frame(opcode as u8, payload.as_ref(), mask, fin))
}

/// Decode a WebSocket frame. Returns `null` on malformed input.
#[napi]
pub fn ws_frame_decode(data: Uint8Array) -> Option<WsFrame> {
    decode_frame(data.as_ref()).map(|f| WsFrame {
        fin: f.fin,
        opcode: f.opcode as u32,
        payload: Buffer::from(f.payload),
    })
}

/// Parallel frame-encode batch: packed `[u32 count]{[u32 len][payload]}` in →
/// packed `[u32 count]{[u32 len][frame]}` out (same opcode/mask/fin for all).
#[napi]
pub fn ws_frame_encode_batch_packed(
    data: Uint8Array,
    opcode: u32,
    mask: bool,
    fin: bool,
) -> Result<Buffer> {
    let items = crate::util::unpack(data.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 24);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    for p in items {
        let r = encode_frame(opcode as u8, p, mask, fin);
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(&r);
    }

    Ok(Buffer::from(out))
}

/// Parallel frame-decode batch: packed frames in → packed `[u32 count]{
/// [u32 len][payload]}` out (opcodes/flags dropped; failed items → empty).
#[napi]
pub fn ws_frame_decode_batch_packed(data: Uint8Array) -> Result<Buffer> {
    let items = crate::util::unpack(data.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 24);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    for f in items {
        let r = decode_frame(f).map(|f| f.payload).unwrap_or_default();
        out.extend_from_slice(&(r.len() as u32).to_le_bytes());
        out.extend_from_slice(&r);
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_short_unmasked() {
        // RFC 6455 §5.7: 0x81 0x05 0x48 0x65 0x6c 0x6c 0x6f
        assert_eq!(encode_frame(0x1, b"Hello", false, true), b"\x81\x05Hello");
    }

    #[test]
    fn encode_masked_uses_rfc_example_key() {
        // RFC 6455 §5.7 example: masked "Hello" with key 0x37 0xfa 0x21 0x3d
        let expected = b"\x81\x85\x37\xfa\x21\x3d\x7f\x9f\x4d\x51\x58";
        assert_eq!(encode_frame(0x1, b"Hello", true, true), expected);
    }

    #[test]
    fn decode_unmasked_roundtrip() {
        let frame = encode_frame(0x2, b"binary payload", false, true);
        let decoded = decode_frame(&frame).unwrap();
        assert!(decoded.fin);
        assert_eq!(decoded.opcode, 0x2);
        assert_eq!(decoded.payload, b"binary payload");
    }

    #[test]
    fn decode_masked_roundtrip() {
        let frame = encode_frame(0x1, b"Hello", true, true);
        let decoded = decode_frame(&frame).unwrap();
        assert_eq!(decoded.payload, b"Hello");
    }

    #[test]
    fn decode_medium_and_long_lengths() {
        let medium: Vec<u8> = vec![0xAA; 300];
        let frame = encode_frame(0x2, &medium, false, true);
        assert_eq!(decode_frame(&frame).unwrap().payload, medium);

        let long: Vec<u8> = vec![0xBB; 70_000];
        let frame = encode_frame(0x2, &long, false, true);
        assert_eq!(decode_frame(&frame).unwrap().payload, long);
    }

    #[test]
    fn decode_rejects_truncated() {
        assert!(decode_frame(b"").is_none());
        assert!(decode_frame(b"\x81").is_none());
        let frame = encode_frame(0x1, b"Hello", false, true);
        assert!(decode_frame(&frame[..frame.len() - 1]).is_none());
    }

    #[test]
    fn fin_and_opcode_are_preserved() {
        let frame = encode_frame(0x9, b"ping", false, false); // ping, not final
        let decoded = decode_frame(&frame).unwrap();
        assert!(!decoded.fin);
        assert_eq!(decoded.opcode, 0x9);
    }
}
