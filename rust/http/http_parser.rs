// rust/http/http_parser.rs
use crate::util::{write_bytes, write_u32_le};
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
///
/// Delegates to [`http_parse_request_packed_into_slice`] so the httparse→
/// packed-write logic lives in exactly one place (`_vec` and `_into_slice` can
/// never drift — see the `into_slice_and_vec_agree` parity test).
pub fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    // Metadata overhead bound: 16 bytes of section headers + 8 bytes per
    // header length prefix (max 64 headers) = 16 + 64 * 8 = 528.
    let mut out = vec![0u8; input.len().saturating_add(528)];
    let written = http_parse_request_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

#[napi]
pub fn http_parse_request_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_packed_vec(input.as_ref())?))
}

#[napi]
pub fn http_parse_request_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, http_parse_request_packed_into_slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode the packed request layout produced by
    /// [`http_parse_request_packed_into_slice`]:
    /// `[u32 method_len][method][u32 path_len][path][u32 version_len][version]
    /// [u32 header_count]{ [u32 name_len][name][u32 value_len][value] }`.
    #[allow(clippy::type_complexity)]
    fn decode_packed(packed: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<(Vec<u8>, Vec<u8>)>) {
        let mut pos = 0usize;
        fn take_len(p: &[u8], pos: &mut usize) -> usize {
            let n = u32::from_le_bytes([p[*pos], p[*pos + 1], p[*pos + 2], p[*pos + 3]]) as usize;
            *pos += 4;
            n
        }
        fn take<'a>(p: &'a [u8], pos: &mut usize, n: usize) -> &'a [u8] {
            let s = &p[*pos..*pos + n];
            *pos += n;
            s
        }
        let method = {
            let n = take_len(packed, &mut pos);
            take(packed, &mut pos, n).to_vec()
        };
        let path = {
            let n = take_len(packed, &mut pos);
            take(packed, &mut pos, n).to_vec()
        };
        let version = {
            let n = take_len(packed, &mut pos);
            take(packed, &mut pos, n).to_vec()
        };
        let count = take_len(packed, &mut pos);
        let mut headers = Vec::with_capacity(count);
        for _ in 0..count {
            let name = {
                let n = take_len(packed, &mut pos);
                take(packed, &mut pos, n).to_vec()
            };
            let value = {
                let n = take_len(packed, &mut pos);
                take(packed, &mut pos, n).to_vec()
            };
            headers.push((name, value));
        }
        (method, path, version, headers)
    }

    #[allow(clippy::type_complexity)]
    fn parse_once(
        input: &[u8],
    ) -> std::result::Result<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<(Vec<u8>, Vec<u8>)>), napi::Error>
    {
        let mut out = vec![0u8; 4096];
        let written = http_parse_request_packed_into_slice(input, &mut out)?;
        Ok(decode_packed(&out[..written]))
    }

    #[test]
    fn basic_get_parse_and_lowercase() {
        let (method, path, version, headers) = parse_once(
            b"GET /api/users?page=2 HTTP/1.1\r\nHost: Example.COM\r\nX-Custom-Header: v\r\n\r\n",
        )
        .unwrap();
        assert_eq!(method, b"GET");
        assert_eq!(path, b"/api/users?page=2");
        assert_eq!(version, b"HTTP/1.1");
        assert_eq!(
            headers,
            vec![
                (b"host".to_vec(), b"Example.COM".to_vec()),
                (b"x-custom-header".to_vec(), b"v".to_vec()),
            ]
        );
    }

    #[test]
    fn http10_maps_version() {
        let (_, _, version, _) = parse_once(b"GET / HTTP/1.0\r\n\r\n").unwrap();
        assert_eq!(version, b"HTTP/1.0");
    }

    #[test]
    fn incomplete_request_is_error() {
        // No terminating blank line → httparse returns Partial → error.
        assert!(parse_once(b"GET / HTTP/1.1\r\nHost: a").is_err());
        assert!(parse_once(b"").is_err());
    }

    #[test]
    fn too_many_headers_is_error() {
        // The parser's header array is sized 64; httparse refuses more.
        let mut req = String::from("GET / HTTP/1.1\r\n");
        for i in 0..80 {
            req.push_str(&format!("h{i}: v\r\n"));
        }
        req.push_str("\r\n");
        assert!(parse_once(req.as_bytes()).is_err());
    }

    #[test]
    fn header_value_whitespace_preserved() {
        let (_, _, _, headers) = parse_once(
            b"GET / HTTP/1.1\r\nAccept: text/html, application/json\r\nX-B: a   b\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            headers[0],
            (b"accept".to_vec(), b"text/html, application/json".to_vec())
        );
        assert_eq!(headers[1], (b"x-b".to_vec(), b"a   b".to_vec()));
    }

    #[test]
    fn absolute_form_target_preserved() {
        let (_, path, _, _) =
            parse_once(b"GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .unwrap();
        assert_eq!(path, b"http://example.com/path?q=1");
    }

    #[test]
    fn missing_method_is_error() {
        assert!(parse_once(b"HTTP/1.1\r\n\r\n").is_err());
    }

    #[test]
    fn null_byte_in_header_rejected() {
        assert!(parse_once(b"GET / HTTP/1.1\r\nX: a\x00b\r\n\r\n").is_err());
    }

    #[test]
    fn duplicate_headers_all_preserved() {
        let (_, _, _, headers) = parse_once(
            b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\nSet-Cookie: x=1\r\nSet-Cookie: y=2\r\n\r\n",
        )
        .unwrap();
        assert_eq!(headers[0], (b"host".to_vec(), b"a".to_vec()));
        assert_eq!(headers[1], (b"host".to_vec(), b"b".to_vec()));
        assert_eq!(headers[2], (b"set-cookie".to_vec(), b"x=1".to_vec()));
        assert_eq!(headers[3], (b"set-cookie".to_vec(), b"y=2".to_vec()));
    }

    #[test]
    fn content_length_and_transfer_encoding_pass_through() {
        // The parser is format-only: it must not interpret or drop either
        // header (semantic conflict resolution is a later pipeline concern).
        let (_, _, _, headers) = parse_once(
            b"POST / HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n",
        )
        .unwrap();
        assert_eq!(headers[0], (b"content-length".to_vec(), b"5".to_vec()));
        assert_eq!(
            headers[1],
            (b"transfer-encoding".to_vec(), b"chunked".to_vec())
        );
    }

    #[test]
    fn into_slice_and_vec_agree() {
        // Parity guard: the allocating and slice writers must emit identical
        // bytes (keeps the dedup refactor of `_vec` → `_into_slice` honest).
        let input = b"GET /a?b=c HTTP/1.1\r\nHost: x\r\nX-Mixed: V\r\n\r\n";
        let mut out = vec![0u8; 4096];
        let written = http_parse_request_packed_into_slice(input, &mut out).unwrap();
        let vec_out = http_parse_request_packed_vec(input).unwrap();
        assert_eq!(&out[..written], vec_out.as_slice());
    }
}
