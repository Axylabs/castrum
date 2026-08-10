// rust/json/json_ser.rs — JSON serialization helpers extracted from ingress.rs
// Zero-alloc JSON escaping, cookie→JSON and query→JSON conversion
// Uses memchr-based skip for bulk unescaped bytes (~95% path)

use crate::util::bytes::{cookie_pairs, HEX_LOWER as JSON_HEX_LOWER};
use napi::{Error, Result};

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

/// Extra bytes (beyond the base 1 already counted per input byte) required to
/// escape control characters in a run that contains NO `"`, `\` or `\n`
/// (those three memchr3 specials are accounted for by the caller).
///
/// - `\r` (0x0d), `\t` (0x09), 0x08 and 0x0c become 2-byte escapes → +1.
/// - every other control char (< 0x20) becomes `\uXXXX` (6 bytes → +5).
#[inline(always)]
fn control_escape_extra(run: &[u8]) -> usize {
    let mut extra = 0;
    for &b in run {
        if b < 0x20 {
            extra += if b == b'\r' || b == b'\t' || b == 0x08 || b == 0x0c {
                1
            } else {
                5
            };
        }
    }
    extra
}

/// Inner: assumes valid UTF-8, uses memchr for skip.
#[inline(always)]
fn json_escaped_len_impl(bytes: &[u8]) -> usize {
    let mut total = bytes.len(); // start with all bytes as 1
    let mut offset = 0;

    // Use memchr3 to find any of the special chars: ", \, \n
    while let Some(pos) = memchr::memchr3(b'"', b'\\', b'\n', &bytes[offset..]) {
        let abs = offset + pos;

        // Control chars before the special are escaped too — they contribute
        // the same extra count the writer emits. This keeps the length an
        // EXACT accounting of the escaped output, so the output is always
        // RFC-8259-valid and never depends on memchr3's needle set.
        total += control_escape_extra(&bytes[offset..abs]);

        // memchr3 only matches ", \, \n — every hit is a 2-byte escape (+1).
        total += 1;

        offset = abs + 1;
    }

    // Trailing run after the last special — may contain control chars.
    total += control_escape_extra(&bytes[offset..]);
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

/// Write a run of bytes that contains no `"`, `\` or `\n`, escaping any
/// control characters (< 0x20) present. Assumes `out` has room for
/// `run.len() + control_escape_extra(run)` bytes.
#[inline(always)]
fn write_escaped_run(out: &mut [u8], pos: &mut usize, run: &[u8]) {
    if run.is_empty() {
        return;
    }
    let mut i = 0;
    while i < run.len() {
        let b = run[i];
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
                // Control character (< 0x20) → \u00XX
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
                // Bulk copy of safe bytes up to next control char.
                let rest = &run[i..];
                match rest.iter().position(|&c| c < 0x20) {
                    Some(n) => {
                        out[*pos..*pos + n].copy_from_slice(&rest[..n]);
                        *pos += n;
                        i += n;
                    }
                    None => {
                        out[*pos..*pos + rest.len()].copy_from_slice(rest);
                        *pos += rest.len();
                        i = run.len();
                    }
                }
            }
        }
    }
}

/// Write escaped bytes for valid UTF-8 input.
#[inline(always)]
fn write_json_escaped_utf8(out: &mut [u8], pos: &mut usize, bytes: &[u8]) {
    let mut offset = 0usize;

    while let Some(mut idx) = memchr::memchr3(b'"', b'\\', b'\n', &bytes[offset..]) {
        idx += offset;

        // Copy the unescaped bytes before the special character, escaping any
        // control chars memchr3 skipped — a raw control char (e.g. `\t` before
        // a `"`) would produce RFC-8259-invalid JSON.
        write_escaped_run(out, pos, &bytes[offset..idx]);

        let b = bytes[idx];
        match b {
            b'"' => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'"';
                *pos += 2;
            }
            b'\\' => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'\\';
                *pos += 2;
            }
            b'\n' => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'n';
                *pos += 2;
            }
            _ => unreachable!(),
        }

        offset = idx + 1;
    }

    // Trailing run after the last special — may contain control chars.
    write_escaped_run(out, pos, &bytes[offset..]);
}

/// Parse cookies from `input` and write JSON to `out` with max_pairs limit.
#[inline]
pub fn cookie_json_into_slice(input: &[u8], out: &mut [u8], max_pairs: usize) -> Result<usize> {
    if out.len() < 2 {
        return Err(Error::from_reason(
            "output buffer too small for cookie JSON",
        ));
    }

    out[0] = b'{';
    let mut pos = 1usize;

    for (count, (name, value)) in cookie_pairs(input).take(max_pairs).enumerate() {
        let needed =
            (if count == 0 { 0 } else { 1 }) + 5 + json_escaped_len(name) + json_escaped_len(value);

        if needed > out.len().saturating_sub(pos) {
            return Err(Error::from_reason(
                "output buffer too small for cookie JSON",
            ));
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
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason(
            "output buffer too small for cookie JSON",
        ));
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
        return Err(Error::from_reason(
            "output buffer too small for packed pairs JSON",
        ));
    }

    if packed.len() < 4 {
        out[0..2].copy_from_slice(b"{}");
        return Ok(2);
    }

    let count = crate::util::read_u32_le(packed, 0)? as usize;

    out[0] = b'{';
    let mut pos = 1usize;
    let mut src = 4usize;

    for (written_pairs, _) in (0..count).enumerate() {
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
            return Err(Error::from_reason(
                "output buffer too small for packed pairs JSON",
            ));
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
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason(
            "output buffer too small for packed pairs JSON",
        ));
    }

    out[pos] = b'}';
    pos += 1;
    Ok(pos)
}

/// Distinct failure modes for [`query_to_json_into_slice`], so the caller can
/// map malformed input → 400 and a too-small output buffer → truncated (the
/// same split the old packed pipeline had between its parse and write steps).
#[derive(Debug, PartialEq, Eq)]
pub enum QueryJsonError {
    Malformed,
    BufferTooSmall,
}

/// Decode a single URL-form component (`+` → space, `%XX` → byte) into `out`.
///
/// Shared decoder with `query_parser::write_decoded_form_component` (this one
/// appends to a `Vec` rather than writing a length-prefixed slice); errors on
/// malformed `%XX`.
#[inline]
fn decode_query_component(
    src: &[u8],
    out: &mut Vec<u8>,
) -> std::result::Result<(), QueryJsonError> {
    let start = out.len();
    out.resize(start + src.len(), 0);
    let written = crate::util::bytes::decode_form_component_into(src, &mut out[start..]).map_err(
        |e| match e {
            crate::util::bytes::FormDecodeError::Malformed => QueryJsonError::Malformed,
            crate::util::bytes::FormDecodeError::BufferTooSmall => QueryJsonError::BufferTooSmall,
        },
    )?;
    out.truncate(start + written);
    Ok(())
}

/// Parse a URL query string and write JSON directly to `out` with a
/// `max_pairs` limit — one pass over the raw query with a single reused
/// scratch buffer, no intermediate packed buffer and no second parse.
///
/// Semantics match the two-step `query_parse_packed_vec` +
/// `packed_pairs_to_json_into_slice` pipeline (which this replaces on the
/// ingress hot path): pairs split on `&`, `key=value` (no `=` → empty value),
/// `+`/`%XX` decoded, keys/values JSON-escaped (UTF-8-aware, identical to
/// `write_json_escaped`). `Malformed` (caller → 400) on bad `%XX`;
/// `BufferTooSmall` (caller → truncated) when `out` cannot hold the result.
#[inline]
pub fn query_to_json_into_slice(
    input: &[u8],
    out: &mut [u8],
    max_pairs: usize,
) -> std::result::Result<usize, QueryJsonError> {
    if out.len() < 2 {
        return Err(QueryJsonError::BufferTooSmall);
    }

    out[0] = b'{';
    let mut pos = 1usize;
    let mut written_pairs = 0usize;

    // Shared scratch for percent-decoded components — reused across all pairs
    // (grows only to the largest component; bounded by the caller's query
    // limit), so there is no per-pair allocation.
    let mut scratch: Vec<u8> = Vec::new();

    for pair in input.split(|&b| b == b'&') {
        if pair.is_empty() {
            continue;
        }
        if written_pairs >= max_pairs {
            break;
        }
        let (key, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        // Single-pass percent-decode: decode each component ONCE into the
        // shared scratch as `[decoded_key][decoded_value]`, then derive the
        // escaped lengths and write from the same buffers. (The previous code
        // decoded every component twice — once in a length pass, once in a
        // write pass — i.e. four decodes per pair.)
        scratch.clear();
        decode_query_component(key, &mut scratch)?;
        let key_end = scratch.len();
        decode_query_component(value, &mut scratch)?;
        let key_len = json_escaped_len(&scratch[..key_end]);
        let val_len = json_escaped_len(&scratch[key_end..]);

        let needed = (if written_pairs == 0 { 0 } else { 1 }) + 5 + key_len + val_len;
        if needed > out.len().saturating_sub(pos) {
            return Err(QueryJsonError::BufferTooSmall);
        }

        // Write pass (from the already-decoded scratch buffers).
        if written_pairs != 0 {
            out[pos] = b',';
            pos += 1;
        }
        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, &scratch[..key_end]);
        out[pos] = b'"';
        pos += 1;
        out[pos] = b':';
        pos += 1;
        out[pos] = b'"';
        pos += 1;
        write_json_escaped(out, &mut pos, &scratch[key_end..]);
        out[pos] = b'"';
        pos += 1;

        written_pairs += 1;
    }

    if pos + 1 > out.len() {
        return Err(QueryJsonError::BufferTooSmall);
    }

    out[pos] = b'}';
    pos += 1;
    Ok(pos)
}

/// Write the full metadata JSON envelope (requestId, path, cookies, query).
///
/// The metadata envelope legitimately carries many fields; the flat signature
/// keeps the writer allocation-free (no options struct on the hot path).
#[allow(clippy::too_many_arguments)]
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
