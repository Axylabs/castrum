// rust/ingress/packed.rs — Packed-input readers + builder.
//
// The ingress pipeline consumes a packed metadata frame (method byte +
// url/ip/rid/headers sections). This module owns the low-level section readers
// and the builder that assembles the full frame from raw request components
// (used by the `full_sync` family).
//
// Pure core (no napi types): errors are plain `String` messages; the napi
// boundary maps them to terminal responses / JS errors.

/// Read a u32le length prefix, advancing `pos` on success.
#[inline]
pub(crate) fn read_u32_at(input: &[u8], pos: &mut usize) -> std::result::Result<usize, String> {
    if *pos + 4 > input.len() {
        return Err("packed input: truncated u32".to_string());
    }
    let v = u32::from_le_bytes([
        input[*pos],
        input[*pos + 1],
        input[*pos + 2],
        input[*pos + 3],
    ]) as usize;
    *pos += 4;
    Ok(v)
}

/// Read a length-prefixed section, enforcing `max` and bounds.
#[inline]
pub(crate) fn read_section<'a>(
    input: &'a [u8],
    pos: &mut usize,
    max: usize,
) -> std::result::Result<&'a [u8], String> {
    let len = read_u32_at(input, pos)?;
    if len > max {
        return Err("packed input: section too large".to_string());
    }
    let end = pos
        .checked_add(len)
        .ok_or_else(|| "packed input: length overflow".to_string())?;
    if end > input.len() {
        return Err("packed input: truncated section".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_packed_input_sync_round_trips() {
        let headers = vec![
            ("cookie".to_string(), "a=1".to_string()),
            ("x-forwarded-for".to_string(), "1.2.3.4".to_string()),
        ];
        let frame =
            build_packed_input_sync(3, b"/api/users?a=1", b"127.0.0.1", b"rid-123", &headers);

        // Method kind byte.
        assert_eq!(frame[0], 3);

        let mut pos = 1;

        // URL section.
        assert_eq!(
            read_section(&frame, &mut pos, 8192).unwrap(),
            b"/api/users?a=1"
        );
        // IP section.
        assert_eq!(read_section(&frame, &mut pos, 128).unwrap(), b"127.0.0.1");
        // Request-ID section.
        assert_eq!(read_section(&frame, &mut pos, 256).unwrap(), b"rid-123");

        // Headers section: u16 count, then {u16 name_len, name, u32 val_len, value}.
        let hdrs = read_section(&frame, &mut pos, 65536).unwrap();
        let mut hp = 0usize;
        let count = u16::from_le_bytes([hdrs[hp], hdrs[hp + 1]]);
        hp += 2;
        assert_eq!(count, 2);

        let mut pairs = Vec::new();
        for _ in 0..count {
            let name_len = u16::from_le_bytes([hdrs[hp], hdrs[hp + 1]]) as usize;
            hp += 2;
            let name = std::str::from_utf8(&hdrs[hp..hp + name_len]).unwrap();
            hp += name_len;
            let val_len = u32::from_le_bytes(hdrs[hp..hp + 4].try_into().unwrap()) as usize;
            hp += 4;
            let value = std::str::from_utf8(&hdrs[hp..hp + val_len]).unwrap();
            hp += val_len;
            pairs.push((name.to_string(), value.to_string()));
        }
        assert_eq!(pairs, headers);
        assert_eq!(hp, hdrs.len(), "headers section fully consumed");
        assert_eq!(pos, frame.len(), "whole frame fully consumed");
    }

    #[test]
    fn build_packed_input_sync_empty_headers() {
        let frame = build_packed_input_sync(1, b"/", b"", b"", &[]);
        let mut pos = 1;
        assert_eq!(read_section(&frame, &mut pos, 8192).unwrap(), b"/");
        assert_eq!(read_section(&frame, &mut pos, 128).unwrap(), b"");
        assert_eq!(read_section(&frame, &mut pos, 256).unwrap(), b"");
        let hdrs = read_section(&frame, &mut pos, 65536).unwrap();
        assert_eq!(hdrs.len(), 2, "empty headers section is just the u16 count");
        assert_eq!(u16::from_le_bytes([hdrs[0], hdrs[1]]), 0);
        assert_eq!(pos, frame.len());
    }

    #[test]
    fn read_u32_at_rejects_truncated() {
        let mut pos = 0;
        assert!(read_u32_at(&[0, 1, 2], &mut pos).is_err());
        assert_eq!(pos, 0, "pos must not advance on error");
    }

    #[test]
    fn read_section_enforces_max_and_bounds() {
        // Declared length exceeds the max.
        let input = [8u8, 0, 0, 0, 1, 2, 3, 4];
        let mut pos = 0;
        assert!(read_section(&input, &mut pos, 4).is_err());

        // Declared length exceeds the buffer (truncated).
        let input2 = [100u8, 0, 0, 0, 1, 2, 3, 4];
        let mut pos2 = 0;
        assert!(read_section(&input2, &mut pos2, 200).is_err());
    }

    #[test]
    fn read_section_rejects_length_overflow() {
        // Near-u32::MAX declared length: `pos + len` must not wrap and must be
        // rejected as truncated (not panic).
        let input = [0xff, 0xff, 0xff, 0x7f];
        let mut pos = 0;
        assert!(read_section(&input, &mut pos, usize::MAX).is_err());
    }
}
