use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::util::{write_bytes, write_u32_le};

/// Internal legacy JSON parser.
///
/// Deprecated for hot paths.
pub fn http_parse_request_vec(input: &[u8]) -> Result<Vec<u8>> {
    use serde_json::{Map, Value};

    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);

    req.parse(input)
        .map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;

    let method = req.method.unwrap_or("");
    let path = req.path.unwrap_or("");

    let version = match req.version {
        Some(0) => "HTTP/1.0",
        Some(1) => "HTTP/1.1",
        _ => "HTTP/1.1",
    };

    let mut headers_map = Map::new();

    for h in req.headers.iter() {
        headers_map.insert(
            h.name.to_ascii_lowercase(),
            Value::String(String::from_utf8_lossy(h.value).to_string()),
        );
    }

    let mut obj = Map::new();

    obj.insert("method".into(), Value::String(method.to_string()));
    obj.insert("path".into(), Value::String(path.to_string()));
    obj.insert("version".into(), Value::String(version.to_string()));
    obj.insert("headers".into(), Value::Object(headers_map));

    let mut out = Vec::with_capacity(input.len().saturating_add(64));

    sonic_rs::to_writer(&mut out, &Value::Object(obj))
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(out)
}

#[napi]
pub fn http_parse_request(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_vec(input.as_ref())?))
}

/// Parse an HTTP request into a packed binary representation.
///
/// Output format:
///
///   [u32 method_len]
///   [method bytes]
///
///   [u32 path_len]
///   [path bytes]
///
///   [u32 version_len]
///   [version bytes]
///
///   [u32 header_count]
///   repeat header_count times:
///     [u32 header_name_len]
///     [lowercased header name bytes]
///     [u32 header_value_len]
///     [header value bytes]
pub fn http_parse_request_packed_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);

    match req.parse(input) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(_) => return Err(Error::new(Status::InvalidArg, "incomplete HTTP request")),
        Err(e) => return Err(Error::new(Status::InvalidArg, e.to_string())),
    }

    let method = req
        .method
        .ok_or_else(|| Error::new(Status::InvalidArg, "missing HTTP method"))?
        .as_bytes();

    let path = req
        .path
        .ok_or_else(|| Error::new(Status::InvalidArg, "missing HTTP path"))?
        .as_bytes();

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

        crate::util::ensure_capacity(out, pos, name.len())?;

        for b in name {
            out[pos] = b.to_ascii_lowercase();
            pos += 1;
        }

        write_u32_le(out, &mut pos, value.len() as u32)?;
        write_bytes(out, &mut pos, value)?;
    }

    Ok(pos)
}

/// Allocating packed parser.
///
/// This still allocates the output buffer, but it does not allocate
/// a HashMap, header Strings, or JSON DOM nodes.
#[napi]
pub fn http_parse_request_packed(input: Uint8Array) -> Result<Buffer> {
    let input = input.as_ref();

    // 64 headers max, each adds 8 bytes of length metadata.
    // Add generous headroom for request-line/version metadata.
    let mut out = vec![0u8; input.len().saturating_add(1024)];

    let written = http_parse_request_packed_into_slice(input, &mut out)?;

    out.truncate(written);

    Ok(Buffer::from(out))
}

/// Zero-output-allocation packed parser.
///
/// JS provides the output buffer. Rust writes directly into it.
///
/// In Bun/Node, the typed array is a view over shared memory, so this
/// avoids an extra Rust-to-JS copy of the final result.
#[napi]
pub fn http_parse_request_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    let written = http_parse_request_packed_into_slice(input.as_ref(), output.as_mut())?;
    Ok(written as u32)
}