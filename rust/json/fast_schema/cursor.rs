// rust/json/fast_schema/cursor.rs — Byte-level JSON cursor + string/unicode helpers.
//
// A `Cursor` walks raw JSON bytes with no allocations. It is used by both the
// validator (validate.rs) and the structural `skip_value` fast path. The
// string helpers decode escaped string bodies (only needed for the rare
// escaped-key path and for counting Unicode scalar values).

/// A cursor over raw JSON bytes.
pub(crate) struct Cursor<'a> {
    pub(crate) data: &'a [u8],
    pub(crate) pos: usize,
}

impl<'a> Cursor<'a> {
    #[inline]
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    #[inline]
    pub(crate) fn skip_ws(&mut self) {
        while let Some(&b) = self.data.get(self.pos) {
            match b {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    #[inline]
    pub(crate) fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    #[inline]
    pub(crate) fn eat(&mut self, b: u8) -> bool {
        if self.peek() == Some(b) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    #[inline]
    pub(crate) fn eat_token(&mut self, tok: &[u8]) -> bool {
        if self.data.get(self.pos..self.pos + tok.len()) == Some(tok) {
            self.pos += tok.len();
            true
        } else {
            false
        }
    }

    /// Parse a JSON string token, returning the raw inner slice (between the
    /// quotes). Escapes are validated as escape characters and skipped, but
    /// not decoded. Returns `None` on malformed strings.
    pub(crate) fn raw_string(&mut self) -> Option<&'a [u8]> {
        if !self.eat(b'"') {
            return None;
        }
        let start = self.pos;
        let mut i = self.pos;
        while i < self.data.len() {
            // SIMD: find the next `"` or `\` in bulk. A string body is usually
            // long runs of plain bytes, so memchr2 is much faster than the old
            // byte-at-a-time loop over every key and string value. `?` returns
            // None for an unterminated string (no closing quote).
            let rel = memchr::memchr2(b'"', b'\\', &self.data[i..])?;
            i += rel;
            if self.data[i] == b'"' {
                self.pos = i + 1;
                return Some(&self.data[start..i]);
            }
            // Escape: validate the escape char and skip it.
            let e = *self.data.get(i + 1)?;
            if !matches!(
                e,
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' | b'u'
            ) {
                return None;
            }
            i += 2;
        }
        None
    }

    /// Parse a JSON number token; returns `(value, integer_syntax)`.
    pub(crate) fn number(&mut self) -> Option<(f64, bool)> {
        let start = self.pos;
        let _ = self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return None,
        }
        let mut is_int = true;
        if self.peek() == Some(b'.') {
            is_int = false;
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            is_int = false;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let tok = &self.data[start..self.pos];
        let n: f64 = std::str::from_utf8(tok).ok()?.parse().ok()?;
        Some((n, is_int))
    }

    /// Skip one complete JSON value (for `true`/`{}`/`additionalProperties: true`).
    pub(crate) fn skip_value(&mut self) -> bool {
        self.skip_ws();
        let Some(b) = self.peek() else {
            return false;
        };
        match b {
            b'{' => {
                self.pos += 1;
                self.skip_ws();
                if self.eat(b'}') {
                    return true;
                }
                loop {
                    if self.raw_string().is_none() {
                        return false;
                    }
                    self.skip_ws();
                    if !self.eat(b':') {
                        return false;
                    }
                    if !self.skip_value() {
                        return false;
                    }
                    self.skip_ws();
                    if self.eat(b'}') {
                        return true;
                    }
                    if !self.eat(b',') {
                        return false;
                    }
                    self.skip_ws();
                }
            }
            b'[' => {
                self.pos += 1;
                self.skip_ws();
                if self.eat(b']') {
                    return true;
                }
                loop {
                    if !self.skip_value() {
                        return false;
                    }
                    self.skip_ws();
                    if self.eat(b']') {
                        return true;
                    }
                    if !self.eat(b',') {
                        return false;
                    }
                    self.skip_ws();
                }
            }
            b'"' => self.raw_string().is_some(),
            b't' => self.eat_token(b"true"),
            b'f' => self.eat_token(b"false"),
            b'n' => self.eat_token(b"null"),
            b'-' | b'0'..=b'9' => self.number().is_some(),
            _ => false,
        }
    }
}

/// True when every byte is ASCII (< 0x80), checked word-at-a-time.
#[inline]
fn is_ascii(bytes: &[u8]) -> bool {
    let mut chunks = bytes.chunks_exact(8);
    for chunk in &mut chunks {
        // SAFETY-free: chunks_exact guarantees exactly 8 bytes here.
        let w = u64::from_le_bytes(
            <[u8; 8]>::try_from(chunk).expect("chunks_exact yields 8 bytes"),
        );
        if (w & 0x8080_8080_8080_8080) != 0 {
            return false;
        }
    }
    for &b in chunks.remainder() {
        if b >= 0x80 {
            return false;
        }
    }
    true
}

/// Count Unicode scalar values (JSON Schema string length) in a raw JSON
/// string body, handling escapes including surrogate pairs.
pub(crate) fn count_chars(inner: &[u8]) -> usize {
    // Fast path: no escape sequences and pure ASCII -> one scalar per byte.
    // `contains` (memchr) and `is_ascii` (word-at-a-time) are both SIMD, so
    // the common ASCII name/value case is O(1)-ish instead of byte-at-a-time.
    if !inner.contains(&b'\\') && is_ascii(inner) {
        return inner.len();
    }
    let mut chars = 0usize;
    let mut i = 0usize;
    while i < inner.len() {
        let b = inner[i];
        if b == b'\\' {
            if i + 1 >= inner.len() {
                break;
            }
            if inner[i + 1] == b'u' {
                chars += 1;
                i += 6;
                // High surrogate followed by a low surrogate is ONE scalar value.
                if i + 6 <= inner.len()
                    && inner.get(i..i + 2) == Some(b"\\u")
                    && hex4(inner.get(i - 4..i)).is_some_and(|hi| (0xD800..=0xDBFF).contains(&hi))
                    && hex4(inner.get(i + 2..i + 6))
                        .is_some_and(|lo| (0xDC00..=0xDFFF).contains(&lo))
                {
                    i += 6;
                }
            } else {
                chars += 1;
                i += 2;
            }
        } else if b < 0x80 {
            chars += 1;
            i += 1;
        } else {
            chars += 1;
            i += match b {
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                _ => 1,
            };
        }
    }
    chars
}

fn hex4(hex: Option<&[u8]>) -> Option<u16> {
    let hex = hex?;
    if hex.len() != 4 {
        return None;
    }
    let mut v = 0u16;
    for &c in hex {
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => return None,
        };
        v = v * 16 + d as u16;
    }
    Some(v)
}

fn push_cp(out: &mut Vec<u8>, cp: u32) {
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push(0xC0 | (cp >> 6) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else if cp < 0x10000 {
        out.push(0xE0 | (cp >> 12) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else {
        out.push(0xF0 | (cp >> 18) as u8);
        out.push(0x80 | ((cp >> 12) & 0x3F) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    }
}

/// Decode a raw JSON string body into literal bytes. Only used for object keys
/// that contain escapes (rare); the common no-escape path is a zero-alloc
/// slice lookup.
pub(crate) fn decode_string(inner: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(inner.len());
    let mut i = 0usize;
    while i < inner.len() {
        let b = inner[i];
        if b == b'\\' && i + 1 < inner.len() {
            let e = inner[i + 1];
            i += 2;
            match e {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b'/' => out.push(b'/'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'u' => {
                    if let Some(h) = hex4(inner.get(i..i + 4)) {
                        i += 4;
                        if (0xD800..=0xDBFF).contains(&h) {
                            let low = inner
                                .get(i..i + 2)
                                .filter(|s| **s == *b"\\u")
                                .and_then(|_| hex4(inner.get(i + 2..i + 6)));
                            if let Some(l) = low.filter(|l| (0xDC00..=0xDFFF).contains(l)) {
                                i += 6;
                                let cp =
                                    0x10000 + (((h as u32) - 0xD800) << 10) + ((l as u32) - 0xDC00);
                                push_cp(&mut out, cp);
                            } else {
                                // Lone high surrogate: encode as replacement char.
                                push_cp(&mut out, 0xFFFD);
                            }
                        } else {
                            push_cp(&mut out, h as u32);
                        }
                    } else {
                        out.push(b'u');
                    }
                }
                _ => out.push(b),
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}
