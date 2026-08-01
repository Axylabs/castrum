// rust/method.rs — Extracted HTTP method classification
// Optimized for Bun 1.4: uses u64 word-at-a-time comparison with zero allocation

#[inline(always)]
fn load_u64_padded(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let len = bytes.len().min(8);
    buf[..len].copy_from_slice(&bytes[..len]);
    u64::from_le_bytes(buf)
}

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
    /// Classify HTTP method from a &str.
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
    /// Avoids heap allocation from to_ascii_uppercase().
    #[inline(always)]
    pub fn from_bytes_ignore_case(bytes: &[u8]) -> Self {
        let len = bytes.len();
        if len > 7 {
            return Self::Other;
        }

        let loaded = load_u64_padded(bytes);

        // Mask the 5th bit (0x20) of all alphabetic bytes for case-insensitive comparison.
        let lower = loaded | 0x2020_2020_2020_2020;

        // Zero the bytes beyond `len` on BOTH operands. The mask must be applied
        // to the reference constants too, otherwise the padding bytes (0x20 after
        // the OR above) never match and every method classifies as Other.
        let mask = match len {
            3 => 0x00FF_FFFF_FFFF_FFFFu64,
            4 => 0x0000_FFFF_FFFF_FFFFu64,
            5 => 0x0000_00FF_FFFF_FFFFu64,
            6 => 0x0000_0000_FFFF_FFFFu64,
            7 => 0x0000_0000_00FF_FFFFu64,
            _ => 0,
        };

        let lower_masked = lower & mask;
        let get = (METHOD_GET | 0x2020_2020_2020_2020) & mask;
        let put = (METHOD_PUT | 0x2020_2020_2020_2020) & mask;
        let post = (METHOD_POST | 0x2020_2020_2020_2020) & mask;
        let head = (METHOD_HEAD | 0x2020_2020_2020_2020) & mask;
        let patch = (METHOD_PATCH | 0x2020_2020_2020_2020) & mask;
        let delete = (METHOD_DELETE | 0x2020_2020_2020_2020) & mask;
        let options = (METHOD_OPTIONS | 0x2020_2020_2020_2020) & mask;

        match len {
            3 if lower_masked == get => Self::Get,
            3 if lower_masked == put => Self::Put,
            4 if lower_masked == post => Self::Post,
            4 if lower_masked == head => Self::Head,
            5 if lower_masked == patch => Self::Patch,
            6 if lower_masked == delete => Self::Delete,
            7 if lower_masked == options => Self::Options,
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