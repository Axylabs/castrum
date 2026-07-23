use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};

#[no_mangle]
pub extern "C" fn rust_mime_from_extension_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let ext = String::from_utf8_lossy(input).to_lowercase();
        let ext = ext.trim_start_matches('.').to_string();

        let mime = mime_guess::from_ext(&ext).first_or_octet_stream();
        let result = mime.essence_str().to_string();

        write_response(out, result.as_bytes())
    })
}
