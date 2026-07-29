// rust/core/validation.rs — Validation functions
// Pure Rust, no napi dependencies.

use std::net::Ipv6Addr;

/// Validate email address bytes.
#[inline]
pub fn validate_email_bytes(input: &[u8]) -> bool {
    let s = match std::str::from_utf8(input) {
        Ok(s) => s,
        Err(_) => return false,
    };
    email_address::EmailAddress::is_valid(s)
}

/// Validate UUID v4 bytes (36-byte format with dashes).
#[inline]
pub fn validate_uuid_bytes(input: &[u8]) -> bool {
    let Ok(b) = <&[u8; 36]>::try_from(input) else { return false; };

    // Check dash positions
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return false;
    }
    // Version must be 4
    if b[14] != b'4' { return false; }
    // Variant must be 8, 9, a, b, A, or B
    if !matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B') { return false; }

    // Validate hex digits at all other positions
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
        if i == 8 || i == 13 || i == 18 || i == 23 || i == 14 || i == 19 {
            i += 1;
            continue;
        }
        if !HEX[b[i] as usize] { return false; }
        i += 1;
    }
    true
}

/// Validate IPv4 address bytes.
#[inline]
pub fn validate_ipv4_bytes(input: &[u8]) -> bool {
    if input.is_empty() || input.len() > 15 { return false; }

    let mut parts = 0u8;
    let mut start = 0usize;

    for (i, &c) in input.iter().enumerate() {
        if c == b'.' {
            if !validate_ipv4_part(&input[start..i]) { return false; }
            parts += 1;
            start = i + 1;
        }
    }

    if !validate_ipv4_part(&input[start..]) { return false; }
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

/// Validate IPv6 address bytes.
#[inline]
pub fn validate_ipv6_bytes(input: &[u8]) -> bool {
    std::str::from_utf8(input)
        .ok()
        .and_then(|s| s.parse::<Ipv6Addr>().ok())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uuid_valid() {
        assert!(validate_uuid_bytes(b"550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn test_uuid_invalid() {
        assert!(!validate_uuid_bytes(b"not-a-uuid"));
    }

    #[test]
    fn test_ipv4_valid() {
        assert!(validate_ipv4_bytes(b"192.168.1.1"));
    }

    #[test]
    fn test_ipv4_invalid() {
        assert!(!validate_ipv4_bytes(b"999.999.999.999"));
    }

    #[test]
    fn test_email_valid() {
        // Basic validation
        assert!(validate_email_bytes(b"test@example.com"));
    }

    #[test]
    fn test_email_invalid() {
        assert!(!validate_email_bytes(b"not-an-email"));
    }
}