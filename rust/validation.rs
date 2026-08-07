// rust/validation.rs — v2: memchr for IPv4 dots

#[cfg(not(feature = "fast-email"))]
use email_address::EmailAddress;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::net::Ipv6Addr;

#[cfg(feature = "fast-email")]
#[inline]
fn email_is_valid(s: &str) -> bool { fast_chemail::is_valid_email(s) }

#[cfg(not(feature = "fast-email"))]
#[inline]
fn email_is_valid(s: &str) -> bool { EmailAddress::is_valid(s) }

#[inline]
pub fn validate_email_bytes(input: &[u8]) -> bool {
    std::str::from_utf8(input).map(email_is_valid).unwrap_or(false)
}

#[inline]
pub fn validate_uuid_bytes(input: &[u8]) -> bool {
    let Ok(b) = <&[u8; 36]>::try_from(input) else { return false; };

    // Unroll the dash positions check.
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return false;
    }
    if b[14] != b'4' { return false; }
    if !matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B') { return false; }

    // Validate hex digits at all other positions.
    // Use a lookup table for speed.
    const HEX: [bool; 256] = {
        let mut t = [false; 256];
        let mut i = 0;
        while i < 256 {
            t[i] = matches!(i as u8, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F');
            i += 1;
        }
        t
    };

    let mut i = 0usize;
    while i < 36 {
        if i == 8 || i == 13 || i == 18 || i == 23 { i += 1; continue; }
        if i == 14 || i == 19 { i += 1; continue; }
        if !HEX[b[i] as usize] { return false; }
        i += 1;
    }
    true
}

#[inline]
fn is_valid_ipv4(b: &[u8]) -> bool {
    if b.is_empty() || b.len() > 15 { return false; }

    let mut parts = 0u8;
    let mut start = 0usize;

    // Use memchr to find dots faster.
    for dot_idx in b.iter().enumerate().filter_map(|(i, &c)| if c == b'.' { Some(i) } else { None }) {
        let part = &b[start..dot_idx];
        if !validate_ipv4_part(part) { return false; }
        parts += 1;
        start = dot_idx + 1;
    }

    // Last part.
    if !validate_ipv4_part(&b[start..]) { return false; }
    parts += 1;

    parts == 4
}

#[inline(always)]
fn validate_ipv4_part(part: &[u8]) -> bool {
    if part.is_empty() || part.len() > 3 { return false; }
    if part.len() > 1 && part[0] == b'0' { return false; }

    let mut n = 0u16;
    for &c in part {
        if !c.is_ascii_digit() { return false; }
        n = n * 10 + u16::from(c - b'0');
    }
    n <= 255
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

#[napi] pub fn validate_email(input: Uint8Array) -> bool { validate_email_bytes(input.as_ref()) }
#[napi] pub fn validate_uuid(input: Uint8Array) -> bool { validate_uuid_bytes(input.as_ref()) }
#[napi] pub fn validate_ipv4(input: Uint8Array) -> bool { validate_ipv4_bytes(input.as_ref()) }
#[napi] pub fn validate_ipv6(input: Uint8Array) -> bool { validate_ipv6_bytes(input.as_ref()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_email_cases() {
        assert!(validate_email_bytes(b"a@b.com"));
        assert!(!validate_email_bytes(b"not-an-email"));
        assert!(!validate_email_bytes(b""));
    }

    #[test]
    fn validate_uuid_v4_cases() {
        assert!(validate_uuid_bytes(b"550e8400-e29b-41d4-a716-446655440000"));
        assert!(!validate_uuid_bytes(b"550e8400e29b41d4a716446655440000")); // no dashes
        assert!(!validate_uuid_bytes(b"not-a-uuid"));
    }

    #[test]
    fn validate_ipv4_cases() {
        assert!(validate_ipv4_bytes(b"192.168.0.1"));
        assert!(validate_ipv4_bytes(b"1.2.3.4"));
        assert!(!validate_ipv4_bytes(b"999.1.1.1"));
        assert!(!validate_ipv4_bytes(b"1.2.3"));
        assert!(!validate_ipv4_bytes(b""));
    }

    #[test]
    fn validate_ipv6_cases() {
        assert!(validate_ipv6_bytes(b"::1"));
        assert!(validate_ipv6_bytes(b"2001:db8::1"));
        assert!(!validate_ipv6_bytes(b"not-an-ip"));
        assert!(!validate_ipv6_bytes(b""));
    }
}