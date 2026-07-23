use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use serde_json::Value;

#[no_mangle]
pub extern "C" fn rust_json_patch_v2(
    doc_ptr: *const u8,
    doc_len: usize,
    patch_ptr: *const u8,
    patch_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let doc_input = input_bytes(doc_ptr, doc_len);
        let patch_input = input_bytes(patch_ptr, patch_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut doc: Value = match serde_json::from_slice(doc_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let patch: json_patch::Patch = match serde_json::from_slice(patch_input) {
            Ok(p) => p,
            Err(_) => return -1,
        };

        if json_patch::patch(&mut doc, &patch).is_err() {
            return -1;
        }

        let result = serde_json::to_vec(&doc).unwrap_or_default();
        write_response(out, &result)
    })
}
