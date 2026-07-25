use email_address::EmailAddress;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::net::Ipv6Addr;

#[inline]
pub fn validate_email_bytes(input: &[u8]) -> bool {
    match std::str::from_utf8(input) {
        Ok(s) => EmailAddress::is_valid(s),
        Err(_) => false,
    }
}

#[inline]
pub fn validate_uuid_bytes(input: &[u8]) -> bool {
    let Ok(b) = <&[u8; 36]>::try_from(input) else {
        return false;
    };

    for i in 0..36usize {
        let c = b[i];

        match i {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            }
            14 => {
                if c != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(c, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            _ => {
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }

    true
}
#[inline]
fn is_valid_ipv4(b: &[u8]) -> bool {
    if b.is_empty() || b.len() > 15 {
        return false;
    }

    let mut parts = 0;

    for part in b.split(|&c| c == b'.') {
        parts += 1;

        if part.is_empty() || part.len() > 3 {
            return false;
        }

        // Reject leading zeros like "01", "001".
        if part.len() > 1 && part[0] == b'0' {
            return false;
        }

        let mut n = 0u16;

        for &c in part {
            if !c.is_ascii_digit() {
                return false;
            }

            n = n * 10 + u16::from(c - b'0');
        }

        if n > 255 {
            return false;
        }
    }

    parts == 4
}

#[inline]
pub fn validate_ipv4_bytes(input: &[u8]) -> bool {
    is_valid_ipv4(input)
}

#[inline]
pub fn validate_ipv6_bytes(input: &[u8]) -> bool {
    simdutf8::basic::from_utf8(input)
        .ok()
        .and_then(|s| s.parse::<Ipv6Addr>().ok())
        .is_some()
}

#[napi]
pub fn validate_email(input: Uint8Array) -> bool {
    validate_email_bytes(input.as_ref())
}

#[napi]
pub fn validate_uuid(input: Uint8Array) -> bool {
    validate_uuid_bytes(input.as_ref())
}

#[napi]
pub fn validate_ipv4(input: Buffer) -> bool {
    validate_ipv4_bytes(input.as_ref())
}

#[napi]
pub fn validate_ipv6(input: Uint8Array) -> bool {
    validate_ipv6_bytes(input.as_ref())
}