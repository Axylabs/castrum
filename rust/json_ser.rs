// rust/json_ser.rs — JSON serialization helpers extracted from ingress.rs
// Zero-alloc JSON escaping, cookie→JSON and query→JSON conversion
// Uses memchr-based skip for bulk unescaped bytes (~95% path)

use crate::util::trim_ascii_whitespace;
use napi::{Error, Result};

const JSON_HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Determine whether bytes are valid UTF-8 (cached via a bit check).
#[inline(always)]
fn is_valid_utf8(bytes: &[u8]) -> bool {
    // Fast path: small ASCII-only strings are very common
    if bytes.is_empty() {
        return true;
    }
    // Check first byte — if >= 0x80, we need a real check
    // For pure ASCII we can skip the full simdutf8 check
    if bytes.iter().all(|&b| b < 0x80) {
        return true;
    }
    std::str::from_utf8(bytes).is_ok()
}

/// Compute the JSON-escaped length without writing.
/// Uses memchr to find special characters in bulk.
#[inline(always)]
pub fn json_escaped_len(bytes: &[u8]) -> usize {
    if is_valid_utf8(bytes) {
        json_escaped_len_impl(bytes)
    } else {
        bytes.len().saturating_mul(6)
    }
}

/// Inner: assumes valid UTF-8, uses memchr for skip.
#[inline(always)]
fn json_escaped_len_impl(bytes: &[u8]) -> usize {
    let mut total = bytes.len(); // start with all bytes as 1
    let mut offset = 0;

    // Use memchr3 to find any of the special chars: ", \, \n
    while let Some(pos) = memchr::memchr3(b'"', b'\\', b'\n', &bytes[offset..]) {
        let abs = offset + pos;
        let b = bytes[abs];
        offset = abs + 1;

        total += match b {
            b'\\' | b'"' | b'\n' => 1, // 2 bytes instead of 1 → +1
            _ => {
                // \r, \t, \x08, \x0c: also 2 bytes
                if b == b'\r' || b == b'\t' || b == 0x08 || b == 0x0c {
                    1
                } else if b < 0x20 {
                    // \uXXXX → 6 bytes instead of 1 → +5
                    5
                } else {
                    0
                }
            }
        };
    }

    // Now check for remaining control characters (<0x20) that memchr3 missed
    // (tab and \r are 0x09 and 0x0d which are < 0x20 but already handled above)
    for &b in &bytes[offset..] {
        if b < 0x20 && b != b'\n' && b != b'\r' && b != b'\t' && b != 0x08 && b != 0x0c {
            total += 5; // \uXXXX
        }
    }

    total
}

/// Write JSON-escaped bytes into the buffer at the current position.
/// Returns the number of bytes written.
#[inline(always)]
pub fn write_json_escaped(out: &mut [u8], pos: &mut usize, bytes: &[u8]) -> usize {
    let start = *pos;
    if is_valid_utf8(bytes) {
        write_json_escaped_utf8(out, pos, bytes);
    } else {
        // Binary: escape every byte as \u00XX
        for &b in bytes {
            out[*pos] = b'\\';
            out[*pos + 1] = b'u';
            out[*pos + 2] = b'0';
            out[*pos + 3] = b'0';
            out[*pos + 4] = JSON_HEX_LOWER[(b >> 4) as usize];
            out[*pos + 5] = JSON_HEX_LOWER[(b & 0x0f) as usize];
            *pos += 6;
        }
    }
    *pos - start
}

/// Write escaped bytes for valid UTF-8 input.
#[inline(always)]
fn write_json_escaped_utf8(out: &mut [u8], pos: &mut usize, bytes: &[u8]) {
    let mut offset = 0usize;

    while let Some(mut idx) = memchr::memchr3(b'"', b'\\', b'\n', &bytes[offset..]) {
        idx += offset;

        // Copy unescaped bytes before the special character
        let unescaped = &bytes[offset..idx];
        if !unescaped.is_empty() {
            out[*pos..*pos + unescaped.len()].copy_from_slice(unescaped);
            *pos += unescaped.len();
        }

        let b = bytes[idx];
        match b {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 0x08 | 0x0c => {
                let esc = match b {
                    b'"' => b'"',
                    b'\\' => b'\\',
                    b'\n' => b'n',
                    b'\r' => b'r',
                    b'\t' => b't',
                    0x08 => b'b',
                    0x0c => b'f',
                    _ => unreachable!(),
                };
                out[*pos] = b'\\';
                out[*pos + 1] = esc;
                *pos += 2;
            }
            _ => {
                // Control character (< 0x20) → \u00XX
                out[*pos] = b'\\';
                out[*pos + 1] = b'u';
                out[*pos + 2] = b'0';
                out[*pos + 3] = b'0';
                out[*pos + 4] = JSON_HEX_LOWER[(b >> 4) as usize];
                out[*pos + 5] = JSON_HEX_LOWER[(b & 0x0f) as usize];
                *pos += 6;
            }
        }

        offset = idx + 1;
    }

    // Copy remaining
    let remaining = &bytes[offset..];
    if !remaining.is_empty() {
        // Check for remaining low control chars that memchr3 missed (\r, \t, etc.)
        let mut i = 0;
        while i < remaining.len() {
            let b = remaining[i];
            match b {
                b'\r' | b'\t' | 0x08 | 0x0c => {
                    let esc = match b {
                        b'\r' => b'r',
                        b'\t' => b't',
                        0x08 => b'b',
                        0x0c => b'f',
                        _ => unreachable!(),
                    };
                    out[*pos] = b'\\';
                    out[*pos + 1] = esc;
                    *pos += 2;
                    i += 1;
                }
                b if b < 0x20 => {
                    out[*pos] = b'\\';
                    out[*pos + 1] = b'u';
                    out[*pos + 2] = b'0';
                    out[*pos + 3] = b'0';
                    out[*pos + 4] = JSON_HEX_LOWER[(b >> 4) as usize];
                    out[*pos + 5] = JSON_HEX_LOWER[(b & 0x0f) as usize];
                    *pos += 6;
                    i += 1;
                }
                _ => {
                    // Bulk copy of safe bytes up to next special char
                    let remaining_slice = &remaining[i..];
                    let next_special = remaining_slice.iter().position(|&c| {
                        c < 0x20
                    });
                    match next_special {
                        Some(n) => {
                            out[*pos..*pos + n].copy_from_slice(&remaining_slice[..n]);
                            *pos += n;
                            i += n;
                        }
                        None => {
                            out[*pos..*pos + remaining_slice.len()].copy_from_slice(remaining_slice);
                            *pos += remaining_slice.len();
                            i = remaining.len();
                        }
                    }
                }
            }
        }
    }
}

/// Parse cookies from `input` and write JSON to `out` with max_pairs limit.
#[inline]
pub fn cookie_json_into_slice(input: &[u8], out: &mut [u8], max_pairs: usize) -> Result<usize> {
    if out.len() < 2 {
        return Err(Error::from_reason("output buffer too small for cookie JSON"));
    }

    out[0] = b'{';
    let mut pos = 1usize;
    let mut count = 0usize;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() {
            continue;
        }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() {
            continue;
        }

        if count >= max_pairs {
            break;
        }

        let needed = (if count == 0 { 0 } else { 1 })
            + 5
            + json_escaped_len(name)
            + json_escaped_len(value);

        if needed > out.len().saturating_sub(pos) {
            return Err(Error::from_reason("output buffer too small for cookie JSON"));
        }

        if count != 0 {
            out[pos] = b',';
            pos += 1;
        }

        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, name);
        out[pos] = b'"';
        pos += 1;
        out[pos] = b':';
        pos += 1;
        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, value);
        out[pos] = b'"';
        pos += 1;

        count += 1;
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason("output buffer too small for cookie JSON"));
    }

    out[pos] = b'}';
    pos += 1;
    Ok(pos)
}

/// Parse packed query pairs and write JSON to `out` with max_pairs limit.
#[inline]
pub fn packed_pairs_to_json_into_slice(
    packed: &[u8],
    out: &mut [u8],
    max_pairs: usize,
) -> Result<usize> {
    if out.len() < 2 {
        return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
    }

    if packed.len() < 4 {
        out[0..2].copy_from_slice(b"{}");
        return Ok(2);
    }

    let count = crate::util::read_u32_le(packed, 0)? as usize;

    out[0] = b'{';
    let mut pos = 1usize;
    let mut src = 4usize;
    let mut written_pairs = 0usize;

    for _ in 0..count {
        if written_pairs >= max_pairs {
            break;
        }

        let key_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        if src + key_len > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated key"));
        }

        let key = &packed[src..src + key_len];
        src += key_len;

        let val_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        if src + val_len > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated value"));
        }

        let val = &packed[src..src + val_len];
        src += val_len;

        let needed = (if written_pairs == 0 { 0 } else { 1 })
            + 5
            + json_escaped_len(key)
            + json_escaped_len(val);

        if needed > out.len().saturating_sub(pos) {
            return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
        }

        if written_pairs != 0 {
            out[pos] = b',';
            pos += 1;
        }

        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, key);
        out[pos] = b'"';
        pos += 1;
        out[pos] = b':';
        pos += 1;
        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, val);
        out[pos] = b'"';
        pos += 1;

        written_pairs += 1;
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
    }

    out[pos] = b'}';
    pos += 1;
    Ok(pos)
}

/// Write the full metadata JSON envelope (requestId, path, cookies, query).
#[inline]
pub fn write_full_body_json(
    out: &mut [u8],
    pos: usize,
    request_id: &[u8],
    path: &[u8],
    cookies_start: usize,
    cookies_len: usize,
    query_start: usize,
    query_len: usize,
) -> usize {
    const P1: &[u8] = b"{\"ok\":true,\"requestId\":\"";
    const P2: &[u8] = b"\",\"path\":\"";
    const P3: &[u8] = b"\",\"cookies\":";
    const P4: &[u8] = b",\"query\":";

    let cookies_eff_len = if cookies_len > 0 { cookies_len } else { 2 };
    let query_eff_len = if query_len > 0 { query_len } else { 2 };

    let required = P1.len()
        + json_escaped_len(request_id)
        + P2.len()
        + json_escaped_len(path)
        + P3.len()
        + cookies_eff_len
        + P4.len()
        + query_eff_len
        + 1;

    let end = match pos.checked_add(required) {
        Some(v) => v,
        None => return 0,
    };

    if end > out.len() {
        return 0;
    }

    let mut wp = pos;
    out[wp..wp + P1.len()].copy_from_slice(P1);
    wp += P1.len();
    write_json_escaped(out, &mut wp, request_id);
    out[wp..wp + P2.len()].copy_from_slice(P2);
    wp += P2.len();
    write_json_escaped(out, &mut wp, path);
    out[wp..wp + P3.len()].copy_from_slice(P3);
    wp += P3.len();

    if cookies_len > 0 {
        out.copy_within(cookies_start..cookies_start + cookies_len, wp);
        wp += cookies_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp..wp + P4.len()].copy_from_slice(P4);
    wp += P4.len();

    if query_len > 0 {
        out.copy_within(query_start..query_start + query_len, wp);
        wp += query_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp] = b'}';
    wp += 1;
    wp - pos
}