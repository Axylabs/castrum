// rust/http/headers.rs — HeaderRefs: zero-alloc packed header parser
// Uses the shared word-at-a-time comparator from `bytes.rs`.

use crate::util::bytes::ascii_eq_ignore_case;
use napi::{Error, Result};

// ── Header presence flags ─────────────────────────────────────────
const HAS_ORIGIN: u8 = 1 << 0;
const HAS_COOKIE: u8 = 1 << 1;
const HAS_XFF: u8 = 1 << 2;
const HAS_X_REAL_IP: u8 = 1 << 3;
const HAS_XFP: u8 = 1 << 4;
const HAS_ACRM: u8 = 1 << 5;
const HAS_ACRH: u8 = 1 << 6;

/// Zero-alloc reference-based representation of interesting headers.
#[derive(Clone, Copy)]
pub struct HeaderRefs<'a> {
    origin: Option<&'a [u8]>,
    cookie: Option<&'a [u8]>,
    xff: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
    x_forwarded_proto: Option<&'a [u8]>,
    acrm: Option<&'a [u8]>,
    acrh: Option<&'a [u8]>,
    flags: u8,
}

impl<'a> HeaderRefs<'a> {
    #[inline(always)]
    pub fn empty() -> Self {
        Self {
            origin: None,
            cookie: None,
            xff: None,
            x_real_ip: None,
            x_forwarded_proto: None,
            acrm: None,
            acrh: None,
            flags: 0,
        }
    }

    /// Parse packed headers from the input buffer.
    /// Format: [u16 count] repeated { [u16 name_len] [name] [u32 value_len] [value] }
    #[inline]
    pub fn parse(packed: &'a [u8], is_options: bool, max_headers: usize) -> Result<Self> {
        let mut h = Self::empty();

        if packed.len() < 2 {
            return Ok(h);
        }

        let count = u16::from_le_bytes([packed[0], packed[1]]) as usize;
        if count > max_headers {
            return Err(Error::from_reason("too many headers"));
        }

        let mut pos = 2usize;

        for _ in 0..count {
            if pos + 2 > packed.len() {
                return Err(Error::from_reason("malformed packed headers"));
            }

            let name_len = u16::from_le_bytes([packed[pos], packed[pos + 1]]) as usize;
            pos += 2;

            if pos + name_len > packed.len() {
                return Err(Error::from_reason("malformed packed header name"));
            }

            let name = &packed[pos..pos + name_len];
            pos += name_len;

            if pos + 4 > packed.len() {
                return Err(Error::from_reason("malformed packed header value length"));
            }

            let value_len = u32::from_le_bytes([
                packed[pos],
                packed[pos + 1],
                packed[pos + 2],
                packed[pos + 3],
            ]) as usize;
            pos += 4;

            if pos + value_len > packed.len() {
                return Err(Error::from_reason("malformed packed header value"));
            }

            let value = &packed[pos..pos + value_len];
            pos += value_len;

            if name.is_empty() {
                continue;
            }

            let first = name[0] | 0x20;

            // Fast path: dispatch based on first character + name length
            if first == b'o' && name.len() == 6 {
                if ascii_eq_ignore_case(name, b"origin") {
                    h.flags |= HAS_ORIGIN;
                    h.origin = Some(value);
                }
            } else if first == b'c' && name.len() == 6 {
                if ascii_eq_ignore_case(name, b"cookie") {
                    h.flags |= HAS_COOKIE;
                    h.cookie = Some(value);
                }
            } else if first == b'x' {
                let name_len = name.len();
                if name_len == 15 && ascii_eq_ignore_case(name, b"x-forwarded-for") {
                    h.flags |= HAS_XFF;
                    h.xff = Some(value);
                } else if name_len == 9 && ascii_eq_ignore_case(name, b"x-real-ip") {
                    h.flags |= HAS_X_REAL_IP;
                    h.x_real_ip = Some(value);
                } else if name_len == 17 && ascii_eq_ignore_case(name, b"x-forwarded-proto") {
                    h.flags |= HAS_XFP;
                    h.x_forwarded_proto = Some(value);
                }
            } else if first == b'a' && is_options {
                if name.len() == 29 && ascii_eq_ignore_case(name, b"access-control-request-method")
                {
                    h.flags |= HAS_ACRM;
                    h.acrm = Some(value);
                } else if name.len() == 30
                    && ascii_eq_ignore_case(name, b"access-control-request-headers")
                {
                    h.flags |= HAS_ACRH;
                    h.acrh = Some(value);
                }
            }
        }

        Ok(h)
    }

    #[inline(always)]
    pub fn origin(&self) -> Option<&[u8]> {
        self.origin
    }

    #[inline(always)]
    pub fn cookie(&self) -> Option<&[u8]> {
        self.cookie
    }

    #[inline(always)]
    pub fn xff(&self) -> Option<&[u8]> {
        self.xff
    }

    #[inline(always)]
    pub fn x_real_ip(&self) -> Option<&[u8]> {
        self.x_real_ip
    }

    #[inline(always)]
    pub fn x_forwarded_proto(&self) -> Option<&[u8]> {
        self.x_forwarded_proto
    }

    #[inline(always)]
    pub fn acrm(&self) -> Option<&[u8]> {
        self.acrm
    }

    #[inline(always)]
    pub fn acrh(&self) -> Option<&[u8]> {
        self.acrh
    }

    #[inline(always)]
    pub fn has_origin(&self) -> bool {
        (self.flags & HAS_ORIGIN) != 0
    }

    #[inline(always)]
    pub fn has_cookie(&self) -> bool {
        (self.flags & HAS_COOKIE) != 0
    }

    #[inline(always)]
    pub fn has_xfp(&self) -> bool {
        (self.flags & HAS_XFP) != 0
    }

    #[inline(always)]
    pub fn has_acrm(&self) -> bool {
        (self.flags & HAS_ACRM) != 0
    }

    #[inline(always)]
    pub fn has_acrh(&self) -> bool {
        (self.flags & HAS_ACRH) != 0
    }
}
