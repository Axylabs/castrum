// rust/payload/sse.rs — Server-Sent Events framing.
//
// Backend-framework feature: SSE response framing. Encodes a single SSE event
// per the WHATWG SSE spec: optional `id:`, `event:`, `retry:` lines followed by
// one `data:` line per input line and a terminating blank line. Pure byte work
// with no allocation beyond the output buffer.

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ── Pure-Rust core ─────────────────────────────────────────────

/// Encode one SSE event. Multi-line `data` is emitted as repeated `data:` lines.
pub fn encode_event(
    event: Option<&str>,
    data: &[u8],
    id: Option<&str>,
    retry: Option<u64>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 48);
    if let Some(id) = id {
        out.extend_from_slice(b"id: ");
        out.extend_from_slice(id.as_bytes());
        out.push(b'\n');
    }
    if let Some(event) = event {
        out.extend_from_slice(b"event: ");
        out.extend_from_slice(event.as_bytes());
        out.push(b'\n');
    }
    if let Some(retry) = retry {
        out.extend_from_slice(b"retry: ");
        out.extend_from_slice(retry.to_string().as_bytes());
        out.push(b'\n');
    }
    for line in data.split(|&b| b == b'\n') {
        out.extend_from_slice(b"data: ");
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    out.push(b'\n');
    out
}

// ── NAPI entry points ──────────────────────────────────────────

/// Encode a single SSE event → bytes.
#[napi]
pub fn sse_encode_event(
    event: Option<String>,
    data: Uint8Array,
    id: Option<String>,
    retry: Option<u32>,
) -> Buffer {
    Buffer::from(encode_event(
        event.as_deref(),
        data.as_ref(),
        id.as_deref(),
        retry.map(u64::from),
    ))
}

/// Parallel SSE batch: packed `[u32 count]{[u32 len][data]}` in → packed
/// `[u32 count]{[u32 len][event]}` out (same event/id/retry for all items).
#[napi]
pub fn sse_encode_batch_packed(
    data: Uint8Array,
    event: Option<String>,
    id: Option<String>,
    retry: Option<u32>,
) -> Result<Buffer> {
    let encode_one =
        |d: &[u8]| encode_event(event.as_deref(), d, id.as_deref(), retry.map(u64::from));
    crate::util::run_packed_batch(data.as_ref(), encode_one).map(Buffer::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_basic_event() {
        assert_eq!(encode_event(None, b"hello", None, None), b"data: hello\n\n");
    }

    #[test]
    fn encodes_multiline_data() {
        assert_eq!(
            encode_event(None, b"line1\nline2", None, None),
            b"data: line1\ndata: line2\n\n"
        );
    }

    #[test]
    fn encodes_named_event_with_id_and_retry() {
        assert_eq!(
            encode_event(Some("update"), b"payload", Some("42"), Some(3000)),
            b"id: 42\nevent: update\nretry: 3000\ndata: payload\n\n"
        );
    }

    #[test]
    fn empty_data_still_terminates() {
        assert_eq!(encode_event(None, b"", None, None), b"data: \n\n");
    }
}
