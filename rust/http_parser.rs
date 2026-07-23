use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use httparse::{Request as HttpRequest, EMPTY_HEADER, Status as HttpStatus};
use serde_json::{json, Map, Value};

#[no_mangle]
pub extern "C" fn rust_http_parse_request_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let mut headers = [EMPTY_HEADER; 100];
        let mut req = HttpRequest::new(&mut headers);

        match req.parse(input) {
            Ok(HttpStatus::Complete(_)) => {
                let mut header_map = Map::new();

                for header in req.headers.iter() {
                    let name = header.name.to_lowercase();
                    let value = String::from_utf8_lossy(header.value).into_owned();

                    match header_map.get_mut(&name) {
                        Some(Value::Array(arr)) => arr.push(Value::String(value)),
                        Some(existing) => {
                            let first = existing.clone();
                            *existing = Value::Array(vec![first, Value::String(value)]);
                        }
                        None => {
                            header_map.insert(name, Value::String(value));
                        }
                    }
                }

                let version = match req.version {
                    Some(1) => "HTTP/1.1",
                    Some(0) => "HTTP/1.0",
                    Some(2) => "HTTP/2.0",
                    _ => "",
                };

                let result = json!({
                    "method": req.method.unwrap_or(""),
                    "path": req.path.unwrap_or(""),
                    "version": version,
                    "headers": header_map,
                });

                let serialized = serde_json::to_vec(&result).unwrap_or_default();
                write_response(out, &serialized)
            }
            _ => -1,
        }
    })
}
