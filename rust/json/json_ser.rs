// rust/json/json_ser.rs — JSON serialization helpers extracted from ingress.rs
// Zero-alloc JSON escaping, cookie→JSON and query→JSON conversion
// Uses memchr-based skip for bulk unescaped bytes (~95% path)

use crate::util::bytes::{cookie_pairs, HEX_LOWER as JSON_HEX_LOWER};

/// True when every byte is ASCII (< 0x80), checked word-at-a-time.
///
/// Equivalent to `bytes.iter().all(|&b| b < 0x80)` but skips the per-byte
/// loop for the bulk of the buffer (one u64 high-bit test per 8 bytes).
/// `as_chunks` types each chunk as `[u8; 8]`, so the word conversion cannot
/// panic and the bounds check elides on the hot path.
#[inline(always)]
fn is_ascii(bytes: &[u8]) -> bool {
    let (chunks, remainder) = bytes.as_chunks::<8>();
    for word in chunks {
        let w = u64::from_le_bytes(*word);
        if (w & 0x8080_8080_8080_8080) != 0 {
            return false;
        }
    }
    remainder.iter().all(|&b| b < 0x80)
}

/// Determine whether bytes are valid UTF-8 (cached via a bit check).
#[inline(always)]
fn is_valid_utf8(bytes: &[u8]) -> bool {
    // Fast path: small ASCII-only strings are very common.
    if bytes.is_empty() {
        return true;
    }
    // For pure ASCII we can skip the full simdutf8 check.
    if is_ascii(bytes) {
        return true;
    }
    std::str::from_utf8(bytes).is_ok()
}

/// Compute the JSON-escaped length without writing, validating UTF-8 in the
/// SAME pass as the memchr3 escape scan (previously `is_valid_utf8` + the
/// memchr3 scan were two full passes). Uses memchr to find special characters
/// in bulk.
///
/// # Correctness (matches `write_json_escaped`)
///
/// memchr3's needles (`"` 0x22, `\` 0x5C, `\n` 0x0A) are all < 0x80, and a valid
/// UTF-8 multi-byte sequence is made only of bytes >= 0x80, so an ASCII byte
/// can never appear inside a multi-byte sequence. Splitting the buffer at
/// memchr3 hits therefore never splits a multi-byte sequence, and
/// `str::from_utf8(whole)` is OK ⇔ every gap is OK. `write_json_escaped`
/// derives the same valid/invalid decision from `is_valid_utf8`, so the length
/// estimate stays an EXACT accounting of the written output (enforced by the
/// `write_json_escaped_never_overflows_exact_buffer` test).
#[inline(always)]
pub fn json_escaped_len(bytes: &[u8]) -> usize {
    // Pure ASCII is valid UTF-8 by construction — skip gap validation and just
    // do the escape accounting.
    if is_ascii(bytes) {
        return json_escaped_len_impl(bytes);
    }

    let mut total = bytes.len(); // start with all bytes as 1
    let mut offset = 0usize;

    while let Some(pos) = memchr::memchr3(b'"', b'\\', b'\n', &bytes[offset..]) {
        let abs = offset + pos;
        if std::str::from_utf8(&bytes[offset..abs]).is_err() {
            // Invalid UTF-8 → the binary escape path escapes EVERY byte as
            // `\u00XX` (6 bytes each), matching `write_json_escaped`.
            return bytes.len().saturating_mul(6);
        }
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
    if std::str::from_utf8(&bytes[offset..]).is_err() {
        return bytes.len().saturating_mul(6);
    }
    total += control_escape_extra(&bytes[offset..]);
    total
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
            b'\r' => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'r';
                *pos += 2;
                i += 1;
            }
            b'\t' => {
                out[*pos] = b'\\';
                out[*pos + 1] = b't';
                *pos += 2;
                i += 1;
            }
            0x08 => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'b';
                *pos += 2;
                i += 1;
            }
            0x0c => {
                out[*pos] = b'\\';
                out[*pos + 1] = b'f';
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
        if b == b'"' {
            out[*pos] = b'\\';
            out[*pos + 1] = b'"';
            *pos += 2;
        } else if b == b'\\' {
            out[*pos] = b'\\';
            out[*pos + 1] = b'\\';
            *pos += 2;
        } else {
            // memchr3 only matches '"', '\\' and '\n'.
            debug_assert_eq!(b, b'\n');
            out[*pos] = b'\\';
            out[*pos + 1] = b'n';
            *pos += 2;
        }

        offset = idx + 1;
    }

    // Trailing run after the last special — may contain control chars.
    write_escaped_run(out, pos, &bytes[offset..]);
}

/// Parse cookies from `input` and write JSON to `out` with max_pairs limit.
#[inline]
pub fn cookie_json_into_slice(
    input: &[u8],
    out: &mut [u8],
    max_pairs: usize,
) -> std::result::Result<usize, String> {
    if out.len() < 2 {
        return Err("output buffer too small for cookie JSON".to_string());
    }

    out[0] = b'{';
    let mut pos = 1usize;

    for (count, (name, value)) in cookie_pairs(input).take(max_pairs).enumerate() {
        let needed =
            (if count == 0 { 0 } else { 1 }) + 5 + json_escaped_len(name) + json_escaped_len(value);

        if needed > out.len().saturating_sub(pos) {
            return Err("output buffer too small for cookie JSON".to_string());
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
        return Err("output buffer too small for cookie JSON".to_string());
    }

    out[pos] = b'}';
    pos += 1;
    Ok(pos)
}

/// Parse packed query pairs and write JSON to `out` with max_pairs limit.
///
/// Test-only reference oracle: the ingress hot path uses the single-pass
/// `query_to_json_into_slice` (which superseded the two-step pipeline this
/// helper represents); `unit_tests.rs` keeps it as the byte-parity reference.
#[cfg(test)]
pub fn packed_pairs_to_json_into_slice(
    packed: &[u8],
    out: &mut [u8],
    max_pairs: usize,
) -> std::result::Result<usize, String> {
    let read_u32 = |data: &[u8], offset: usize| -> Option<u32> {
        let slice = data.get(offset..offset + 4)?;
        Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    };

    if out.len() < 2 {
        return Err("output buffer too small for packed pairs JSON".to_string());
    }

    if packed.len() < 4 {
        out[0..2].copy_from_slice(b"{}");
        return Ok(2);
    }

    let count =
        read_u32(packed, 0).ok_or_else(|| "packed pairs: truncated count".to_string())? as usize;

    out[0] = b'{';
    let mut pos = 1usize;
    let mut src = 4usize;

    for (written_pairs, _) in (0..count).enumerate() {
        if written_pairs >= max_pairs {
            break;
        }

        let key_len = read_u32(packed, src)
            .ok_or_else(|| "packed pairs: truncated key length".to_string())?
            as usize;
        src += 4;

        if src + key_len > packed.len() {
            return Err("packed pairs: truncated key".to_string());
        }

        let key = &packed[src..src + key_len];
        src += key_len;

        let val_len = read_u32(packed, src)
            .ok_or_else(|| "packed pairs: truncated value length".to_string())?
            as usize;
        src += 4;

        if src + val_len > packed.len() {
            return Err("packed pairs: truncated value".to_string());
        }

        let val = &packed[src..src + val_len];
        src += val_len;

        let needed = (if written_pairs == 0 { 0 } else { 1 })
            + 5
            + json_escaped_len(key)
            + json_escaped_len(val);

        if needed > out.len().saturating_sub(pos) {
            return Err("output buffer too small for packed pairs JSON".to_string());
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
        return Err("output buffer too small for packed pairs JSON".to_string());
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

        // Percent-encoding fast path: a component with no `%` and no `+`
        // decodes to itself (Cow::Borrowed), so we skip the decode scratch and
        // both extra passes, writing the borrowed slices straight to JSON. This
        // is the common case (`?page=1&limit=20`-style queries) and removes one
        // heap allocation + decode per pair per request on the ingress hot path.
        if memchr::memchr2(b'%', b'+', pair).is_none() {
            let key_len = json_escaped_len(key);
            let val_len = json_escaped_len(value);

            let needed = (if written_pairs == 0 { 0 } else { 1 }) + 5 + key_len + val_len;
            if needed > out.len().saturating_sub(pos) {
                return Err(QueryJsonError::BufferTooSmall);
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
            write_json_escaped(out, &mut pos, value);
            out[pos] = b'"';
            pos += 1;

            written_pairs += 1;
            continue;
        }

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

#[cfg(test)]
mod tests {
    use super::{
        cookie_json_into_slice, json_escaped_len, packed_pairs_to_json_into_slice,
        query_to_json_into_slice, write_json_escaped, QueryJsonError,
    };

    #[test]
    fn json_escaped_len_plain_ascii() {
        assert_eq!(json_escaped_len(b"hello world"), 11);
    }

    #[test]
    fn json_escaped_len_quotes_and_backslash() {
        // "a\"b" -> a, \", b = 3 chars + 1 extra for the escaped quote.
        assert_eq!(json_escaped_len(b"a\"b"), 4);
        // backslash doubles: bytes a, \, b = 3 -> 4 escaped.
        assert_eq!(json_escaped_len(b"a\\b"), 4);
    }

    #[test]
    fn json_escaped_len_newline() {
        assert_eq!(json_escaped_len(b"a\nb"), 4);
    }

    #[test]
    fn json_escaped_len_control_char_wide() {
        // 0x01 must be escaped as \u0001 -> 6 bytes for 1 input byte.
        assert_eq!(json_escaped_len(&[b'a', 0x01, b'b']), 8);
    }

    #[test]
    fn json_escaped_len_short_control_escapes() {
        // \r, \t, \x08, \x0c are written as 2-byte escapes, each contributing
        // +1. (memchr3 only finds ", \, \n; the run scanner handles these.)
        assert_eq!(json_escaped_len(b"a\rb"), 4); // a, \r, b
        assert_eq!(json_escaped_len(b"a\tb"), 4);
        assert_eq!(json_escaped_len(&[b'a', 0x08, b'b']), 4);
        assert_eq!(json_escaped_len(&[b'a', 0x0c, b'b']), 4);
        // Mixed: newline (memchr3 path) + tab (trailing path).
        assert_eq!(json_escaped_len(b"a\n\tb"), 6);
    }

    #[test]
    fn json_escaped_len_fused_matches_write_on_utf8_corpus() {
        // The fused len (single pass: memchr3 + gap UTF-8 validation) must exactly
        // equal the bytes `write_json_escaped` emits for valid non-ASCII UTF-8 AND
        // invalid UTF-8 (where every byte becomes \u00XX).
        let cases: &[&[u8]] = &[
            "héllo wörld".as_bytes(), // valid non-ASCII, no escapes
            "caf\u{00e9} \u{201c}quoted\u{201d}".as_bytes(), // valid with escapes
            &[b'a', 0xC3, 0xA9, b'b'], // é valid
            &[b'"', 0xC3, 0xA9, b'\\'], // escapes + multibyte
            &[0xFF, 0xFE, b'a'],      // invalid UTF-8
            &[b'a', 0x80, b'b'],      // lone continuation byte
            &[0xC3, b' ', b'x'],      // truncated multibyte
            &[b'a', b'\\', 0xFF, b'\n', 0x01], // mixed invalid + escapes
            "日本語のテキスト".as_bytes(), // pure multibyte, no ASCII
        ];
        for input in cases {
            let len = json_escaped_len(input);
            let mut out = vec![0u8; len];
            let mut pos = 0usize;
            write_json_escaped(&mut out, &mut pos, input);
            assert_eq!(pos, len, "len must match written for {input:?}");
        }
    }

    #[test]
    fn json_escaped_len_invalid_utf8_is_len_times_six() {
        let cases: &[&[u8]] = &[
            &[0xFF, 0xFE],
            &[b'a', 0x80, b'b'],
            &[0xC3, b' '],
            &[b'a', b'\\', 0xFF],
        ];
        for input in cases {
            let len = json_escaped_len(input);
            assert_eq!(len, input.len() * 6, "input: {input:?}");
        }
    }

    #[test]
    fn write_json_escaped_never_overflows_exact_buffer() {
        // Regression: a buffer sized EXACTLY by json_escaped_len must never
        // overflow. Before the fix, \r/\t/\x08/\x0c were undercounted → the write
        // past the end panicked (caught by napi → 500) or corrupted memory.
        let cases: &[&[u8]] = &[
            b"a\rb",
            b"a\tb",
            &[b'a', 0x08, b'b'],
            &[b'a', 0x0c, b'b'],
            b"cookie=1; other=2\r\n\t",
            b"\t\r\x08\x0c\"\\\n\x01\x1f",
        ];

        for input in cases {
            let len = json_escaped_len(input);
            let mut out = vec![0u8; len];
            let mut pos = 0usize;
            write_json_escaped(&mut out, &mut pos, input);
            assert_eq!(
                pos, len,
                "must write exactly json_escaped_len bytes: {input:?}"
            );
        }
    }

    #[test]
    fn write_json_escaped_escapes_control_before_special() {
        // Regression: control chars that appear BEFORE a memchr3 special (", \,
        // \n) must still be escaped. Previously they were copied raw into the JSON
        // string → RFC-8259-invalid output (e.g. a cookie value `a\tb"c` or a URL
        // query `?q=%09%22`). The length accounting must match the write exactly.
        let cases: &[(&[u8], &[u8])] = &[
            // a\rb"c → a \\r b \"
            (
                b"a\rb\"c",
                b"a\\rb\\\"c", // \r → \\r, " → \"
            ),
            // a\tb\\c → a \t b \ \
            (
                b"a\tb\\c",
                b"a\\tb\\\\c", // \t → \\t, \ → \\
            ),
            // 0x01 before \n → \u0001 then \n
            (b"a\x01b\nc", b"a\\u0001b\\nc"),
        ];

        for (input, expected) in cases {
            let len = json_escaped_len(input);
            let mut out = vec![0u8; len];
            let mut pos = 0usize;
            write_json_escaped(&mut out, &mut pos, input);
            assert_eq!(pos, len, "accounting must be exact for {input:?}");
            assert_eq!(
                &out[..pos],
                *expected,
                "output must be valid JSON for {input:?}"
            );
        }
    }

    #[test]
    fn cookie_json_into_slice_short_control_escapes() {
        // Cookie values containing \r/\t must serialize correctly into a buffer
        // sized by the (fixed) length accounting.
        let mut out = vec![0u8; 256];
        let written = cookie_json_into_slice(b"a=va\tl; b=x\ry", &mut out, 100).unwrap();
        assert_eq!(&out[..written], b"{\"a\":\"va\\tl\",\"b\":\"x\\ry\"}");
    }

    #[test]
    fn cookie_json_into_slice_output() {
        let mut out = vec![0u8; 256];
        let written = cookie_json_into_slice(b"a=1; b=hello world", &mut out, 100).unwrap();
        assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"hello world\"}");
    }

    #[test]
    fn cookie_json_into_slice_unwraps_dquote() {
        let mut out = vec![0u8; 256];
        // RFC 6265 §5.2: a DQUOTE-wrapped cookie value is unwrapped before
        // serializing (matches the JS fallback + the native cookie parser).
        let written = cookie_json_into_slice(b"k=\"v\"", &mut out, 100).unwrap();
        assert_eq!(&out[..written], b"{\"k\":\"v\"}");
        // JSON escaping still applies to unquoted values with special characters.
        let written = cookie_json_into_slice(b"k=a\"b", &mut out, 100).unwrap();
        assert_eq!(&out[..written], b"{\"k\":\"a\\\"b\"}");
    }

    #[test]
    fn cookie_json_into_slice_small_buffer_errors() {
        let mut out = vec![0u8; 8];
        let res = cookie_json_into_slice(b"a=1; b=2; c=3; d=4", &mut out, 100);
        assert!(
            res.is_err(),
            "truncation must surface as an error, not silent data loss"
        );
    }

    #[test]
    fn packed_pairs_to_json_into_slice_output() {
        // Build packed query pairs for a=1 & b=2 via the query parser, then serialize.
        let packed = crate::http::query_parser::query_parse_packed_vec(b"a=1&b=2").unwrap();
        let mut out = vec![0u8; 256];
        let written = packed_pairs_to_json_into_slice(&packed, &mut out, 100).unwrap();
        assert_eq!(&out[..written], b"{\"a\":\"1\",\"b\":\"2\"}");
    }

    #[test]
    fn query_to_json_into_slice_matches_packed_pipeline() {
        // The direct writer must produce byte-identical output to the two-step
        // query_parse_packed_vec + packed_pairs_to_json_into_slice pipeline it
        // replaces on the ingress hot path.
        let cases: &[&[u8]] = &[
            b"a=1&b=2",
            b"name=John%20Doe&q=a+b",
            b"flag",
            b"",
            b"x=%41%42",
            b"a=%ZZ",
            b"k=%E2%82%AC", // euro (valid UTF-8 after decode)
            b"weird=%FF",   // invalid UTF-8 after decode (binary escape path)
            b"a=1&a=2&a=3",
            b"spaces=+a+b+c+",
        ];
        for &raw in cases {
            let packed = crate::http::query_parser::query_parse_packed_vec(raw);
            let mut direct_out = vec![0u8; 512];
            let direct = query_to_json_into_slice(raw, &mut direct_out, 100);
            match (&packed, &direct) {
                (Ok(packed), Ok(written)) => {
                    let mut ref_out = vec![0u8; 512];
                    let ref_written =
                        packed_pairs_to_json_into_slice(packed, &mut ref_out, 100).unwrap();
                    assert_eq!(
                        &direct_out[..*written],
                        &ref_out[..ref_written],
                        "query={raw:?}"
                    );
                }
                (Err(_), Err(QueryJsonError::Malformed)) => {} // both reject malformed %XX
                (other, _) => {
                    panic!("mismatched outcome for query={raw:?}: {other:?} vs {direct:?}")
                }
            }
        }

        // Buffer-too-small must surface as BufferTooSmall (→ truncated), not Malformed.
        let mut tiny = vec![0u8; 2];
        assert!(matches!(
            query_to_json_into_slice(b"a=1", &mut tiny, 100),
            Err(QueryJsonError::BufferTooSmall)
        ));
    }
}
