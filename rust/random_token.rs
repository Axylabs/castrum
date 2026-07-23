use crate::ffi::{catch_or, output_bytes, write_response};

#[no_mangle]
pub extern "C" fn rust_random_token_v2(byte_len: u32, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_or(-1, || {
        let out = output_bytes(out_ptr, out_cap);

        let mut token = vec![0u8; byte_len as usize];
        if getrandom::fill(&mut token).is_err() {
            return -1;
        }

        let hex = hex::encode(token);
        write_response(out, hex.as_bytes())
    })
}
