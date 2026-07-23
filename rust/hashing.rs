use crate::ffi::{catch_or, input_bytes};
use crc32fast::Hasher as Crc32Hasher;
use fnv::FnvHasher;
use std::hash::Hasher as _;

#[no_mangle]
pub extern "C" fn rust_crc32_v2(ptr: *const u8, len: usize) -> u32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);

        let mut hasher = Crc32Hasher::new();
        hasher.update(input);
        hasher.finalize()
    })
}

#[no_mangle]
pub extern "C" fn rust_fnv1a64_v2(ptr: *const u8, len: usize) -> u64 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);

        let mut hasher = FnvHasher::default();
        hasher.write(input);
        hasher.finish()
    })
}
