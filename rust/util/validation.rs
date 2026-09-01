// rust/util/validation.rs — email / UUID / IPv4 / IPv6 validators.
//
// Each validator has a `*_bytes` zero-DOM core (the C-ABI + packed-batch
// paths) and a napi entry point. IPv4 dot-splitting uses `memchr`; the
// `fast-email` feature gates a regex-free email fast path.

#[cfg(not(feature = "fast-email"))]
use email_address::EmailAddress;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::net::Ipv6Addr;

#[cfg(feature = "fast-email")]
#[inline]
fn email_is_valid(s: &str) -> bool {
    fast_chemail::is_valid_email(s)
}

#[cfg(not(feature = "fast-email"))]
#[inline]
fn email_is_valid(s: &str) -> bool {
    EmailAddress::is_valid(s)
}

#[inline]
pub fn validate_email_bytes(input: &[u8]) -> bool {
    std::str::from_utf8(input)
        .map(email_is_valid)
        .unwrap_or(false)
}

#[inline]
pub fn validate_uuid_bytes(input: &[u8]) -> bool {
    let Ok(b) = <&[u8; 36]>::try_from(input) else {
        return false;
    };

    // Unroll the dash positions check.
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return false;
    }
    if b[14] != b'4' {
        return false;
    }
    if !matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
        return false;
    }

    // Validate hex digits at all other positions.
    // Use a lookup table for speed.
    const HEX: [bool; 256] = {
        let mut t = [false; 256];
        let mut i = 0;
        while i < 256 {
            t[i] = (i as u8).is_ascii_hexdigit();
            i += 1;
        }
        t
    };

    let mut i = 0usize;
    while i < 36 {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            i += 1;
            continue;
        }
        if i == 14 || i == 19 {
            i += 1;
            continue;
        }
        if !HEX[b[i] as usize] {
            return false;
        }
        i += 1;
    }
    true
}

#[inline]
fn is_valid_ipv4(b: &[u8]) -> bool {
    if b.is_empty() || b.len() > 15 {
        return false;
    }

    let mut parts = 0u8;
    let mut start = 0usize;

    // memchr-driven dot scan (the optimization the comment always promised;
    // the previous code walked the bytes with enumerate/filter_map).
    while let Some(rel) = memchr::memchr(b'.', &b[start..]) {
        let dot_idx = start + rel;
        let part = &b[start..dot_idx];
        if !validate_ipv4_part(part) {
            return false;
        }
        parts += 1;
        // 4 dots means 5 parts → always invalid; reject as soon as the 4th
        // dot is consumed (identical boolean result to the old count-then-
        // compare, with an earlier exit).
        if parts > 3 {
            return false;
        }
        start = dot_idx + 1;
    }

    // Last part.
    if !validate_ipv4_part(&b[start..]) {
        return false;
    }
    parts += 1;

    parts == 4
}

#[inline(always)]
fn validate_ipv4_part(part: &[u8]) -> bool {
    if part.is_empty() || part.len() > 3 {
        return false;
    }
    if part.len() > 1 && part[0] == b'0' {
        return false;
    }

    let mut n = 0u16;
    for &c in part {
        if !c.is_ascii_digit() {
            return false;
        }
        n = n * 10 + u16::from(c - b'0');
    }
    n <= 255
}

#[inline]
pub fn validate_ipv4_bytes(input: &[u8]) -> bool {
    is_valid_ipv4(input)
}

#[inline]
pub fn validate_ipv6_bytes(input: &[u8]) -> bool {
    simdutf8::basic::from_utf8(input)
        .ok()
        .and_then(|s| s.parse::<Ipv6Addr>().ok())
        .is_some()
}

#[napi]
pub fn validate_email(input: Uint8Array) -> bool {
    validate_email_bytes(input.as_ref())
}
#[napi]
pub fn validate_uuid(input: Uint8Array) -> bool {
    validate_uuid_bytes(input.as_ref())
}
#[napi]
pub fn validate_ipv4(input: Uint8Array) -> bool {
    validate_ipv4_bytes(input.as_ref())
}
#[napi]
pub fn validate_ipv6(input: Uint8Array) -> bool {
    validate_ipv6_bytes(input.as_ref())
}

// ── Batch fixed-width hex validation ────────────────────────────────────────
// Generic "is this a `width`-char hex string?" over NEWLINE-separated lines —
// the batch form of the ObjectId/hex-token checks every backend scatters as
// per-item regexes (`/^[0-9a-f]{24}$/` × N). One crossing validates a whole
// page of ids and writes one verdict byte (1/0) per line.

/// Max accepted hex width (an absurd width is caller error, not input error).
pub const HEX_BATCH_MAX_WIDTH: usize = 4096;

/// 256-entry hex-digit lookup table — one indexed load per byte instead of
/// three range compares in the batch hot loop.
const HEX_LUT: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0usize;
    while i < 256 {
        let c = i as u8;
        t[i] = (c.is_ascii_digit() || matches!(c, b'a'..=b'f' | b'A'..=b'F')) as u8;
        i += 1;
    }
    t
};

/// Validate newline-separated strings as fixed-width hex, appending one
/// verdict byte (1/0) per line to `out`. A trailing `\n` is allowed; `\r` is
/// tolerated before `\n` (CRLF callers). Empty input → empty output.
/// Errors only on a nonsensical `width` (0 or > [`HEX_BATCH_MAX_WIDTH`]).
pub fn hex_batch_valid_into(
    input: &[u8],
    width: usize,
    out: &mut Vec<u8>,
) -> std::result::Result<(), String> {
    if width == 0 || width > HEX_BATCH_MAX_WIDTH {
        return Err(format!("width must be 1..={HEX_BATCH_MAX_WIDTH}"));
    }
    // Fast path first: uniform-stride batches (`<width hex>\n` repeated — the
    // 99% shape: same-length ObjectIds joined with '\n') validate without any
    // per-line slicing, at memcpy-ish speed. Any layout deviation (short/
    // long lines, CRLF, embedded separators) falls back to the memchr path,
    // so semantics are byte-identical.
    if try_uniform_stride(input, width, out) {
        return Ok(());
    }
    // memchr-driven line splitting: the SIMD newline scan dominates the cost,
    // and each line gets an early-exit exact-width + hex-digit check.
    let mut start = 0usize;
    while let Some(rel) = memchr::memchr(b'\n', &input[start..]) {
        let end = start + rel;
        push_line_verdict(&input[start..end], width, out);
        start = end + 1;
    }
    // Trailing segment without a final newline (skip when empty — a trailing
    // `\n` does not open an extra line).
    if start < input.len() {
        push_line_verdict(&input[start..], width, out);
    }
    Ok(())
}

/// Uniform-stride validator: `<line>\n` repeated with EVERY line exactly
/// `width` bytes. Appends one verdict per line and returns `true`; returns
/// `false` (touching nothing) when the layout deviates.
#[inline]
fn try_uniform_stride(input: &[u8], width: usize, out: &mut Vec<u8>) -> bool {
    if input.is_empty() {
        return true; // zero lines, zero verdicts
    }
    let stride = width.saturating_add(1);
    let last = input[input.len() - 1]; // non-empty checked above
    let has_trailing = last == b'\n';
    let n = if has_trailing {
        if !input.len().is_multiple_of(stride) {
            return false;
        }
        input.len() / stride
    } else if input.len() % stride == width {
        input.len() / stride + 1
    } else {
        return false;
    };
    out.reserve(n);
    let mut pos = 0usize;
    for line_idx in 0..n {
        let end = pos + width;
        let needs_sep = !(line_idx + 1 == n && !has_trailing);
        if needs_sep && input[end] != b'\n' {
            return false;
        }
        let mut all_hex = true;
        for &c in &input[pos..end] {
            if HEX_LUT[c as usize] == 0 {
                all_hex = false;
                break;
            }
        }
        out.push(u8::from(all_hex));
        pos = end + 1;
    }
    true
}

/// Validate one line (no trailing newline): tolerate ONE trailing `\r`, then
/// require exact width + all hex digits.
#[inline]
fn push_line_verdict(line: &[u8], width: usize, out: &mut Vec<u8>) {
    let line = if line.last() == Some(&b'\r') {
        &line[..line.len() - 1]
    } else {
        line
    };
    let ok = line.len() == width && line.iter().all(|&c| HEX_LUT[c as usize] != 0);
    out.push(u8::from(ok));
}

/// Number of verdict bytes `hex_batch_valid_into` will append for `input`
/// (the needed-size convention's pre-computed size — no second validation
/// pass, just a newline count).
#[inline]
pub fn hex_batch_count(input: &[u8]) -> usize {
    let lines = memchr::memchr_iter(b'\n', input).count();
    // A trailing newline does not open an extra empty line.
    if input.last() == Some(&b'\n') {
        lines
    } else {
        lines + usize::from(!input.is_empty())
    }
}

/// Batch fixed-width hex validation → one verdict byte (1/0) per
/// newline-separated line. `width` is the exact expected string length
/// (e.g. 24 for Mongo ObjectIds). (JS name: `hexValidateBatch`.)
#[napi]
pub fn hex_validate_batch(input: Uint8Array, width: u32) -> Result<Uint8Array> {
    let mut out = Vec::with_capacity(hex_batch_count(input.as_ref()));
    hex_batch_valid_into(input.as_ref(), width as usize, &mut out)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e))?;
    Ok(out.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_email_cases() {
        assert!(validate_email_bytes(b"a@b.com"));
        assert!(!validate_email_bytes(b"not-an-email"));
        assert!(!validate_email_bytes(b""));
    }

    #[test]
    fn validate_uuid_v4_cases() {
        assert!(validate_uuid_bytes(b"550e8400-e29b-41d4-a716-446655440000"));
        assert!(!validate_uuid_bytes(b"550e8400e29b41d4a716446655440000")); // no dashes
    }

    #[test]
    fn validate_ipv4_cases() {
        assert!(validate_ipv4_bytes(b"192.168.0.1"));
        assert!(validate_ipv4_bytes(b"1.2.3.4"));
        assert!(!validate_ipv4_bytes(b"999.1.1.1"));
        assert!(!validate_ipv4_bytes(b"1.2.3"));
        assert!(!validate_ipv4_bytes(b""));
    }

    #[test]
    fn validate_ipv6_cases() {
        assert!(validate_ipv6_bytes(b"::1"));
        assert!(validate_ipv6_bytes(b"2001:db8::1"));
        assert!(!validate_ipv6_bytes(b"not-an-ip"));
        assert!(!validate_ipv6_bytes(b""));
    }

    #[test]
    fn hex_batch_basic_and_object_ids() {
        let mut out = Vec::new();
        hex_batch_valid_into(
            b"507f1f77bcf86cd799439011\n507F1F77BCF86CD799439012\nnothex\nshort\n507f1f77bcf86cd79943901z",
            24,
            &mut out,
        )
        .expect("ok");
        assert_eq!(out, vec![1, 1, 0, 0, 0]);
    }

    #[test]
    fn hex_batch_trailing_newline_and_crlf() {
        let mut out = Vec::new();
        hex_batch_valid_into(b"deadbeef\r\nDEADBEEF\n", 8, &mut out).expect("ok");
        assert_eq!(out, vec![1, 1]);
        // count matches the written length (needed-size convention pre-size)
        assert_eq!(hex_batch_count(b"deadbeef\r\nDEADBEEF\n"), 2);
        assert_eq!(hex_batch_count(b""), 0);
        assert_eq!(hex_batch_count(b"a\nb"), 2);
    }

    #[test]
    fn hex_batch_width_validation() {
        let mut out = Vec::new();
        assert!(hex_batch_valid_into(b"ab", 0, &mut out).is_err());
        assert!(hex_batch_valid_into(b"ab", HEX_BATCH_MAX_WIDTH + 1, &mut out).is_err());
    }

    /// Reference implementation (memchr split + per-line check) used to pin
    /// the uniform-stride fast path.
    fn hex_reference(input: &[u8], width: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut start = 0usize;
        while let Some(rel) = memchr::memchr(b'\n', &input[start..]) {
            let end = start + rel;
            push_line_verdict(&input[start..end], width, &mut out);
            start = end + 1;
        }
        if start < input.len() {
            push_line_verdict(&input[start..], width, &mut out);
        }
        out
    }

    #[test]
    fn hex_batch_uniform_fast_path_matches_fallback() {
        let cases: Vec<(String, usize)> = vec![
            (
                "507f1f77bcf86cd799439011\n507F1F77BCF86CD799439012\n".into(),
                24,
            ),
            ("507f1f77bcf86cd799439011\nzz\n".into(), 24),
            ("ab\ncd\n".into(), 2),
            ("ab\nc\n".into(), 2),      // short line → fallback
            ("ab\r\ncd\r\n".into(), 2), // CRLF → fallback
            ("abc\nab\n".into(), 2),    // long line breaks stride → fallback
            ("ab".into(), 2),           // no trailing newline
            ("abcd".into(), 2),         // two lines, no trailing newline
            ("ab\ncd\nef".into(), 2),   // trailing partial line
            ("\n".into(), 2),           // single empty line
            ("\n\n".into(), 2),         // empty lines
            ("".into(), 4),             // empty input
            ("a\nb\nc".into(), 1),
        ];
        for (input, width) in cases {
            let bytes = input.as_bytes();
            let mut fast_out = Vec::new();
            let took_fast = try_uniform_stride(bytes, width, &mut fast_out);
            let mut out = Vec::new();
            hex_batch_valid_into(bytes, width, &mut out).expect("valid width");
            let expected = hex_reference(bytes, width);
            assert_eq!(out, expected, "public path diverged for {input:?} @{width}");
            if took_fast {
                assert_eq!(
                    fast_out, expected,
                    "fast path diverged for {input:?} @ width {width}"
                );
            }
        }
    }
}
