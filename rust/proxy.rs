// rust/proxy.rs — Proxy trust, IP resolution, and HTTPS detection

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headers::HeaderRefs;
    use crate::ip_trust::ProxyTrustMode;

    #[test]
    fn extract_path_variants() {
        assert_eq!(extract_path(b"/api/users"), b"/api/users");
        assert_eq!(extract_path(b"/api/users?page=2"), b"/api/users");
        assert_eq!(extract_path(b"https://example.com/api?x=1"), b"/api");
        assert_eq!(extract_path(b"http://example.com"), b"/");
    }

    #[test]
    fn extract_query_variants() {
        assert_eq!(extract_query(b"/api?page=2#frag"), b"page=2");
        assert_eq!(extract_query(b"https://x.com/a?b=c"), b"b=c");
        assert_eq!(extract_query(b"/no-query"), b"");
    }

    #[test]
    fn detect_https_fixed_and_url() {
        let h = HeaderRefs::empty();
        assert!(detect_https(Some(true), &ProxyTrustMode::None, b"/x", &h, false));
        assert!(!detect_https(Some(false), &ProxyTrustMode::None, b"/x", &h, false));
        assert!(detect_https(None, &ProxyTrustMode::None, b"https://x.com", &h, false));
        assert!(!detect_https(None, &ProxyTrustMode::None, b"http://x.com", &h, false));
    }
}