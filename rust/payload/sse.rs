// rust/payload/sse.rs — Server-Sent Events framing.
//
// Backend-framework feature: SSE response framing. Encodes a single SSE event
// per the WHATWG SSE spec: optional `id:`, `event:`, `retry:` lines followed by
// one `data:` line per input line and a terminating blank line. Pure byte work
// with no allocation beyond the output buffer.

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ── Pure-Rust core ─────────────────────────────────────────────

/// Digits in the base-10 decimal form of a `u64` (for the `retry:` line —
/// avoids `retry.to_string()`'s heap allocation).
#[inline]
fn u64_digits(mut n: u64) -> usize {
    let mut c = 1;
    while n >= 10 {
        n /= 10;
        c += 1;
    }
    c
}

/// Exact encoded size of one SSE event (no allocation).
#[inline]
pub fn encode_event_size(
    event: Option<&str>,
    data: &[u8],
    id: Option<&str>,
    retry: Option<u64>,
) -> usize {
    let mut need = 0usize;
    if let Some(id) = id {
        need += 5 + id.len(); // "id: " + id + "\n"
    }
    if let Some(event) = event {
        need += 8 + event.len(); // "event: " + event + "\n"
    }
    if let Some(retry) = retry {
        need += 8 + u64_digits(retry); // "retry: " + digits + "\n"
    }
    // One `data: ` (6) + `\n` (1) per input line, the line bytes themselves
    // (SEGMENTS EXCLUDE the `\n` separators — sum of segment lengths =
    // `data.len() - (line_count - 1)`), then the terminating blank `\n`.
    // Line boundaries found via SIMD memchr — a scalar `filter().count()`
    // pass over the full payload was ~1 cycle/byte (~650ns/KB steady state),
    // collapsing large encodes to 0.10× of JS.
    let line_count = memchr::memchr_iter(b'\n', data).count() + 1;
    need + line_count * 7 + data.len() - (line_count - 1) + 1
}

/// Encode one SSE event into `out`, returning bytes written. Zero-alloc (no
/// `retry.to_string()`, no output `Vec`). Errors (`&'static str`) if `out` is
/// too small — nothing is written on error.
pub fn encode_event_into_slice(
    event: Option<&str>,
    data: &[u8],
    id: Option<&str>,
    retry: Option<u64>,
    out: &mut [u8],
) -> std::result::Result<usize, &'static str> {
    let need = encode_event_size(event, data, id, retry);
    if need > out.len() {
        return Err("sse encode: output buffer too small");
    }
    let mut w = 0usize;
    if let Some(id) = id {
        out[w..w + 4].copy_from_slice(b"id: ");
        w += 4;
        out[w..w + id.len()].copy_from_slice(id.as_bytes());
        w += id.len();
        out[w] = b'\n';
        w += 1;
    }
    if let Some(event) = event {
        out[w..w + 7].copy_from_slice(b"event: ");
        w += 7;
        out[w..w + event.len()].copy_from_slice(event.as_bytes());
        w += event.len();
        out[w] = b'\n';
        w += 1;
    }
    if let Some(retry) = retry {
        out[w..w + 7].copy_from_slice(b"retry: ");
        w += 7;
        let mut digits = [0u8; 20];
        let mut n = retry;
        let mut i = 0;
        loop {
            digits[i] = b'0' + (n % 10) as u8;
            n /= 10;
            i += 1;
            if n == 0 {
                break;
            }
        }
        for &d in digits[..i].iter().rev() {
            out[w] = d;
            w += 1;
        }
        out[w] = b'\n';
        w += 1;
    }
    // One `data: ` line per input line: SIMD memchr finds the `\n` boundaries
    // (no scalar split() re-scan of the whole payload), copying each run.
    // `data.split('\n')` semantics are preserved exactly: the tail after the
    // last `\n` is emitted even when empty.
    let mut line_start = 0usize;
    for sep in memchr::memchr_iter(b'\n', data) {
        let line = &data[line_start..sep];
        out[w..w + 6].copy_from_slice(b"data: ");
        w += 6;
        out[w..w + line.len()].copy_from_slice(line);
        w += line.len();
        out[w] = b'\n';
        w += 1;
        line_start = sep + 1;
    }
    {
        let line = &data[line_start..];
        out[w..w + 6].copy_from_slice(b"data: ");
        w += 6;
        out[w..w + line.len()].copy_from_slice(line);
        w += line.len();
        out[w] = b'\n';
        w += 1;
    }
    out[w] = b'\n';
    w += 1;
    Ok(w)
}

/// Encode one SSE event. Multi-line `data` is emitted as repeated `data:` lines.
pub fn encode_event(
    event: Option<&str>,
    data: &[u8],
    id: Option<&str>,
    retry: Option<u64>,
) -> Vec<u8> {
    let mut out = vec![0u8; encode_event_size(event, data, id, retry)];
    let w = encode_event_into_slice(event, data, id, retry, &mut out)
        .expect("output sized to the exact encoded length");
    out.truncate(w);
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

    #[test]
    fn into_slice_matches_allocating() {
        type SseCase<'a> = (Option<&'a str>, &'a [u8], Option<&'a str>, Option<u64>);
        let cases: &[SseCase] = &[
            (None, b"hello", None, None),
            (Some("update"), b"payload", Some("42"), Some(3000)),
            (None, b"line1\nline2\nline3", None, None),
            (Some("ev"), b"", Some("id"), Some(0)),
            (Some(""), b"x", None, None),
        ];
        for &(event, data, id, retry) in cases {
            let expected = encode_event(event, data, id, retry);
            let mut out = vec![0u8; expected.len() + 8];
            let w = encode_event_into_slice(event, data, id, retry, &mut out).unwrap();
            assert_eq!(w, expected.len());
            assert_eq!(&out[..w], &expected[..]);
        }
    }

    #[test]
    fn into_slice_rejects_too_small() {
        let mut out = [0u8; 3];
        assert!(encode_event_into_slice(Some("update"), b"payload", None, None, &mut out).is_err());
    }

    #[test]
    fn large_multiline_matches_allocating() {
        // 4k lines x 96-byte data — spans well past any SIMD threshold.
        let mut data = Vec::with_capacity(4 * 1024 * 96);
        for i in 0..4 * 1024 {
            data.extend_from_slice(format!("line-{i} ").as_bytes());
            data.extend_from_slice(b"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); // 55
            data.push(b'\n');
        }
        let expected = encode_event(None, &data, None, None);
        assert!(
            expected.len() > 256 * 1024,
            "test payload unexpectedly small: {}",
            expected.len()
        );
        let mut out = vec![0u8; encode_event_size(None, &data, None, None)];
        let w = encode_event_into_slice(None, &data, None, None, &mut out).unwrap();
        assert_eq!(w, expected.len());
        assert_eq!(&out[..w], &expected[..]);
    }

    #[test]
    fn single_large_line_scales_too() {
        // One 1MB line — the old scalar split() path cost ~300us here.
        let mut data = vec![b'a'; 1 << 20];
        data.push(b'\n');
        let expected = encode_event(None, &data, None, None);
        let mut out = vec![0u8; encode_event_size(None, &data, None, None)];
        let w = encode_event_into_slice(None, &data, None, None, &mut out).unwrap();
        assert_eq!(w, expected.len());
        assert_eq!(&out[..w], &expected[..]);
    }

    #[test]
    fn trailing_newline_emits_empty_tail_line() {
        // split() semantics: "a\n" -> ["a", ""] -> one empty data: line.
        assert_eq!(
            encode_event(None, b"hello\n", None, None),
            b"data: hello\ndata: \n\n"
        );
        assert_eq!(encode_event(None, b"\n", None, None), b"data: \ndata: \n\n");
        assert_eq!(encode_event(None, b"", None, None), b"data: \n\n");
    }

    #[test]
    fn embedded_crlf_kept_in_line() {
        // Only \n splits lines; \r stays in the line bytes.
        assert_eq!(
            encode_event(None, b"a\r\nb", None, None),
            b"data: a\r\ndata: b\n\n"
        );
    }
}
