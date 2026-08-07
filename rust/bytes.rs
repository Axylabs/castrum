// rust/bytes.rs — Shared low-level byte utilities
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

/// Value of a single hex digit, or `None` if `b` is not a hex digit.
#[inline(always)]
pub fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
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

/// Encode `bytes` as UPPERCASE hex into `out` (used by URL percent-encoding).
#[inline]
pub fn hex_encode_upper(bytes: &[u8], out: &mut [u8]) {
    assert!(
        out.len() >= bytes.len() * 2,
        "hex_encode_upper: output buffer too small ({} < {})",
        out.len(),
        bytes.len() * 2
    );
    for (i, &b) in bytes.iter().enumerate() {
        out[2 * i] = HEX_UPPER[(b >> 4) as usize];
        out[2 * i + 1] = HEX_UPPER[(b & 0x0f) as usize];
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
/// are skipped. A missing `=` yields an empty value.
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

        Some((name, value))
    })
}
