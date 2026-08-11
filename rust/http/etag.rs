// rust/http/etag.rs — HTTP cache semantics.
//
// ETag generation (strong/weak, crc32-based), HTTP-date (IMF-fixdate)
// formatting + parsing, and the `ConditionalRequest` higher-order instance
// that turns If-None-Match / If-Modified-Since into a 304 decision. The date
// arithmetic uses Howard Hinnant's days↔civil algorithms (epoch-correct).

use napi::bindgen_prelude::*;
use napi_derive::napi;

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

// ── HTTP-date (IMF-fixdate) ──────────────────────────────────────

const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Days since epoch → civil (year, month, day) — Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Civil date → days since epoch — Hinnant's inverse algorithm.
fn days_from_civil(y: i64, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || d == 0 || d > 31 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = ((m as i64 + 9) % 12) as u64;
    let doy = (153 * mp + 2) / 5 + (d - 1) as u64;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

/// Format `value` as a zero-padded decimal of exactly `width` digits into
/// `out`. `value` must fit in `width` digits.
#[inline]
fn write_padded(out: &mut [u8], mut value: u32, width: usize) {
    for i in (0..width).rev() {
        out[i] = b'0' + (value % 10) as u8;
        value /= 10;
    }
}

/// Parsed http-date components (computed once, shared by the allocating and
/// pooled-output formatters).
struct HttpDateParts {
    y: i64,
    m: u32,
    d: u32,
    hh: i64,
    mm: i64,
    ss: i64,
    wd: usize,
}

fn http_date_parts(secs: i64) -> HttpDateParts {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    let (y, m, d) = civil_from_days(days);
    // 1970-01-01 was a Thursday; weekday Mon=0 → (days+3) mod 7.
    let wd = ((days.rem_euclid(7) + 3) % 7) as usize;
    HttpDateParts { y, m, d, hh, mm, ss, wd }
}

/// Write the fixed-width `ddd, dd mmm yyyy hh:mm:ss GMT` layout into `out`
/// (29 bytes, no heap allocation). `Err` only for years outside 0..=9999
/// (where the fixed-width layout is undefined) or a too-small buffer.
fn write_http_date_parts(p: &HttpDateParts, out: &mut [u8]) -> std::result::Result<usize, &'static str> {
    // 3 + 2 (", ") + 2 + 1 (" ") + 3 + 1 (" ") + 4 + 1 (" ") + 2 + 1 (":") + 2
    // + 1 (":") + 2 + 1 (" ") + 3 = 29
    if out.len() < 29 {
        return Err("http-date: output buffer too small");
    }
    if !(0..=9999).contains(&p.y) {
        return Err("http-date: year out of range for fixed-width layout");
    }
    let mut i = 0usize;
    out[i..i + 3].copy_from_slice(DAY_NAMES[p.wd].as_bytes());
    i += 3;
    out[i] = b',';
    i += 1;
    out[i] = b' ';
    i += 1;
    write_padded(&mut out[i..i + 2], p.d, 2);
    i += 2;
    out[i] = b' ';
    i += 1;
    out[i..i + 3].copy_from_slice(MONTH_NAMES[(p.m - 1) as usize].as_bytes());
    i += 3;
    out[i] = b' ';
    i += 1;
    write_padded(&mut out[i..i + 4], p.y as u32, 4);
    i += 4;
    out[i] = b' ';
    i += 1;
    write_padded(&mut out[i..i + 2], p.hh as u32, 2);
    i += 2;
    out[i] = b':';
    i += 1;
    write_padded(&mut out[i..i + 2], p.mm as u32, 2);
    i += 2;
    out[i] = b':';
    i += 1;
    write_padded(&mut out[i..i + 2], p.ss as u32, 2);
    i += 2;
    out[i] = b' ';
    i += 1;
    out[i..i + 3].copy_from_slice(b"GMT");
    i += 3;
    Ok(i)
}

/// Format a unix timestamp (seconds) as `Sun, 06 Nov 1994 08:49:37 GMT`.
/// Written into a fixed 32-byte stack buffer — no `format!`/heap allocation.
pub fn http_date_from_secs(secs: i64) -> String {
    let p = http_date_parts(secs);
    let mut buf = [0u8; 32];
    match write_http_date_parts(&p, &mut buf) {
        Ok(n) => String::from_utf8(buf[..n].to_vec()).expect("http-date is ASCII"),
        Err(_) => {
            // Year outside 0..=9999: HTTP-date is only well-defined for
            // 0000-9999, but keep the exact `format!` fallback so behavior
            // never changes from before the refactor.
            format!(
                "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
                DAY_NAMES[p.wd],
                p.d,
                MONTH_NAMES[(p.m - 1) as usize],
                p.y,
                p.hh,
                p.mm,
                p.ss
            )
        }
    }
}

/// Write an http-date directly into `out` (fixed 29 bytes, no heap alloc).
/// Returns bytes written; errors on a too-small buffer or a year outside
/// 0..=9999 (use the allocating `http_date` for that fallback).
pub fn http_date_into_slice(secs: i64, out: &mut [u8]) -> Result<usize> {
    let p = http_date_parts(secs);
    write_http_date_parts(&p, out).map_err(|e| Error::from_reason(e.to_string()))
}

/// Parse `Sun, 06 Nov 1994 08:49:37 GMT` back to unix seconds.
pub fn parse_http_date_secs(input: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(input).ok()?.trim();
    let comma = s.find(',')?;
    let rest = s[comma + 1..].trim();
    let mut parts = rest.split_whitespace();
    let day: u32 = parts.next()?.parse().ok()?;
    let mon = parts.next()?;
    let year: i64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let month = MONTH_NAMES
        .iter()
        .position(|m| m.eq_ignore_ascii_case(mon))?
        + 1;
    let mut tp = time.split(':');
    let hh: u32 = tp.next()?.parse().ok()?;
    let mm: u32 = tp.next()?.parse().ok()?;
    let ss: u32 = tp.next()?.parse().ok()?;
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let days = days_from_civil(year, month as u32, day)?;
    Some(days * 86_400 + i64::from(hh) * 3600 + i64::from(mm) * 60 + i64::from(ss))
}

#[napi]
pub fn http_date(secs: Option<f64>) -> Buffer {
    let s = secs.map(|v| v as i64).unwrap_or(0);
    Buffer::from(http_date_from_secs(s).into_bytes())
}

/// Pooled-output variant: writes the http-date into `output` and returns bytes
/// written, so hot loops can reuse a buffer instead of allocating a fresh
/// Buffer per call. Errors if `output` is too small or the year is outside the
/// fixed-width range (use the allocating `http_date` for that fallback).
#[napi]
pub fn http_date_into(secs: Option<f64>, mut output: Uint8Array) -> Result<u32> {
    let s = secs.map(|v| v as i64).unwrap_or(0);
    // SAFETY: `http_date_into_slice` is capacity-checked (returns Err on a
    // too-small buffer before writing), and no other reference to `output` is
    // live while it runs.
    let written = unsafe { http_date_into_slice(s, output.as_mut())? };
    Ok(written as u32)
}

#[napi]
pub fn parse_http_date(input: Uint8Array) -> Option<BigInt> {
    parse_http_date_secs(input.as_ref()).map(BigInt::from)
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

#[napi]
impl ConditionalRequest {
    #[napi(constructor)]
    pub fn new(etag_value: Uint8Array, last_modified_secs: Option<f64>) -> Self {
        Self {
            etag_value: etag_value.as_ref().to_vec(),
            last_modified_secs: last_modified_secs.map(|v| v as i64).unwrap_or(0).max(0),
        }
    }

    /// true → "304 Not Modified" (If-None-Match wins over If-Modified-Since).
    #[napi]
    pub fn is_not_modified(
        &self,
        if_none_match: Option<Uint8Array>,
        if_modified_since: Option<Uint8Array>,
    ) -> bool {
        if let Some(inm) = if_none_match {
            let header = trim_ascii_whitespace(inm.as_ref());
            if header == b"*" {
                return true;
            }
            return header
                .split(|&b| b == b',')
                .any(|candidate| etag_weak_eq(candidate, &self.etag_value));
        }
        if let Some(ims) = if_modified_since {
            if self.last_modified_secs > 0 {
                if let Some(secs) = parse_http_date_secs(ims.as_ref()) {
                    return self.last_modified_secs <= secs;
                }
            }
        }
        false
    }
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
    fn http_date_epoch() {
        assert_eq!(http_date_from_secs(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            http_date_from_secs(978_307_200),
            "Mon, 01 Jan 2001 00:00:00 GMT"
        );
        assert_eq!(
            http_date_from_secs(784_111_777),
            "Sun, 06 Nov 1994 08:49:37 GMT"
        );
    }

    #[test]
    fn http_date_roundtrip() {
        for secs in [0i64, 1, 946_684_800, 784_111_777, 1_700_000_000] {
            let s = http_date_from_secs(secs);
            assert_eq!(parse_http_date_secs(s.as_bytes()), Some(secs));
        }
    }

    #[test]
    fn http_date_into_matches_allocating() {
        for secs in [0i64, 1, 946_684_800, 784_111_777, 1_700_000_000, -1, -86_400] {
            let expected = http_date_from_secs(secs);
            let mut out = [0u8; 32];
            let n = http_date_into_slice(secs, &mut out).unwrap();
            assert_eq!(&out[..n], expected.as_bytes(), "secs: {secs}");
        }
    }

    #[test]
    fn http_date_into_rejects_small_buffer() {
        let mut out = [0u8; 28];
        assert!(http_date_into_slice(0, &mut out).is_err());
    }

    #[test]
    fn http_date_into_out_of_range_year_falls_back() {
        // Year 10000 (253_402_300_800s): the fixed-width pooled writer errors;
        // the allocating path keeps the exact format! fallback.
        let big = 253_402_300_800i64; // 10000-01-01T00:00:00Z
        let mut out = [0u8; 32];
        assert!(http_date_into_slice(big, &mut out).is_err());
        assert!(http_date_from_secs(big).contains("01 Jan 10000"));
    }

    #[test]
    fn parse_http_date_rejects_malformed() {
        assert!(parse_http_date_secs(b"not a date").is_none());
        assert!(parse_http_date_secs(b"Sun, 99 Nov 1994 08:49:37 GMT").is_none());
        assert!(parse_http_date_secs(b"Sun, 06 Nov 1994 25:49:37 GMT").is_none());
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
