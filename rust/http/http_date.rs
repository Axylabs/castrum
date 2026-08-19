// rust/http/http_date.rs — HTTP-date (IMF-fixdate) formatting + parsing.
//
// `Sun, 06 Nov 1994 08:49:37 GMT` → unix seconds and back, with a zero-alloc
// fixed-width writer for hot loops. The date arithmetic uses Howard Hinnant's
// days↔civil algorithms (epoch-correct). Extracted from `etag.rs` so the
// HTTP cache semantics file owns only ETags + conditional requests.

use napi::bindgen_prelude::*;
use napi_derive::napi;

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
    HttpDateParts {
        y,
        m,
        d,
        hh,
        mm,
        ss,
        wd,
    }
}

/// Write the fixed-width `ddd, dd mmm yyyy hh:mm:ss GMT` layout into `out`
/// (29 bytes, no heap allocation). `Err` only for years outside 0..=9999
/// (where the fixed-width layout is undefined) or a too-small buffer.
fn write_http_date_parts(
    p: &HttpDateParts,
    out: &mut [u8],
) -> std::result::Result<usize, &'static str> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        for secs in [
            0i64,
            1,
            946_684_800,
            784_111_777,
            1_700_000_000,
            -1,
            -86_400,
        ] {
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
}
