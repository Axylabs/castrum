// rust/multipart.rs — multipart/form-data parser (hand-rolled).
//
// Backend-framework feature: upload / form body parsing. Deliberately hand-rolled
// (memchr-based boundary + header splitting) instead of pulling in `multer` and
// its `http`/async dependency stack — matches this crate's byte-machinery style
// (cf. query_parser.rs, cookie_parser.rs). It borrows from the input buffer; only
// the NAPI layer materializes owned strings/Buffers.
//
// Pure-Rust core (no napi types) stays unit-testable; only the entry points
// use napi types.

use memchr::memmem;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::bytes::trim_ascii_whitespace;
use crate::util::{should_parallelize, total_bytes, unpack};

// ── Pure-Rust core ─────────────────────────────────────────────

pub struct Part<'a> {
    pub name: &'a [u8],
    pub filename: Option<&'a [u8]>,
    pub content_type: Option<&'a [u8]>,
    pub data: &'a [u8],
}

/// Locate the next `\r\n--{boundary}` delimiter starting at `from`, returning
/// the index of the leading `\r\n`.
fn next_delimiter(body: &[u8], boundary: &[u8], from: usize) -> Option<usize> {
    let marker = b"\r\n--";
    let mut base = from;
    while base < body.len() {
        let rel = memmem::find(&body[base..], marker)?;
        let delim = base + rel;
        let after = delim + marker.len();
        if body.get(after..after + boundary.len()) == Some(boundary) {
            return Some(delim);
        }
        base = after;
    }
    None
}

/// Parse `Content-Disposition: form-data; name="..."; filename="..."` →
/// (name, filename).
fn parse_disposition(value: &[u8]) -> (Option<&[u8]>, Option<&[u8]>) {
    let mut name = None;
    let mut filename = None;
    for attr in value.split(|&b| b == b';') {
        let attr = trim_ascii_whitespace(attr);
        if attr.is_empty() {
            continue;
        }
        let Some(eq) = memchr::memchr(b'=', attr) else {
            continue;
        };
        let key = trim_ascii_whitespace(&attr[..eq]);
        let mut val = trim_ascii_whitespace(&attr[eq + 1..]);
        if val.len() >= 2 && val[0] == b'"' && val[val.len() - 1] == b'"' {
            val = &val[1..val.len() - 1];
        }
        if key.eq_ignore_ascii_case(b"name") {
            name = Some(val);
        } else if key.eq_ignore_ascii_case(b"filename") {
            filename = Some(val);
        }
    }
    (name, filename)
}

/// Parse a `multipart/form-data` body given the raw boundary token (no
/// surrounding quotes/dashes — the caller passes the value of the
/// `boundary=` parameter). Returns the list of parts (name, optional filename,
/// optional content-type, raw data bytes).
/// Limits for the multipart parser (DoS guard).
///
/// The defaults are generous enough for legitimate uploads but bound the worst
/// case so an attacker cannot force unbounded memory/CPU from a single body.
#[derive(Clone, Copy)]
pub struct Limits {
    /// Maximum number of parts (fields + files) parsed.
    pub max_parts: usize,
    /// Maximum number of plain (non-file) fields.
    pub max_field_count: usize,
    /// Maximum bytes for a single part's data.
    pub max_part_bytes: usize,
    /// Maximum total part-data bytes across the whole body.
    pub max_total_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_parts: 1_000,
            max_field_count: 1_000,
            max_part_bytes: 10 * 1024 * 1024, // 10 MiB
            max_total_bytes: 64 * 1024 * 1024, // 64 MiB
        }
    }
}

/// Parse a multipart/form-data body into parts, honoring `limits`.
/// Parsing stops (returns what it has) once a limit is crossed — it never
/// allocates beyond the configured bounds.
pub fn parse_multipart_limited<'a>(
    body: &'a [u8],
    boundary: &[u8],
    limits: &Limits,
) -> Vec<Part<'a>> {
    let mut parts = Vec::new();
    if boundary.is_empty() {
        return parts;
    }

    // Body must begin with the opening delimiter `--{boundary}`.
    if !body.starts_with(b"--") || body.get(2..2 + boundary.len()) != Some(boundary) {
        return parts;
    }
    let mut pos = 2 + boundary.len();
    let mut total_data: usize = 0;

    loop {
        // Closing delimiter (`--{boundary}--`) stops parsing.
        if body.get(pos..pos + 2) == Some(b"--") {
            break;
        }
        // Expect `\r\n` then the part.
        if body.get(pos..pos + 2) != Some(b"\r\n") {
            break;
        }
        pos += 2;

        // Part headers end at `\r\n\r\n`.
        let Some(header_end_rel) = memmem::find(&body[pos..], b"\r\n\r\n") else {
            break;
        };
        let header_block = &body[pos..pos + header_end_rel];
        let data_start = pos + header_end_rel + 4;

        let mut name: Option<&[u8]> = None;
        let mut filename: Option<&[u8]> = None;
        let mut content_type: Option<&[u8]> = None;

        for line in header_block.split(|&b| b == b'\n') {
            let line = if line.ends_with(b"\r") {
                &line[..line.len() - 1]
            } else {
                line
            };
            let Some(colon) = memchr::memchr(b':', line) else {
                continue;
            };
            let field = trim_ascii_whitespace(&line[..colon]);
            let value = trim_ascii_whitespace(&line[colon + 1..]);
            if field.eq_ignore_ascii_case(b"content-disposition") {
                let (n, f) = parse_disposition(value);
                name = n;
                filename = f;
            } else if field.eq_ignore_ascii_case(b"content-type") {
                content_type = Some(value);
            }
        }

        let Some(delim) = next_delimiter(body, boundary, data_start) else {
            break;
        };
        let data = &body[data_start..delim];

        // ── Limits enforcement ──
        if parts.len() >= limits.max_parts {
            break;
        }
        if filename.is_none() {
            let field_count = parts.iter().filter(|p| p.filename.is_none()).count();
            if field_count >= limits.max_field_count {
                break;
            }
        }
        if data.len() > limits.max_part_bytes {
            break;
        }
        if total_data.saturating_add(data.len()) > limits.max_total_bytes {
            break;
        }
        total_data = total_data.saturating_add(data.len());

        parts.push(Part {
            name: name.unwrap_or_default(),
            filename,
            content_type,
            data,
        });

        // Advance past `\r\n--{boundary}`.
        pos = delim + 2 + 2 + boundary.len();
    }

    parts
}

/// Parse a multipart/form-data body into parts with default limits.
pub fn parse_multipart<'a>(body: &'a [u8], boundary: &[u8]) -> Vec<Part<'a>> {
    parse_multipart_limited(body, boundary, &Limits::default())
}

// ── NAPI entry points ──────────────────────────────────────────

/// One parsed multipart part (owned, JS-visible).
#[napi(object)]
pub struct MultipartPart {
    pub name: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Buffer,
}

fn to_owned(p: &Part<'_>) -> MultipartPart {
    MultipartPart {
        name: String::from_utf8_lossy(p.name).into_owned(),
        filename: p.filename.map(|f| String::from_utf8_lossy(f).into_owned()),
        content_type: p
            .content_type
            .map(|c| String::from_utf8_lossy(c).into_owned()),
        data: Buffer::from(p.data.to_vec()),
    }
}

/// Optional limits for `multipart_parse` (DoS guard). Omitted fields fall back
/// to generous defaults (see `Limits`).
#[napi(object)]
pub struct MultipartLimitsInput {
    pub max_parts: Option<u32>,
    pub max_field_count: Option<u32>,
    pub max_part_bytes: Option<i64>,
    pub max_total_bytes: Option<i64>,
}

impl MultipartLimitsInput {
    fn resolve(&self) -> Limits {
        let d = Limits::default();
        Limits {
            max_parts: self.max_parts.map(|v| v as usize).unwrap_or(d.max_parts),
            max_field_count: self
                .max_field_count
                .map(|v| v as usize)
                .unwrap_or(d.max_field_count),
            max_part_bytes: self
                .max_part_bytes
                .map(|v| v.max(0) as usize)
                .unwrap_or(d.max_part_bytes),
            max_total_bytes: self
                .max_total_bytes
                .map(|v| v.max(0) as usize)
                .unwrap_or(d.max_total_bytes),
        }
    }
}

/// Parse a multipart/form-data body into parts, bounded by `limits`.
#[napi]
pub fn multipart_parse(
    body: Uint8Array,
    boundary: Uint8Array,
    limits: Option<MultipartLimitsInput>,
) -> Vec<MultipartPart> {
    let limits = limits.map(|l| l.resolve()).unwrap_or_default();
    parse_multipart_limited(body.as_ref(), boundary.as_ref(), &limits)
        .iter()
        .map(to_owned)
        .collect()
}

/// Serialize parsed parts to the packed layout used by the batch API:
/// `[u32 count] { [u32 name_len][name][u32 has_filename][u32 filename_len][filename][u32 ct_len][ct][u32 data_len][data] }`.
pub fn parts_to_packed(parts: &[Part<'_>], out: &mut Vec<u8>) {
    out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
    for p in parts {
        out.extend_from_slice(&(p.name.len() as u32).to_le_bytes());
        out.extend_from_slice(p.name);
        match p.filename {
            Some(f) => {
                out.push(1);
                out.extend_from_slice(&(f.len() as u32).to_le_bytes());
                out.extend_from_slice(f);
            }
            None => {
                out.push(0);
                out.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        match p.content_type {
            Some(c) => {
                out.push(1);
                out.extend_from_slice(&(c.len() as u32).to_le_bytes());
                out.extend_from_slice(c);
            }
            None => {
                out.push(0);
                out.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        out.extend_from_slice(&(p.data.len() as u32).to_le_bytes());
        out.extend_from_slice(p.data);
    }
}

/// Parallel multipart parse batch: packed `[u32 count]{[u32 len][body]}` in →
/// packed `[u32 count]{[u32 len][parts_packed]}` out (same boundary for all).
#[napi]
pub fn multipart_parse_batch_packed(
    data: Uint8Array,
    boundary: Uint8Array,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;

    let mut out = Vec::with_capacity(4 + items.len() * 32);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items
            .par_iter()
            .map(|body| {
                let mut buf = Vec::new();
                parts_to_packed(&parse_multipart(body, boundary.as_ref()), &mut buf);
                buf
            })
            .collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for body in items {
            let mut buf = Vec::new();
            parts_to_packed(&parse_multipart(body, boundary.as_ref()), &mut buf);
            out.extend_from_slice(&(buf.len() as u32).to_le_bytes());
            out.extend_from_slice(&buf);
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDARY: &[u8] = b"----WebKitFormBoundary7MA4YWxkTrZu0gW";

    fn body(name: &str, filename: Option<&str>, ct: Option<&str>, data: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"--");
        b.extend_from_slice(BOUNDARY);
        b.extend_from_slice(b"\r\n");
        b.extend_from_slice(b"Content-Disposition: form-data; name=\"");
        b.extend_from_slice(name.as_bytes());
        if let Some(f) = filename {
            b.extend_from_slice(b"\"; filename=\"");
            b.extend_from_slice(f.as_bytes());
        }
        b.extend_from_slice(b"\"");
        if let Some(ct) = ct {
            b.extend_from_slice(b"\r\nContent-Type: ");
            b.extend_from_slice(ct.as_bytes());
        }
        b.extend_from_slice(b"\r\n\r\n");
        b.extend_from_slice(data);
        b.extend_from_slice(b"\r\n--");
        b.extend_from_slice(BOUNDARY);
        b
    }

    #[test]
    fn parses_single_field() {
        let mut b = body("field1", None, None, b"hello world");
        b.extend_from_slice(b"--\r\n");
        let parts = parse_multipart(&b, BOUNDARY);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].name, b"field1");
        assert_eq!(parts[0].data, b"hello world");
        assert!(parts[0].filename.is_none());
        assert!(parts[0].content_type.is_none());
    }

    #[test]
    fn parses_multiple_parts() {
        let mut b = body("field1", None, None, b"alpha");
        b.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"field2\"\r\n\r\nbeta\r\n--");
        b.extend_from_slice(BOUNDARY);
        b.extend_from_slice(b"--\r\n");
        let parts = parse_multipart(&b, BOUNDARY);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].name, b"field1");
        assert_eq!(parts[0].data, b"alpha");
        assert_eq!(parts[1].name, b"field2");
        assert_eq!(parts[1].data, b"beta");
    }

    #[test]
    fn parses_file_with_filename_and_type() {
        let mut b = body("upload", Some("a.txt"), Some("text/plain"), b"file contents");
        b.extend_from_slice(b"--\r\n");
        let parts = parse_multipart(&b, BOUNDARY);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].name, b"upload");
        assert_eq!(parts[0].filename.unwrap(), b"a.txt");
        assert_eq!(parts[0].content_type.unwrap(), b"text/plain");
        assert_eq!(parts[0].data, b"file contents");
    }

    #[test]
    fn parses_binary_data() {
        let mut b = body("bin", None, None, b"\x00\x01\x02\xff");
        b.extend_from_slice(b"--\r\n");
        let parts = parse_multipart(&b, BOUNDARY);
        assert_eq!(parts[0].data, b"\x00\x01\x02\xff");
    }

    #[test]
    fn rejects_missing_opening_delimiter() {
        assert!(parse_multipart(b"no delimiter here", BOUNDARY).is_empty());
        assert!(parse_multipart(b"", BOUNDARY).is_empty());
        assert!(parse_multipart(b"abc", b"").is_empty());
    }

    #[test]
    fn limits_cap_part_count() {
        // Regression: the parser must bound work when limits are set.
        let mut b = body("field1", None, None, b"alpha");
        b.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"field2\"\r\n\r\nbeta\r\n--");
        b.extend_from_slice(BOUNDARY);
        b.extend_from_slice(b"--\r\n");

        let unlimited = parse_multipart(&b, BOUNDARY);
        assert_eq!(unlimited.len(), 2);

        let capped = parse_multipart_limited(
            &b,
            BOUNDARY,
            &Limits {
                max_parts: 1,
                ..Limits::default()
            },
        );
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].name, b"field1");
    }

    #[test]
    fn limits_cap_part_bytes() {
        let mut b = body("field1", None, None, b"very long field data");
        b.extend_from_slice(b"--\r\n");

        let capped = parse_multipart_limited(
            &b,
            BOUNDARY,
            &Limits {
                max_part_bytes: 4, // smaller than the part data
                ..Limits::default()
            },
        );
        assert!(capped.is_empty(), "oversized part must be dropped");
    }

    #[test]
    fn limits_cap_total_bytes() {
        let mut b = body("field1", None, None, b"alpha");
        b.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"field2\"\r\n\r\nbeta\r\n--");
        b.extend_from_slice(BOUNDARY);
        b.extend_from_slice(b"--\r\n");

        let capped = parse_multipart_limited(
            &b,
            BOUNDARY,
            &Limits {
                max_total_bytes: 4, // only "alpha" (5) would fit? no -> stop before any
                max_part_bytes: usize::MAX,
                max_field_count: usize::MAX,
                max_parts: usize::MAX,
            },
        );
        assert!(capped.len() < 2, "total-byte limit must stop parsing");
    }

    #[test]
    fn handles_crlf_only_body() {
        // Just the opening + closing delimiter with no parts.
        let mut b = Vec::new();
        b.extend_from_slice(b"--");
        b.extend_from_slice(BOUNDARY);
        b.extend_from_slice(b"--\r\n");
        let parts = parse_multipart(&b, BOUNDARY);
        assert!(parts.is_empty());
    }
}
