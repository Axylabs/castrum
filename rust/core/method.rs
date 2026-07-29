// rust/core/method.rs — HTTP method classification
// Pure Rust, no napi dependencies.
// Optimized: uses u64 word-at-a-time comparison with zero allocation

#[inline(always)]
fn load_u64_padded(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let len = bytes.len().min(8);
    buf[..len].copy_from_slice(&bytes[..len]);
    u64::from_le_bytes(buf)
}

/// HTTP method classification.
///
/// Provides fast, zero-allocation classification of HTTP methods
/// using u64 word-at-a-time comparison with case-insensitive matching.
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
    /// Classify HTTP method from a `&str`.
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

    /// Classify HTTP method from raw bytes with case-insensitive comparison.
    /// Avoids heap allocation from `to_ascii_uppercase()`.
    #[inline(always)]
    pub fn from_bytes_ignore_case(bytes: &[u8]) -> Self {
        let len = bytes.len();
        if len > 7 {
            return Self::Other;
        }

        let loaded = load_u64_padded(bytes);

        // Mask the 5th bit (0x20) of all alphabetic bytes for case-insensitive comparison.
        let lower = loaded | 0x2020_2020_2020_2020;
        let masked = METHOD_GET | 0x2020_2020_2020_2020;

        match len {
            3 if (lower & 0x00FF_FFFF_FFFF_FFFF) == masked => Self::Get,
            3 if (lower & 0x00FF_FFFF_FFFF_FFFF) == (METHOD_PUT | 0x2020_2020_2020_2020) => Self::Put,
            4 if (lower & 0x0000_FFFF_FFFF_FFFF) == (METHOD_POST | 0x2020_2020_2020_2020) => Self::Post,
            4 if (lower & 0x0000_FFFF_FFFF_FFFF) == (METHOD_HEAD | 0x2020_2020_2020_2020) => Self::Head,
            5 if (lower & 0x0000_00FF_FFFF_FFFF) == (METHOD_PATCH | 0x2020_2020_2020_2020) => Self::Patch,
            6 if (lower & 0x0000_0000_FFFF_FFFF) == (METHOD_DELETE | 0x2020_2020_2020_2020) => Self::Delete,
            7 if (lower & 0x0000_0000_00FF_FFFF) == (METHOD_OPTIONS | 0x2020_2020_2020_2020) => Self::Options,
            _ => Self::Other,
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

    /// Returns `true` if the method may carry a body.
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

    /// Bitmask representation for fast CORS method matching.
    #[inline(always)]
    pub fn bit(&self) -> u16 {
        1u16 << (self.to_u8() as u16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_str() {
        assert_eq!(MethodKind::from_str("GET"), MethodKind::Get);
        assert_eq!(MethodKind::from_str("POST"), MethodKind::Post);
        assert_eq!(MethodKind::from_str("PUT"), MethodKind::Put);
        assert_eq!(MethodKind::from_str("DELETE"), MethodKind::Delete);
        assert_eq!(MethodKind::from_str("OPTIONS"), MethodKind::Options);
        assert_eq!(MethodKind::from_str("UNKNOWN"), MethodKind::Other);
    }

    #[test]
    fn test_from_bytes_ignore_case() {
        assert_eq!(MethodKind::from_bytes_ignore_case(b"get"), MethodKind::Get);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"Post"), MethodKind::Post);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"DELETE"), MethodKind::Delete);
        assert_eq!(MethodKind::from_bytes_ignore_case(b"options"), MethodKind::Options);
    }

    #[test]
    fn test_may_have_body() {
        assert!(MethodKind::Post.may_have_body());
        assert!(MethodKind::Put.may_have_body());
        assert!(!MethodKind::Get.may_have_body());
        assert!(!MethodKind::Head.may_have_body());
        assert!(!MethodKind::Options.may_have_body());
    }
}
