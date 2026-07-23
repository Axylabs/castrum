use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha1::{Digest as _, Sha1};

#[no_mangle]
pub extern "C" fn rust_ws_accept_key_v2(
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
        let combined = format!("{}{}", key, magic);

        let mut hasher = Sha1::new();
        hasher.update(combined.as_bytes());

        let hash = hasher.finalize();
        let encoded = BASE64.encode(hash);

        write_response(out, encoded.as_bytes())
    })
}
