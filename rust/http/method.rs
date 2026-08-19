// rust/http/method.rs — HTTP method classification
// Uses the shared word-at-a-time byte helpers from `bytes.rs`.

use crate::util::bytes::{ascii_eq_ignore_case, load_u64_padded};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MethodKind {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Other,
}

const METHOD_GET: u64 = u64::from_le_bytes(*b"GET\0\0\0\0\0");
const METHOD_HEAD: u64 = u64::from_le_bytes(*b"HEAD\0\0\0\0");
const METHOD_POST: u64 = u64::from_le_bytes(*b"POST\0\0\0\0");
const METHOD_PUT: u64 = u64::from_le_bytes(*b"PUT\0\0\0\0\0");
const METHOD_PATCH: u64 = u64::from_le_bytes(*b"PATCH\0\0\0");
const METHOD_DELETE: u64 = u64::from_le_bytes(*b"DELETE\0\0");
const METHOD_OPTIONS: u64 = u64::from_le_bytes(*b"OPTIONS\0");

impl MethodKind {
    /// Classify HTTP method from a `&str` (case-sensitive, exact match).
    #[allow(clippy::should_implement_trait)]
    #[inline(always)]
    pub fn from_str(method: &str) -> Self {
        let bytes = method.as_bytes();
        let loaded = load_u64_padded(bytes);

        match bytes.len() {
            3 if loaded == METHOD_GET => Self::Get,
            3 if loaded == METHOD_PUT => Self::Put,
            4 if loaded == METHOD_POST => Self::Post,
            4 if loaded == METHOD_HEAD => Self::Head,
            5 if loaded == METHOD_PATCH => Self::Patch,
            6 if loaded == METHOD_DELETE => Self::Delete,
            7 if loaded == METHOD_OPTIONS => Self::Options,
            _ => Self::Other,
        }
    }

    /// Classify HTTP method from raw bytes, case-insensitively, with zero
    /// allocation (delegates to the shared word-at-a-time comparator).
    #[inline(always)]
    pub fn from_bytes_ignore_case(bytes: &[u8]) -> Self {
        if bytes.len() > 7 {
            return Self::Other;
        }
        if ascii_eq_ignore_case(bytes, b"GET") {
            Self::Get
        } else if ascii_eq_ignore_case(bytes, b"HEAD") {
            Self::Head
        } else if ascii_eq_ignore_case(bytes, b"POST") {
            Self::Post
        } else if ascii_eq_ignore_case(bytes, b"PUT") {
            Self::Put
        } else if ascii_eq_ignore_case(bytes, b"PATCH") {
            Self::Patch
        } else if ascii_eq_ignore_case(bytes, b"DELETE") {
            Self::Delete
        } else if ascii_eq_ignore_case(bytes, b"OPTIONS") {
            Self::Options
        } else {
            Self::Other
        }
    }

    /// Classify from u8 discriminator (0-6).
    #[inline(always)]
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Get,
            1 => Self::Head,
            2 => Self::Post,
            3 => Self::Put,
            4 => Self::Patch,
            5 => Self::Delete,
            6 => Self::Options,
            _ => Self::Other,
        }
    }

    /// Returns true if the method may carry a body.
    #[inline(always)]
    pub fn may_have_body(&self) -> bool {
        matches!(self, Self::Post | Self::Put | Self::Patch | Self::Delete)
    }

    /// Returns u8 discriminant for packed format.
    #[inline(always)]
    pub fn to_u8(&self) -> u8 {
        match self {
            Self::Get => 0,
            Self::Head => 1,
            Self::Post => 2,
            Self::Put => 3,
            Self::Patch => 4,
            Self::Delete => 5,
            Self::Options => 6,
            Self::Other => 7,
        }
    }
}

impl MethodKind {
    /// Bitmask representation for fast CORS method matching.
    #[inline(always)]
    pub fn bit(&self) -> u16 {
        1u16 << (self.to_u8() as u16)
    }
}

#[cfg(test)]
mod tests {
    use super::MethodKind;

    #[test]
    fn method_from_bytes_ignore_case_upper() {
        assert_eq!(MethodKind::from_bytes_ignore_case(b"GET"), MethodKind::Get);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"HEAD"), MethodKind::Head);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"POST"), MethodKind::Post);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"PUT"), MethodKind::Put);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"PATCH"), MethodKind::Patch);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"DELETE"), MethodKind::Delete);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"OPTIONS"), MethodKind::Options);
    }

    #[test]
    fn method_from_bytes_ignore_case_lower() {
        assert_eq!(MethodKind::from_bytes_ignore_case(b"get"), MethodKind::Get);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"post"), MethodKind::Post);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"options"), MethodKind::Options);
    }

    #[test]
    fn method_from_bytes_ignore_case_unknown() {
        assert_eq!(MethodKind::from_bytes_ignore_case(b"FETCH"), MethodKind::Other);
        assert_eq!(MethodKind::from_bytes_ignore_case(b""), MethodKind::Other);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"GETX"), MethodKind::Other);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"POSTING"), MethodKind::Other);
    }

    #[test]
    fn method_from_str_upper() {
        assert_eq!(MethodKind::from_str("GET"), MethodKind::Get);
        assert_eq!(MethodKind::from_str("DELETE"), MethodKind::Delete);
        assert_eq!(MethodKind::from_str("WEIRD"), MethodKind::Other);
    }

    #[test]
    fn method_bits_are_distinct() {
        let bits: std::collections::HashSet<u16> = [
            MethodKind::Get,
            MethodKind::Head,
            MethodKind::Post,
            MethodKind::Put,
            MethodKind::Patch,
            MethodKind::Delete,
            MethodKind::Options,
        ]
        .iter()
        .map(|m| m.bit())
        .collect();
        assert_eq!(bits.len(), 7, "each method must have a unique bit");
    }
}
