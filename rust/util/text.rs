// rust/util/text.rs — text utilities (pure core + napi entry points).
//
// Currently: JS-RegExp metacharacter escaping — the "turn untrusted user
// input into a literal substring pattern" utility every search endpoint
// re-implements (usually as a per-request `replace` chain + `new RegExp`
// compile). Escapes exactly the MDN escapeRegExp set:
//   \ . * + ? ^ $ { } | ( ) [ ]
// `-` is only special inside character classes (which escaped-literal input
// never contains), so it is left untouched — matching the de-facto standard.

use napi_derive::napi;

/// The metacharacters escaped by [`regex_escape_into`] /
/// [`regex_escape_write`].
const REGEX_META: &[u8; 14] = b"\\.*+?^${}()|[]";

/// 256-entry membership lookup for [`REGEX_META`] — one table load per byte.
/// The previous per-byte `REGEX_META.contains(&c)` did a linear 14-element
/// scan PER byte (O(n·14)); a 16KB payload took ~100µs (~160MB/s) and the
/// win margin vs JS regex-replace collapsed with size. The LUT makes the hot
/// loop branch-predictable (~1 load/byte), and safe runs are copied in bulk
/// (memcpy) instead of one push per byte.
const REGEX_META_LUT: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0usize;
    while i < REGEX_META.len() {
        t[REGEX_META[i] as usize] = 1;
        i += 1;
    }
    t
};

#[inline(always)]
fn is_meta(b: u8) -> bool {
    REGEX_META_LUT[b as usize] != 0
}

/// Append the RegExp-escaped form of `input` to `out`. ASCII-only transform
/// (backslash before metachar bytes) — multi-byte UTF-8 sequences pass
/// through byte-exact because no UTF-8 continuation byte is a metachar.
/// Safe runs are bulk-copied (memcpy) between metachars, so throughput scales
/// with memory bandwidth, not the metachar-set size.
pub fn regex_escape_into(input: &[u8], out: &mut Vec<u8>) {
    let mut run_start = 0usize;
    for (i, &c) in input.iter().enumerate() {
        if is_meta(c) {
            out.extend_from_slice(&input[run_start..i]);
            out.push(b'\\');
            out.push(c);
            run_start = i + 1;
        }
    }
    out.extend_from_slice(&input[run_start..]);
}

/// Exact escaped length (metachar count + input length) — lets callers size
/// output buffers without running the escape twice.
#[inline]
pub fn regex_escape_len(input: &[u8]) -> usize {
    input.len() + input.iter().filter(|&&b| is_meta(b)).count()
}

/// Write the escaped form of `input` into `out` (which must be at least
/// [`regex_escape_len`] bytes — the C-ABI needed-size path). Returns bytes
/// written.
pub fn regex_escape_write(input: &[u8], out: &mut [u8]) -> usize {
    let mut pos = 0usize;
    let mut run_start = 0usize;
    for (i, &c) in input.iter().enumerate() {
        if is_meta(c) {
            let run = &input[run_start..i];
            out[pos..pos + run.len()].copy_from_slice(run);
            pos += run.len();
            out[pos] = b'\\';
            out[pos + 1] = c;
            pos += 2;
            run_start = i + 1;
        }
    }
    let tail = &input[run_start..];
    out[pos..pos + tail.len()].copy_from_slice(tail);
    pos + tail.len()
}

/// Escape JS RegExp metacharacters in a string → a pattern that matches the
/// input literally inside `new RegExp(escaped)` (any flags).
///
/// @example
/// ```ts
/// new RegExp(regexEscape(userInput), 'i') // safe literal substring match
/// ```
#[napi]
pub fn regex_escape(input: String) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(regex_escape_len(bytes));
    regex_escape_into(bytes, &mut out);
    // Escaping only inserts ASCII backslashes before ASCII bytes, so the
    // result is valid UTF-8 whenever the input was.
    String::from_utf8(out).unwrap_or(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_metacharacters() {
        let mut out = Vec::new();
        regex_escape_into(b".*+?^${}()|[]\\", &mut out);
        assert_eq!(out, b"\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    }

    #[test]
    fn plain_text_passes_through() {
        let mut out = Vec::new();
        regex_escape_into(b"hello world 123", &mut out);
        assert_eq!(out, b"hello world 123");
    }

    #[test]
    fn hyphen_and_slash_untouched() {
        let mut out = Vec::new();
        regex_escape_into(b"a-b/c", &mut out);
        assert_eq!(out, b"a-b/c");
    }

    #[test]
    fn utf8_passes_through_byte_exact() {
        let input = "héllo→世界";
        let mut out = Vec::new();
        regex_escape_into(input.as_bytes(), &mut out);
        assert_eq!(String::from_utf8(out).expect("utf8"), input);
    }

    #[test]
    fn len_matches_written() {
        for case in ["", "plain", "a.b*(c)[d]{e}|f^g$h?i\\j"] {
            let mut out = Vec::new();
            regex_escape_into(case.as_bytes(), &mut out);
            assert_eq!(regex_escape_len(case.as_bytes()), out.len());
        }
    }

    #[test]
    fn write_matches_into() {
        let case = "a.b*(c)[d]{e}|f^g$h?i\\j";
        let mut pushed = Vec::new();
        regex_escape_into(case.as_bytes(), &mut pushed);
        let mut buf = vec![0u8; regex_escape_len(case.as_bytes())];
        let written = regex_escape_write(case.as_bytes(), &mut buf);
        assert_eq!(&buf[..written], &pushed[..]);
    }

    #[test]
    fn escaped_pattern_matches_input_literally() {
        // Round-trip through a tiny backtracking matcher is overkill; instead
        // verify the classic injection is defused: "." would match anything.
        let mut out = Vec::new();
        regex_escape_into(b"a.c", &mut out);
        let escaped = String::from_utf8(out).expect("utf8");
        assert_eq!(escaped, r"a\.c");
    }

    /// Reference escape (the previous per-byte `REGEX_META.contains` loop).
    fn ref_escape(input: &[u8]) -> Vec<u8> {
        const META: &[u8] = b"\\.*+?^${}()|[]";
        let mut out = Vec::new();
        for &c in input {
            if META.contains(&c) {
                out.push(b'\\');
            }
            out.push(c);
        }
        out
    }

    #[test]
    fn regex_escape_matches_reference_for_all_lengths() {
        // Every length 0..=96 plus larger payloads: the LUT + run-copy core
        // (bulk memcpy between metachars) must be byte-identical to the naive
        // per-byte reference. Lengths 15/16/17… straddle no SIMD chunk here
        // (the transform is scalar), but the sweep locks positional behavior:
        // a run-copy off-by-one (dropping or duplicating a safe byte) surfaces.
        let mut lens: Vec<usize> = (0..=96).collect();
        lens.extend([128, 512, 16 * 1024, 256 * 1024]);
        for n in lens {
            let input: Vec<u8> = (0..n).map(|i| (i.wrapping_mul(31) + 5) as u8).collect();
            let expect = ref_escape(&input);
            // allocating path
            let mut out = Vec::new();
            regex_escape_into(&input, &mut out);
            assert_eq!(out, expect, "len {n}");
            // len formula
            assert_eq!(regex_escape_len(&input), expect.len(), "len {n}");
            // write path (exact-size buffer, like the C-ABI caller)
            let mut buf = vec![0u8; expect.len()];
            let written = regex_escape_write(&input, &mut buf);
            assert_eq!(written, expect.len(), "len {n}");
            assert_eq!(&buf[..written], &expect[..], "len {n}");
        }
    }

    #[test]
    fn regex_escape_large_payload_edges() {
        // Three 256 KiB extremes: every byte a metachar (no bulk runs — the
        // worst case for the run-copy core), no metachars at all (pure bulk
        // copy), and a dense alternating pattern. All must match the reference
        // and the exact-length contract.
        let all_meta: Vec<u8> = (0..256 * 1024)
            .map(|i| b"\\.*+?^${}()|[]"[i % 14])
            .collect();
        let none: Vec<u8> = (0..256 * 1024).map(|i| b"abcXYZ0123_-/"[i % 13]).collect();
        let dense: Vec<u8> = (0..256 * 1024)
            .map(|i| if i % 2 == 0 { b'.' } else { b'a' })
            .collect();
        for input in [all_meta, none, dense] {
            let expect = ref_escape(&input);
            let mut out = Vec::new();
            regex_escape_into(&input, &mut out);
            assert_eq!(out, expect);
            assert_eq!(regex_escape_len(&input), expect.len());
            let mut buf = vec![0u8; expect.len()];
            let written = regex_escape_write(&input, &mut buf);
            assert_eq!(written, expect.len());
            assert_eq!(&buf[..written], &expect[..]);
        }
        // All-metachar bound: escaped length is exactly 2x (every byte gets a
        // backslash); all-safe bound: escaped length equals input length.
        assert_eq!(regex_escape_len(&vec![b'.'; 1024]), 2048);
        assert_eq!(regex_escape_len(&vec![b'a'; 1024]), 1024);
    }
}
