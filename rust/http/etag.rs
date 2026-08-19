// rust/http/etag.rs — HTTP cache semantics (ETag + conditional requests).
//
// ETag generation (strong/weak, crc32-based) and the `ConditionalRequest`
// higher-order instance that turns If-None-Match / If-Modified-Since into a
// 304 decision. HTTP-date (IMF-fixdate) formatting/parsing lives in the
// `http_date` submodule; the conditional request reuses
// `http_date::parse_http_date_secs` for If-Modified-Since.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::http::http_date::parse_http_date_secs;
use crate::util::bytes::trim_ascii_whitespace;

// ── ETag ─────────────────────────────────────────────────────────

/// Format a crc32 digest as an 8-char lowercase hex ETag value. Written into a
/// fixed stack buffer (10 or 12 bytes) — no `format!`/heap allocation.
pub fn etag_from_crc32(crc: u32, weak: bool) -> String {
    let mut buf = [0u8; 12];
    let start = if weak { 2 } else { 0 };
    if weak {
        buf[0] = b'W';
        buf[1] = b'/';
    }
    let hex = crate::util::bytes::HEX_LOWER;
    buf[start] = b'"';
    buf[start + 1] = hex[((crc >> 28) & 0x0f) as usize];
    buf[start + 2] = hex[((crc >> 24) & 0x0f) as usize];
    buf[start + 3] = hex[((crc >> 20) & 0x0f) as usize];
    buf[start + 4] = hex[((crc >> 16) & 0x0f) as usize];
    buf[start + 5] = hex[((crc >> 12) & 0x0f) as usize];
    buf[start + 6] = hex[((crc >> 8) & 0x0f) as usize];
    buf[start + 7] = hex[((crc >> 4) & 0x0f) as usize];
    buf[start + 8] = hex[(crc & 0x0f) as usize];
    buf[start + 9] = b'"';
    String::from_utf8(buf[..start + 10].to_vec()).expect("etag is ASCII")
}

/// Format a crc32 digest as an 8-char lowercase hex ETag value directly into
/// `out` (zero-alloc — no `String`/heap allocation). Returns the number of
/// bytes written (10 strong, 12 weak). Errors if `out` is too small.
pub fn etag_from_crc32_into(crc: u32, weak: bool, out: &mut [u8]) -> Result<usize> {
    let len = if weak { 12 } else { 10 };
    if out.len() < len {
        return Err(Error::from_reason("etag: output buffer too small"));
    }
    let hex = crate::util::bytes::HEX_LOWER;
    let mut pos = 0usize;
    if weak {
        out[pos] = b'W';
        out[pos + 1] = b'/';
        pos += 2;
    }
    out[pos] = b'"';
    pos += 1;
    out[pos] = hex[((crc >> 28) & 0x0f) as usize];
    out[pos + 1] = hex[((crc >> 24) & 0x0f) as usize];
    out[pos + 2] = hex[((crc >> 20) & 0x0f) as usize];
    out[pos + 3] = hex[((crc >> 16) & 0x0f) as usize];
    out[pos + 4] = hex[((crc >> 12) & 0x0f) as usize];
    out[pos + 5] = hex[((crc >> 8) & 0x0f) as usize];
    out[pos + 6] = hex[((crc >> 4) & 0x0f) as usize];
    out[pos + 7] = hex[(crc & 0x0f) as usize];
    out[pos + 8] = b'"';
    Ok(len)
}

#[napi]
pub fn etag(input: Uint8Array, weak: Option<bool>) -> Buffer {
    let crc = crc32fast::hash(input.as_ref());
    Buffer::from(etag_from_crc32(crc, weak.unwrap_or(false)).into_bytes())
}

/// Reusable-output etag: writes the ETag into `output` and returns bytes
/// written (10 strong / 12 weak). Errors if `output` is too small.
#[napi]
pub fn etag_into(input: Uint8Array, mut output: Uint8Array, weak: Option<bool>) -> Result<u32> {
    let weak = weak.unwrap_or(false);
    crate::util::run_packed_into(&input, &mut output, move |inp, out| {
        let crc = crc32fast::hash(inp);
        etag_from_crc32_into(crc, weak, out)
    })
}

/// Packed ETag batch: `[u32 count]{[u32 len][data]}` in →
/// `[u32 count]{[u32 len][etag]}` out (10 strong / 12 weak bytes each).
#[napi]
pub fn etag_batch_packed(input: Uint8Array, weak: Option<bool>) -> Result<Buffer> {
    let weak = weak.unwrap_or(false);
    let iter = crate::util::packed::PackedIter::new(input.as_ref())?;
    let count = iter.len();
    let per = if weak { 12 } else { 10 };
    // Direct-write: ETags are fixed-size (10 strong / 12 weak), so no per-item
    // `String`/`Vec` allocation.
    let mut out = Vec::with_capacity(4 + count.saturating_mul(4 + per));
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for item in iter {
        let crc = crc32fast::hash(item);
        out.extend_from_slice(&(per as u32).to_le_bytes());
        let start = out.len();
        out.resize(start + per, 0);
        etag_from_crc32_into(crc, weak, &mut out[start..start + per])?;
    }
    Ok(Buffer::from(out))
}

// ── Conditional requests (If-None-Match / If-Modified-Since) ─────

/// Strip the `W/` weak prefix from an opaque-tag.
fn strip_weak(tag: &[u8]) -> &[u8] {
    if tag.starts_with(b"W/") {
        &tag[2..]
    } else {
        tag
    }
}

/// Weak equality of two opaque-tags (RFC 7232 §2.3.2).
fn etag_weak_eq(a: &[u8], b: &[u8]) -> bool {
    strip_weak(trim_ascii_whitespace(a)) == strip_weak(trim_ascii_whitespace(b))
}

/// Higher-order instance: per-resource state (etag + last-modified) computed
/// once, then reused across requests to answer "is this 304?".
#[napi]
pub struct ConditionalRequest {
    etag_value: Vec<u8>,
    last_modified_secs: i64,
}

/// Pure core: evaluate is-not-modified against a precompiled etag + last
/// modified. Shared by the napi method and the C-ABI opaque-handle path, so
/// both transports answer identically (304 semantics: If-None-Match wins over
/// If-Modified-Since).
pub(crate) fn is_not_modified_core(
    etag_value: &[u8],
    last_modified_secs: i64,
    if_none_match: Option<&[u8]>,
    if_modified_since: Option<&[u8]>,
) -> bool {
    if let Some(inm) = if_none_match {
        let header = trim_ascii_whitespace(inm);
        if header == b"*" {
            return true;
        }
        return header
            .split(|&b| b == b',')
            .any(|candidate| etag_weak_eq(candidate, etag_value));
    }
    if let Some(ims) = if_modified_since {
        if last_modified_secs > 0 {
            if let Some(secs) = parse_http_date_secs(ims) {
                return last_modified_secs <= secs;
            }
        }
    }
    false
}

#[napi]
impl ConditionalRequest {
    #[napi(constructor)]
    pub fn new(etag_value: Uint8Array, last_modified_secs: Option<f64>) -> Self {
        Self {
            etag_value: etag_value.as_ref().to_vec(),
            last_modified_secs: last_modified_secs.map(|v| v as i64).unwrap_or(0).max(0),
        }
    }

    /// Opaque handle to the precompiled state, for the `bun:ffi` C-ABI fast path
    /// (`castrum_conditional_is_not_modified` in rust/ffi.rs). Only valid while
    /// THIS instance is alive; the JS wrapper holds the instance for the handle
    /// lifetime (same contract as `Ingress::ingress_inner_ptr`).
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        self as *const ConditionalRequest as u64
    }

    /// true → "304 Not Modified" (If-None-Match wins over If-Modified-Since).
    #[napi]
    pub fn is_not_modified(
        &self,
        if_none_match: Option<Uint8Array>,
        if_modified_since: Option<Uint8Array>,
    ) -> bool {
        is_not_modified_core(
            &self.etag_value,
            self.last_modified_secs,
            if_none_match.as_deref(),
            if_modified_since.as_deref(),
        )
    }
}

/// C-ABI support: evaluate is-not-modified against the precompiled state.
///
/// # Safety
/// `p` must be a valid `*const ConditionalRequest` obtained from `inner_ptr`
/// and must stay alive for the call (the JS wrapper holds the napi instance).
pub(crate) unsafe fn conditional_is_not_modified(
    p: *const ConditionalRequest,
    inm: Option<&[u8]>,
    ims: Option<&[u8]>,
) -> bool {
    let c = &*p;
    is_not_modified_core(&c.etag_value, c.last_modified_secs, inm, ims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_formatting() {
        assert_eq!(etag_from_crc32(0xdead_beef, false), "\"deadbeef\"");
        assert_eq!(etag_from_crc32(0x0000_0001, true), "W/\"00000001\"");
    }

    #[test]
    fn etag_from_crc32_into_matches_allocating() {
        let crc = crc32fast::hash(b"hello world, this is etag data");
        let strong = etag_from_crc32(crc, false);
        let weak = etag_from_crc32(crc, true);
        let mut out = [0u8; 12];
        let n = etag_from_crc32_into(crc, false, &mut out).unwrap();
        assert_eq!(n, strong.len());
        assert_eq!(&out[..n], strong.as_bytes());
        let n2 = etag_from_crc32_into(crc, true, &mut out).unwrap();
        assert_eq!(n2, weak.len());
        assert_eq!(&out[..n2], weak.as_bytes());
    }

    #[test]
    fn etag_from_crc32_into_small_buffer_errors() {
        let mut out = [0u8; 4];
        assert!(etag_from_crc32_into(0xdead_beef, false, &mut out).is_err());
        let mut out2 = [0u8; 10];
        assert!(etag_from_crc32_into(0xdead_beef, true, &mut out2).is_err());
    }

    #[test]
    fn etag_into_reports_length() {
        let data = b"hello world, this is etag data";
        let out = Uint8Array::new(vec![0u8; 16]);
        let n = etag_into(Uint8Array::new(data.to_vec()), out, None).unwrap();
        assert_eq!(
            n as usize,
            etag_from_crc32(crc32fast::hash(data), false).len()
        );
        let out2 = Uint8Array::new(vec![0u8; 16]);
        let n2 = etag_into(Uint8Array::new(data.to_vec()), out2, Some(true)).unwrap();
        assert_eq!(
            n2 as usize,
            etag_from_crc32(crc32fast::hash(data), true).len()
        );
    }

    #[test]
    fn conditional_if_none_match_star() {
        let c = ConditionalRequest::new(Uint8Array::new(b"\"abc123\"".to_vec()), Some(1_000.0));
        assert!(c.is_not_modified(Some(Uint8Array::new(b"*".to_vec())), None));
    }

    #[test]
    fn conditional_weak_etag_match() {
        let c = ConditionalRequest::new(Uint8Array::new(b"\"abc123\"".to_vec()), Some(1_000.0));
        assert!(c.is_not_modified(
            Some(Uint8Array::new(b"\"xyz\", W/\"abc123\"".to_vec())),
            None
        ));
        assert!(!c.is_not_modified(Some(Uint8Array::new(b"\"xyz\", \"abc124\"".to_vec())), None));
    }

    #[test]
    fn conditional_if_modified_since() {
        // last-modified = 1970-01-01 00:16:40 (secs 1000).
        let c = ConditionalRequest::new(Uint8Array::new(b"\"abc123\"".to_vec()), Some(1_000.0));
        // IMS equal to last-modified → not modified → 304.
        let equal = Uint8Array::new(b"Thu, 01 Jan 1970 00:16:40 GMT".to_vec());
        assert!(c.is_not_modified(None, Some(equal)));
        // IMS after last-modified → not modified → 304.
        let after = Uint8Array::new(b"Thu, 01 Jan 1970 00:16:41 GMT".to_vec());
        assert!(c.is_not_modified(None, Some(after)));
        // IMS before last-modified → modified → 200.
        let before = Uint8Array::new(b"Thu, 01 Jan 1970 00:00:01 GMT".to_vec());
        assert!(!c.is_not_modified(None, Some(before)));
    }
}
