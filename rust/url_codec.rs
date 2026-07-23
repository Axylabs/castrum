use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use percent_encoding::{percent_decode, utf8_percent_encode, AsciiSet, CONTROLS};

const ENCODE_URI_COMPONENT_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[no_mangle]
pub extern "C" fn rust_url_encode_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let encoded = utf8_percent_encode(&text, ENCODE_URI_COMPONENT_SET).to_string();

        write_response(out, encoded.as_bytes())
    })
}

#[no_mangle]
pub extern "C" fn rust_url_decode_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        match percent_decode(input).decode_utf8() {
            Ok(decoded) => write_response(out, decoded.as_bytes()),
            Err(_) => -1,
        }
    })
}
