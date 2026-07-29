// rust/core/http_parser.rs — HTTP request parser
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;
use crate::core::util::{write_bytes, write_u32_le};

/// Parse an HTTP request from raw bytes and write packed output.
/// Output format: [u32 method_len] [method] [u32 path_len] [path] [u32 version_len] [version] [u32 header_count] repeated { [u32 name_len] [name] [u32 value_len] [value] }
#[inline]
pub fn http_parse_request_packed_into_slice(input: &[u8], out: &mut [u8]) -> CoreResult<usize> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);

    match req.parse(input) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(_) => return Err(invalid_input("incomplete HTTP request")),
        Err(e) => return Err(internal_error(e.to_string())),
    }

    let method = req.method.ok_or_else(|| invalid_input("missing HTTP method"))?.as_bytes();
    let path = req.path.ok_or_else(|| invalid_input("missing HTTP path"))?.as_bytes();
    let version: &[u8] = match req.version {
        Some(0) => b"HTTP/1.0",
        Some(1) => b"HTTP/1.1",
        _ => b"HTTP/1.1",
    };

    let mut pos = 0usize;
    write_u32_le(out, &mut pos, method.len() as u32)?;
    write_bytes(out, &mut pos, method)?;
    write_u32_le(out, &mut pos, path.len() as u32)?;
    write_bytes(out, &mut pos, path)?;
    write_u32_le(out, &mut pos, version.len() as u32)?;
    write_bytes(out, &mut pos, version)?;
    write_u32_le(out, &mut pos, req.headers.len() as u32)?;

    for header in req.headers.iter() {
        let name = header.name.as_bytes();
        let value = header.value;
        write_u32_le(out, &mut pos, name.len() as u32)?;
        // Write name as lowercase
        let start = pos;
        write_bytes(out, &mut pos, name)?;
        out[start..pos].make_ascii_lowercase();
        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;
    }

    Ok(pos)
}

/// Allocating HTTP parser.
#[inline]
pub fn http_parse_request_packed_vec(input: &[u8]) -> Vec<u8> {
    let upper_bound = input.len().saturating_mul(4).saturating_add(1024);
    let mut out = vec![0u8; upper_bound];
    match http_parse_request_packed_into_slice(input, &mut out) {
        Ok(written) => {
            out.truncate(written);
            out
        }
        Err(_) => vec![0u8; 4] // empty result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_parse_request() {
        let input = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let result = http_parse_request_packed_vec(input);
        assert!(result.len() > 4);
    }
}