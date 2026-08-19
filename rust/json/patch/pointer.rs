// rust/json/patch/pointer.rs — RFC 6901 JSON Pointer (parsing only).
//
// Pure string handling: parse a pointer string into unescaped segments. The
// DOM navigation/resolution that *uses* a pointer lives in `ops.rs`; keeping
// the pointer syntax here makes the RFC 6901 escape rules independently
// testable and keeps `ops.rs` focused on applying operations.

/// A parsed RFC 6901 JSON Pointer (segments already `~0`/`~1`-unescaped).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Pointer {
    pub(crate) segments: Vec<String>,
}

impl Pointer {
    pub(crate) fn root() -> Self {
        Pointer {
            segments: Vec::new(),
        }
    }

    /// Parse an RFC 6901 pointer string. `""` = root; any non-empty pointer
    /// must start with `/`. `~0`→`~`, `~1`→`/`; any other `~x` (including a
    /// trailing `~`) is an invalid escape → `Err` (the caller maps to
    /// `InvalidPatch`, matching the json-patch crate's eager validation).
    pub(crate) fn parse(s: &str) -> std::result::Result<Self, ()> {
        if s.is_empty() {
            return Ok(Self::root());
        }
        if !s.starts_with('/') {
            return Err(());
        }
        let mut segments = Vec::new();
        let mut cur = String::new();
        let mut chars = s[1..].chars();
        while let Some(c) = chars.next() {
            match c {
                '/' => segments.push(std::mem::take(&mut cur)),
                '~' => match chars.next() {
                    Some('0') => cur.push('~'),
                    Some('1') => cur.push('/'),
                    _ => return Err(()),
                },
                other => cur.push(other),
            }
        }
        segments.push(cur);
        Ok(Pointer { segments })
    }
}
