use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

pub fn catch_or<F, T>(fallback: T, f: F) -> T
where
    F: FnOnce() -> T,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(fallback)
}

pub fn input_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len) }
    }
}

pub fn output_bytes<'a>(ptr: *mut u8, cap: usize) -> &'a mut [u8] {
    if ptr.is_null() || cap == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(ptr, cap) }
    }
}

pub fn write_response(out: &mut [u8], data: &[u8]) -> i64 {
    if data.len() > out.len() {
        return -2;
    }

    out[..data.len()].copy_from_slice(data);
    data.len() as i64
}
