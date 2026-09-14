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

/// Decode failure modes for the form-component decoders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormDecodeError {
    /// Malformed `%XX` (truncated / non-hex digit) or a decoded byte sequence
    /// that is not valid UTF-8 — exactly what JS's `decodeURIComponent` throws
    /// `URIError` on. Reported by [`decode_form_component_strict_into`]; the
    /// lenient [`decode_form_component_into`] answers with the RAW component
    /// instead (JS's `catch` arm).
    Malformed,
    /// `out` cannot hold the decoded result.
    BufferTooSmall,
}

/// SIMD-accelerated UTF-8 validation (the crate `http::url_codec` already uses,
/// so the whole HTTP surface validates with the same implementation).
#[inline]
fn is_valid_utf8(bytes: &[u8]) -> bool {
    simdutf8::basic::from_utf8(bytes).is_ok()
}

/// THE form-component decoder: `+` → space, `%XX` → byte, bulk-copying plain
/// runs between them, and validating the result's UTF-8 shape.
///
/// This is the single place URL-form decoding happens. Its callers differ only
/// in their FAILURE ARM:
///
/// * [`decode_form_component_into`] — lenient, JS `decodeURIComponent`
///   semantics: `try { decodeURIComponent(s.replace(/\+/g, " ")) } catch { return s }`.
///   Used by the packed pair parsers (query/form) and the native route stack,
///   which must answer exactly like the pure-TS fallback.
/// * [`decode_form_component_strict_into`] — `Malformed` is a real error, for
///   callers that map a bad component to a 400 (query → JSON).
///
/// Keeping one core means the two can never drift apart again — which is how
/// the packed parser ended up erroring on input the JS fallback happily
/// returned raw.
///
/// `Malformed` is exactly the set JS rejects: a truncated/non-hex `%XX`, and a
/// decoded sequence that is not valid UTF-8 (overlong encodings, surrogate
/// halves and > U+10FFFF fail `simdutf8` and `decodeURIComponent` alike).
///
/// The decoded length never exceeds `src.len()`, so a caller that sizes `out`
/// to the input can only observe [`FormDecodeError::BufferTooSmall`] when it
/// passed a smaller tail of a larger buffer.
#[inline]
fn decode_form_core(src: &[u8], out: &mut [u8]) -> std::result::Result<usize, FormDecodeError> {
    // Nothing to decode at all (the overwhelming majority of components): a
    // verbatim copy. No UTF-8 check — an undecoded component is passed through
    // byte-for-byte, exactly like the JS fallback's `indexOf` early return.
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
    // ASCII output is trivially valid UTF-8, so the validator is only paid when
    // a high byte actually reaches the result (same discipline as `url_codec`).
    let mut saw_high = false;
    while i < src.len() {
        match memchr::memchr2(b'+', b'%', &src[i..]) {
            Some(rel) => {
                let run_end = i + rel;
                let run = &src[i..run_end];
                if written + run.len() > out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written..written + run.len()].copy_from_slice(run);
                saw_high |= !run.is_ascii();
                written += run.len();
                i = run_end;

                // Decode the '+' or '%XX' at position i.
                let (b, next) = match src[i] {
                    b'+' => (b' ', i + 1),
                    _ => {
                        let (byte, next) =
                            decode_percent_at(src, i).ok_or(FormDecodeError::Malformed)?;
                        (byte, next)
                    }
                };
                if written >= out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written] = b;
                saw_high |= b >= 0x80;
                written += 1;
                i = next;
            }
            None => {
                let run = &src[i..];
                if written + run.len() > out.len() {
                    return Err(FormDecodeError::BufferTooSmall);
                }
                out[written..written + run.len()].copy_from_slice(run);
                saw_high |= !run.is_ascii();
                written += run.len();
                i = src.len();
            }
        }
    }
    if saw_high && !is_valid_utf8(&out[..written]) {
        return Err(FormDecodeError::Malformed);
    }
    Ok(written)
}

/// Copy `src` verbatim into `out` — the raw fallback of the lenient contract.
#[inline]
fn write_raw_component(src: &[u8], out: &mut [u8]) -> std::result::Result<usize, FormDecodeError> {
    if out.len() < src.len() {
        return Err(FormDecodeError::BufferTooSmall);
    }
    out[..src.len()].copy_from_slice(src);
    Ok(src.len())
}

/// URL-decode a form component (`+` → space, `%XX` → byte) into `out` with
/// **JS `decodeURIComponent` fallback semantics**, returning bytes written.
///
/// Per COMPONENT (name and value decode independently):
///
/// 1. no `%` and no `+` → copied verbatim;
/// 2. otherwise `+` → space and `%XX` → byte;
/// 3. a malformed escape (truncated or non-hex) → the WHOLE component is
///    returned RAW — note `+` stays `+`, because JS's `catch` returns the
///    string it was given, before the `+` replacement;
/// 4. a decoded sequence that is not valid UTF-8 → the whole component RAW.
///
/// That is `try { decodeURIComponent(s.replace(/\+/g, " ")) } catch { return s }`
/// — the pure-TS fallback swallows the `URIError` and the native path must too,
/// or a single bad escape turns a public request into a 500 (and a divergent
/// parse) instead of a raw field.
#[inline]
pub fn decode_form_component_into(
    src: &[u8],
    out: &mut [u8],
) -> std::result::Result<usize, FormDecodeError> {
    match decode_form_core(src, out) {
        Ok(written) => Ok(written),
        Err(FormDecodeError::Malformed) => write_raw_component(src, out),
        Err(e) => Err(e),
    }
}

/// Compute the decoded length of `src` WITHOUT writing — the exact-size pass for
/// the C-ABI "needed size" convention (run ONCE on a buffer miss, so the caller
/// can `growExact` and retry instead of a doubling loop).
///
/// Reports [`FormDecodeError::Malformed`] exactly when the writer would (the
/// raw fallback reports `src.len()`), so the reported size and the written size
/// can never disagree — a mismatch would make the caller's grow-and-retry loop
/// spin forever.
///
/// One conservative case is deliberate: when the decoded output contains a
/// non-ASCII byte, the result MAY be invalid UTF-8 and the writer would then
/// emit the raw component (longer than the decoded form), so `src.len()` is
/// reported. Over-reporting only costs the caller a few buffer bytes (the C fn
/// still returns the true written length); under-reporting would hang.
#[inline]
pub fn decode_form_component_len(src: &[u8]) -> usize {
    if memchr::memchr2(b'+', b'%', src).is_none() {
        return src.len();
    }
    let mut i = 0usize;
    let mut written = 0usize;
    let mut saw_high = false;
    while i < src.len() {
        match memchr::memchr2(b'+', b'%', &src[i..]) {
            Some(rel) => {
                let run_end = i + rel;
                written += rel;
                saw_high |= !src[i..run_end].is_ascii();
                i = run_end;
                match src[i] {
                    b'+' => {
                        written += 1;
                        i += 1;
                    }
                    _ => match decode_percent_at(src, i) {
                        Some((byte, next)) => {
                            written += 1;
                            saw_high |= byte >= 0x80;
                            i = next;
                        }
                        // Malformed → the writer emits the raw component, so
                        // the raw length is the exact answer here.
                        None => return src.len(),
                    },
                }
            }
            None => {
                written += src.len() - i;
                saw_high |= !src[i..].is_ascii();
                i = src.len();
            }
        }
    }
    if saw_high {
        src.len()
    } else {
        written
    }
}

/// Decode a form component into a reusable scratch buffer, returning the
/// decoded bytes — or `src` itself when nothing needed decoding. The shared
/// entry point for Vec-based callers (the native route stack); the returned
/// slice borrows either `src` or `scratch`, so it is valid only until the next
/// call with the same scratch.
#[inline]
pub fn decode_form_component_scratch<'a>(src: &'a [u8], scratch: &'a mut Vec<u8>) -> &'a [u8] {
    // Fast path: nothing to decode (the overwhelming majority of segments).
    if memchr::memchr2(b'+', b'%', src).is_none() {
        return src;
    }
    if scratch.len() < src.len() {
        scratch.resize(src.len(), 0);
    }
    match decode_form_component_into(src, scratch.as_mut_slice()) {
        Ok(n) => &scratch[..n],
        // Unreachable: the buffer is input-sized, and the decoded length never
        // exceeds the input.
        Err(_) => src,
    }
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
        // A NUL is a legal decode target (U+0000), not an error.
        assert_eq!(decode(b"%00"), b"\x00");
        assert_eq!(decode(b"%2f"), b"/");
    }

    #[test]
    fn decode_form_decodeuri_semantics_table() {
        // The contract is `try { decodeURIComponent(s.replace(/\+/g," ")) }
        // catch { return s }` — verified against Bun's `decodeURIComponent`.
        let cases: &[(&[u8], &[u8])] = &[
            // (input, JS result)
            (b"a=%C3", b"a=%C3"), // truncated multibyte → URIError → raw
            (b"a=%2", b"a=%2"),   // truncated escape → raw
            (b"a=%", b"a=%"),     // dangling % → raw
            (b"a=%2G", b"a=%2G"), // non-hex digit → raw
            (b"a=%FF", b"a=%FF"), // invalid UTF-8 byte → raw
            (b"a=%ED%A0%80", b"a=%ED%A0%80"), // surrogate half → raw
            (b"a=%C0%80", b"a=%C0%80"), // overlong encoding → raw
            (b"a=%F4%90%80%80", b"a=%F4%90%80%80"), // > U+10FFFF → raw
            (b"bad=%ZZ", b"bad=%ZZ"), // non-hex → raw
            (b"100%", b"100%"),   // trailing % → raw
            // The whole component goes raw — including a '+' that the decode
            // would otherwise have turned into a space (the JS catch returns
            // the string it was given, before the replace).
            (b"a+b=%ZZ", b"a+b=%ZZ"),
            (b"a+b=%20", b"a b= "),   // valid → decoded
            (b"%C3%A9", b"\xC3\xA9"), // valid multibyte → decoded
        ];
        for (input, expected) in cases {
            assert_eq!(
                decode(input).as_slice(),
                *expected,
                "lenient decode of {:?}",
                core::str::from_utf8(input).unwrap_or("<non-utf8>")
            );
        }
    }

    #[test]
    fn decode_form_needed_size_matches_written_size() {
        // The C-ABI "needed size" pass must equal what the writer produces for
        // EVERY input — a mismatch would spin the caller's grow-and-retry loop.
        // It may only over-report (never under-report) when the decoded form
        // could be invalid UTF-8.
        let cases: &[&[u8]] = &[
            b"",
            b"a",
            b"a=1&b=2",
            b"%ZZ",
            b"a=%C3",
            b"a=%FF",
            b"a=%ED%A0%80",
            b"q=hello+world",
            b"u=%E2%9C%93",
            b"\xFF\xFE", // non-UTF-8 passthrough
            b"a=%E2%9C%93&b%ZZ=1",
            b"x%",
        ];
        for src in cases {
            let mut out = vec![0u8; src.len() + 16];
            let written = decode_form_component_into(src, &mut out).unwrap();
            let reported = decode_form_component_len(src);
            assert!(
                reported >= written,
                "reported {reported} < written {written} for {:?}",
                core::str::from_utf8(src).unwrap_or("<non-utf8>")
            );
            // An exact-size buffer must succeed and agree with the report.
            let mut exact = vec![0u8; reported];
            assert_eq!(
                decode_form_component_into(src, &mut exact).unwrap(),
                written,
                "exact-size decode disagreed for {:?}",
                core::str::from_utf8(src).unwrap_or("<non-utf8>")
            );
        }
    }

    #[test]
    fn decode_form_scratch_matches_slice_decoder() {
        let mut scratch: Vec<u8> = Vec::new();
        for input in [
            &b"plain"[..],
            b"a+b",
            b"a=%20b",
            b"%ZZ",
            b"%C3",
            b"a=%E2%9C%93",
        ] {
            let via_scratch = decode_form_component_scratch(input, &mut scratch).to_vec();
            assert_eq!(via_scratch.as_slice(), decode(input).as_slice());
        }
    }

    #[test]
    fn cookie_pairs_unwraps_dquote() {
        let pairs: Vec<(&[u8], &[u8])> =
            cookie_pairs(b"a=1; b=\"quoted value\"; c=\"\"; d=\"abc; empty=").collect();
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
        let pairs: Vec<(&[u8], &[u8])> = cookie_pairs(b"a=\"abc; b=ab\"c; c=\"quote").collect();
        assert_eq!(
            pairs,
            vec![
                (&b"a"[..], &b"\"abc"[..]),
                (&b"b"[..], &b"ab\"c"[..]),
                (&b"c"[..], &b"\"quote"[..]),
            ]
        );
    }
    #[test]
    #[should_panic(expected = "hex_encode: output buffer too small")]
    fn hex_encode_panics_on_undersized() {
        let mut out = [0u8; 4];
        super::hex_encode(b"abcd", &mut out);
    }
}
