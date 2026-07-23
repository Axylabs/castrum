use crate::ffi::{catch_or, input_bytes};
use serde::Deserialize;

#[derive(Deserialize)]
struct IdRow {
    id: i64,
}

#[no_mangle]
pub extern "C" fn rust_json_valid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<sonic_rs::Value>(input) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_json_sum_ids_v2(ptr: *const u8, len: usize) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<Vec<IdRow>>(input) {
            Ok(rows) => rows
                .into_iter()
                .fold(0i64, |acc, row| acc.saturating_add(row.id)),
            Err(_) => -1,
        }
    })
}
