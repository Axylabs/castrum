// rust/ingress/packed.rs — Packed-input readers + builder.
//
// The ingress pipeline consumes a packed metadata frame (method byte +
// url/ip/rid/headers sections). This module owns the low-level section readers
// and the builder that assembles the full frame from raw request components
// (used by the `full_sync` family).

use napi::{Error, Result};

/// Read a u32le length prefix, advancing `pos` on success.
#[inline]
pub(crate) fn read_u32_at(input: &[u8], pos: &mut usize) -> Result<usize> {
    if *pos + 4 > input.len() {
        return Err(Error::from_reason("packed input: truncated u32"));
    }
    let v = u32::from_le_bytes([
        input[*pos], input[*pos + 1], input[*pos + 2], input[*pos + 3],
    ]) as usize;
    *pos += 4;
    Ok(v)
}

/// Read a length-prefixed section, enforcing `max` and bounds.
#[inline]
pub(crate) fn read_section<'a>(input: &'a [u8], pos: &mut usize, max: usize) -> Result<&'a [u8]> {
    let len = read_u32_at(input, pos)?;
    if len > max {
        return Err(Error::from_reason("packed input: section too large"));
    }
    let end = pos
        .checked_add(len)
        .ok_or_else(|| Error::from_reason("packed input: length overflow"))?;
    if end > input.len() {
        return Err(Error::from_reason("packed input: truncated section"));
    }
    let slice = &input[*pos..end];
    *pos = end;
    Ok(slice)
}

/// Build the full packed input buffer from raw components (sync version).
pub(crate) fn build_packed_input_sync(
    method_kind: u8,
    url_bytes: &[u8],
    ip_bytes: &[u8],
    rid_bytes: &[u8],
    headers: &[(String, String)],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);

    // Method kind (1 byte)
    buf.push(method_kind);

    // URL section: u32le length-prefixed
    buf.extend_from_slice(&(url_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(url_bytes);

    // IP section: u32le length-prefixed
    buf.extend_from_slice(&(ip_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(ip_bytes);

    // Request ID section: u32le length-prefixed
    buf.extend_from_slice(&(rid_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(rid_bytes);

    // Headers section: u32le length-prefixed
    let headers_len_pos = buf.len();
    buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder
    let headers_start = buf.len();

    // Write header count (u16le)
    buf.extend_from_slice(&(headers.len() as u16).to_le_bytes());

    for (name, value) in headers {
        let name_bytes = name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);
        let value_bytes = value.as_bytes();
        buf.extend_from_slice(&(value_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(value_bytes);
    }

    // Patch the header section length
    let headers_len = buf.len() - headers_start;
    buf[headers_len_pos..headers_len_pos + 4].copy_from_slice(&(headers_len as u32).to_le_bytes());

    buf
}
