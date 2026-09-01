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

/// Append the RegExp-escaped form of `input` to `out`. ASCII-only transform
/// (backslash before metachar bytes) — multi-byte UTF-8 sequences pass
/// through byte-exact because no UTF-8 continuation byte is a metachar.
pub fn regex_escape_into(input: &[u8], out: &mut Vec<u8>) {
    for &c in input {
        if REGEX_META.contains(&c) {
            out.push(b'\\');
        }
        out.push(c);
    }
}

/// Exact escaped length (metachar count + input length) — lets callers size
/// output buffers without running the escape twice.
#[inline]
pub fn regex_escape_len(input: &[u8]) -> usize {
    input.len() + input.iter().filter(|b| REGEX_META.contains(b)).count()
}

/// Write the escaped form of `input` into `out` (which must be at least
/// [`regex_escape_len`] bytes — the C-ABI needed-size path). Returns bytes
/// written.
pub fn regex_escape_write(input: &[u8], out: &mut [u8]) -> usize {
    let mut pos = 0usize;
    for &c in input {
        if REGEX_META.contains(&c) {
            out[pos] = b'\\';
            pos += 1;
        }
        out[pos] = c;
        pos += 1;
    }
    pos
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
}
