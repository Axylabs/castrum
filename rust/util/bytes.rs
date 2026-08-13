// rust/util/bytes.rs — Shared low-level byte utilities
//
// This is the ONE home for the small byte-manipulation primitives that are
// reused across the crate: word-at-a-time comparison, hex (de)encoding,
// `%XX` percent decoding, whitespace trimming, and cookie pair splitting.
//
// Before the refactor these helpers were copy-pasted into several modules
// (headers.rs, method.rs, hmac_sha256.rs, random_token.rs, url_codec.rs,
// query_parser.rs, cookie_parser.rs, json_ser.rs). Keeping them in a single
// place means there is exactly ONE implementation to read, test, and tune.

// ── Word-at-a-time comparison ──────────────────────────────────────

/// Load a `u64` from the first `min(len, 8)` bytes of `bytes`, zero-padded.
#[inline(always)]
pub fn load_u64_padded(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let len = bytes.len().min(8);
    buf[..len].copy_from_slice(&bytes[..len]);
    u64::from_le_bytes(buf)
}

/// ASCII case-insensitive comparison using u64 words for short inputs.
///
/// Both inputs must have the same length. The `0x20` bit is OR'd into both
/// words so `A`..`Z` and `a`..`z` collapse to the same value — no allocation.
///
/// Note: only safe for ASCII name matching (headers, HTTP methods), never for
/// arbitrary binary data (the `0x20` mask can equate some non-alpha chars).
#[inline(always)]
pub fn ascii_eq_ignore_case(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }

    match a.len() {
        0 => true,
        1..=8 => {
            let wa = load_u64_padded(a) | 0x2020_2020_2020_2020;
            let wb = load_u64_padded(b) | 0x2020_2020_2020_2020;
            wa == wb
        }
        9..=16 => {
            let wa = load_u64_padded(a) | 0x2020_2020_2020_2020;
            let wb = load_u64_padded(b) | 0x2020_2020_2020_2020;
            if wa != wb {
                return false;
            }
            let wa2 = load_u64_padded(&a[8..]) | 0x2020_2020_2020_2020;
            let wb2 = load_u64_padded(&b[8..]) | 0x2020_2020_2020_2020;
            wa2 == wb2
        }
        _ => a.eq_ignore_ascii_case(b),
    }
}

// ── Hex (de)encoding ───────────────────────────────────────────────

pub const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";
pub const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// 256-entry hex-digit lookup (single table load instead of a range-compare
/// chain); -1 marks a non-hex byte. Shared by all `%XX` / hex decode paths.
const HEX_VAL_LUT: [i8; 256] = {
    let mut t = [-1i8; 256];
    let mut i = 0usize;
    while i < 256 {
        let b = i as u8;
        t[i] = match b {
            b'0'..=b'9' => (b - b'0') as i8,
            b'a'..=b'f' => (b - b'a' + 10) as i8,
            b'A'..=b'F' => (b - b'A' + 10) as i8,
            _ => -1,
        };
        i += 1;
    }
    t
};

/// Value of a single hex digit, or `None` if `b` is not a hex digit.
#[inline(always)]
pub fn hex_val(b: u8) -> Option<u8> {
    let v = HEX_VAL_LUT[b as usize];
    if v < 0 {
        None
    } else {
        Some(v as u8)
    }
}

/// Encode `bytes` as lowercase hex into `out`, which must hold `2 * bytes.len()`.
#[inline]
pub fn hex_encode(bytes: &[u8], out: &mut [u8]) {
    // Checked (not debug-only): with `debug-assertions = false` an undersized
    // `out` would otherwise surface as an unhelpful index panic in release.
    assert!(
        out.len() >= bytes.len() * 2,
        "hex_encode: output buffer too small ({} < {})",
        out.len(),
        bytes.len() * 2
    );
    for (i, &b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_LOWER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_LOWER[(b & 0x0f) as usize];
    }
}

/// Encode exactly 32 bytes as lowercase hex into a fixed 64-byte output.
#[inline(always)]
pub fn hex_encode_32(bytes: &[u8], out: &mut [u8; 64]) {
    debug_assert_eq!(bytes.len(), 32);
    hex_encode(bytes, out);
}

/// Decode exactly 64 hex characters into 32 bytes. Returns `None` on bad input.
#[inline]
pub fn hex_decode_32(hex: &[u8]) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = hex_val(hex[2 * i])?;
        let lo = hex_val(hex[2 * i + 1])?;
        *slot = (hi << 4) | lo;
    }
    Some(out)
}

// ── Percent decoding ───────────────────────────────────────────────

/// Decode the `%XX` sequence starting at `src[i..]` into a single byte.
///
/// Returns `(decoded_byte, index_of_next_input_byte)`, or `None` when the
/// sequence is malformed (truncated or a non-hex digit).
#[inline]
pub fn decode_percent_at(src: &[u8], i: usize) -> Option<(u8, usize)> {
    if i + 2 >= src.len() {
        return None;
    }
    let hi = hex_val(src[i + 1])?;
    let lo = hex_val(src[i + 2])?;
    Some(((hi << 4) | lo, i + 3))
}

// ── Form-component decoding ────────────────────────────────────────

/// Decode failure modes for [`decode_form_component_into`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormDecodeError {
    /// Malformed `%XX` sequence (truncated or a non-hex digit).
    Malformed,
    /// `out` cannot hold the decoded result.
    BufferTooSmall,
}

/// URL-decode a form component (`+` → space, `%XX` → byte) into `out`,
/// returning the number of bytes written.
///
/// The decoded length never exceeds `src.len()` (each input byte maps to at
/// most one output byte). Callers that pre-size `out` to `src.len()` can never
/// observe [`FormDecodeError::BufferTooSmall`]; callers that pass the remaining
/// tail of a larger buffer get a precise capacity check against the ACTUAL
/// decoded length (a `%XX` sequence shrinks 3 input bytes to 1, so a buffer
/// sized to the decoded form succeeds).
///
/// Single shared implementation for `query_parser::write_decoded_form_component`
/// (length-prefixed slice writer) and `json_ser::decode_query_component`
/// (Vec appender) — the wire decode loop lives in exactly one place.
#[inline]
pub fn decode_form_component_into(
    src: &[u8],
    out: &mut [u8],
) -> std::result::Result<usize, FormDecodeError> {
    if memchr::memchr2(b'+', b'%', src).is_none() {
        if out.len() < src.len() {
            return Err(FormDecodeError::BufferTooSmall);
        }
        out[..src.len()].copy_from_slice(src);
        return Ok(src.len());
    }
    // Run-copy decode: bulk-copy plain runs up to the next '+'/'%', then
    // decode the single special byte, instead of walking every byte. This is
    // the same memchr2 discipline `url_decode` uses and avoids per-byte
    // branches over the common long runs of unreserved characters. Capacity
    // is still checked against the ACTUAL decoded length (a `%XX` shrinks 3
    // input bytes to 1), preserving the existing semantics.
    let mut i = 0usize;
    let mut written = 0usize;
    while i < src.len() {
        match memchr::memchr2(b'+', b'%', &src[i..]) {
            Some(rel) => {
                let run_end = i + rel;
                let run = &src[i..run_end];
                if written + run.len() > out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written..written + run.len()].copy_from_slice(run);
                written += run.len();
                i = run_end;

                // Decode the '+' or '%XX' at position i.
                let (b, next) = match src[i] {
                    b'+' => (b' ', i + 1),
                    _ => {
                        let (byte, next) = decode_percent_at(src, i)
                            .ok_or(FormDecodeError::Malformed)?;
                        (byte, next)
                    }
                };
                if written >= out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written] = b;
                written += 1;
                i = next;
            }
            None => {
                let run = &src[i..];
                if written + run.len() > out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written..written + run.len()].copy_from_slice(run);
                written += run.len();
                i = src.len();
            }
        }
    }
    Ok(written)
}

// ── Whitespace + cookie splitting ──────────────────────────────────

/// Trim ASCII whitespace from both ends of a byte slice.
#[inline(always)]
pub fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let mut start = 0usize;
    let mut end = bytes.len();

    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }

    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }

    &bytes[start..end]
}

/// Iterate over the `name=value` pairs in a cookie-style header.
///
/// Pairs are split on `;`, whitespace-trimmed, and entries with an empty name
/// are skipped. A missing `=` yields an empty value. A value wrapped in
/// surrounding double quotes is unwrapped (RFC 6265 §5.2) so the native
/// output is byte-identical to the JS fallback.
pub fn cookie_pairs(input: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> + '_ {
    input.split(|&b| b == b';').filter_map(|raw| {
        let pair = trim_ascii_whitespace(raw);
        if pair.is_empty() {
            return None;
        }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() {
            return None;
        }

        // RFC 6265 §5.2: unwrap a cookie-value surrounded by DQUOTE (only when
        // BOTH ends quote, matching the JS fallback's `unquote` exactly).
        let value = if value.len() >= 2 && value[0] == b'"' && value[value.len() - 1] == b'"' {
            &value[1..value.len() - 1]
        } else {
            value
        };

        Some((name, value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(src: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; src.len()];
        let n = decode_form_component_into(src, &mut out).unwrap();
        out.truncate(n);
        out
    }

    #[test]
    fn decode_form_plain_passthrough() {
        assert_eq!(decode(b"abc"), b"abc");
        assert_eq!(decode(b""), b"");
        // The fast path copies exactly; verify capacity via the full slice.
        let mut out = [0u8; 3];
        assert_eq!(decode_form_component_into(b"abc", &mut out), Ok(3));
    }

    #[test]
    fn decode_form_plus_and_percent() {
        assert_eq!(decode(b"a+b"), b"a b");
        assert_eq!(decode(b"%41%42"), b"AB");
        assert_eq!(decode(b"q=%E2%9C%93"), b"q=\xE2\x9C\x93");
        assert_eq!(decode(b"%2B"), b"+");
    }

    #[test]
    fn decode_form_malformed_percent() {
        let mut out = [0u8; 8];
        assert_eq!(
            decode_form_component_into(b"%ZZ", &mut out),
            Err(FormDecodeError::Malformed)
        );
        assert_eq!(
            decode_form_component_into(b"%4", &mut out),
            Err(FormDecodeError::Malformed)
        );
        assert_eq!(
            decode_form_component_into(b"x%", &mut out),
            Err(FormDecodeError::Malformed)
        );
    }

    #[test]
    fn cookie_pairs_unwraps_dquote() {
        let pairs: Vec<(&[u8], &[u8])> = cookie_pairs(b"a=1; b=\"quoted value\"; c=\"\"; d=\"abc; empty=")
            .collect();
        assert_eq!(
            pairs,
            vec![
                (&b"a"[..], &b"1"[..]),
                (&b"b"[..], &b"quoted value"[..]),
                (&b"c"[..], &b""[..]),
                (&b"d"[..], &b"\"abc"[..]), // unbalanced quote kept, matches JS
                (&b"empty"[..], &b""[..]),
            ]
        );
    }

    #[test]
    fn cookie_pairs_keeps_unbalanced_quotes() {
        // A quote only at one end (or embedded) is left as-is — matches JS.
        let pairs: Vec<(&[u8], &[u8])> = cookie_pairs(b"a=\"abc; b=ab\"c; c=\"quote")
            .collect();
        assert_eq!(
            pairs,
            vec![
                (&b"a"[..], &b"\"abc"[..]),
                (&b"b"[..], &b"ab\"c"[..]),
                (&b"c"[..], &b"\"quote"[..]),
            ]
        );
    }
}
