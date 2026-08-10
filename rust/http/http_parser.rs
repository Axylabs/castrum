// rust/http_parser.rs
use crate::util::{write_bytes, write_u32_le, VecWriter};
use napi::bindgen_prelude::*;
use napi_derive::napi;

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
        crate::util::write_bytes_lowercase(out, &mut pos, name)?;

        write_u32_le(out, &mut pos, value.len() as u32)?;
        crate::util::write_bytes(out, &mut pos, value)?;
    }

    Ok(pos)
}

/// Allocating, zero-copy-input, non-zeroing-output parser.
pub fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
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

    // Max 64 headers.
    // Metadata overhead:
    //   4 bytes method len
    //   4 bytes path len
    //   4 bytes version len
    //   4 bytes header count
    //   8 bytes per header name/value length prefix
    //
    // 16 + 64 * 8 = 528
    let mut w = VecWriter::with_capacity(input.len().saturating_add(528));

    w.write_u32(method.len() as u32);
    w.write_bytes(method);

    w.write_u32(path.len() as u32);
    w.write_bytes(path);

    w.write_u32(version.len() as u32);
    w.write_bytes(version);

    w.write_u32(req.headers.len() as u32);

    for header in req.headers.iter() {
        let name = header.name.as_bytes();
        let value = header.value;

        w.write_u32(name.len() as u32);
        w.write_bytes_ascii_lowercase(name);

        w.write_u32(value.len() as u32);
        w.write_bytes(value);
    }

    Ok(w.into_bytes())
}

#[napi]
pub fn http_parse_request_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_packed_vec(
        input.as_ref(),
    )?))
}

#[napi]
pub fn http_parse_request_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, http_parse_request_packed_into_slice)
}