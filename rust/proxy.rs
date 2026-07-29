// rust/proxy.rs — Proxy trust, IP resolution, and HTTPS detection
// Extracted from ingress.rs for composability

use crate::headers::HeaderRefs;
use crate::ip_trust::ProxyTrustMode;
use crate::util::trim_ascii_whitespace;

/// Detect whether the request is HTTPS based on URL, proxy trust, and headers.
#[inline]
pub fn detect_https(
    https_fixed: Option<bool>,
    proxy_trust: &ProxyTrustMode,
    url: &[u8],
    headers: &HeaderRefs<'_>,
    peer_trusted: bool,
) -> bool {
    if let Some(v) = https_fixed {
        return v;
    }

    if url.starts_with(b"https://") || url.starts_with(b"wss://") {
        return true;
    }

    if !proxy_trust.is_none() && peer_trusted && headers.has_xfp() {
        if let Some(xfp) = headers.x_forwarded_proto() {
            return trim_ascii_whitespace(xfp) == b"https";
        }
    }

    false
}

/// Compute a rate-limiting key from the resolved IP.
#[inline]
pub fn rate_key_from_ip(ip: &crate::ip_trust::ResolvedIp, seed: u64) -> u64 {
    ip.rate_key(seed)
}

// ── URL helpers ───────────────────────────────────────────────────

/// Extract the path component from a URL.
#[inline]
pub fn extract_path(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") {
        8
    } else if url.starts_with(b"http://") {
        7
    } else {
        0
    };

    let search_space = &url[search_start..];

    let path_start = match memchr::memchr(b'/', search_space) {
        Some(i) => search_start + i,
        None => return b"/",
    };

    let after_path = &url[path_start..];
    let end = memchr::memchr2(b'?', b'#', after_path).unwrap_or(after_path.len());

    &url[path_start..path_start + end]
}

/// Extract the query string from a URL (without the leading '?').
#[inline]
pub fn extract_query(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") {
        8
    } else if url.starts_with(b"http://") {
        7
    } else {
        0
    };

    let search_space = &url[search_start..];

    if let Some(i) = memchr::memchr2(b'?', b'#', search_space) {
        if search_space[i] == b'?' {
            let after_q = &search_space[i + 1..];
            let frag = memchr::memchr(b'#', after_q).unwrap_or(after_q.len());
            &after_q[..frag]
        } else {
            &[]
        }
    } else {
        &[]
    }
}